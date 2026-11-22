import {
  getIntegrationConfig, upsertIntegrationConfig, deleteIntegrationConfig,
  getEventSync, upsertEventSync, deleteEventSync,
} from "./storage.js";

const API_BASE = "https://api.dida365.com/open/v1";
const OAUTH_BASE = "https://dida365.com/oauth";
const SCOPE = "tasks:write tasks:read";
const STATE_COOKIE = "eb_dida_oauth_state";
const text = value => typeof value === "string" ? value.trim() : "";
const encoder = new TextEncoder();
const refreshes = new WeakMap();
const syncQueues = new WeakMap();
function didaError(message, status = 502, upstreamStatus = null) {
  return Object.assign(new Error(message), { status, upstreamStatus, didaSafe: true });
}
function credentials(env) {
  const id = text(env.DIDA_CLIENT_ID), secret = text(env.DIDA_CLIENT_SECRET);
  const placeholder = /替换|占位|placeholder|replace.with|your[_ -]*(?:client|secret)|<[^>]+>/i;
  return id && secret && !placeholder.test(id) && !placeholder.test(secret) ? { id, secret } : null;
}
function requireCredentials(env) {
  const result = credentials(env);
  if (!result) throw didaError("请先配置 DIDA_CLIENT_ID 和 DIDA_CLIENT_SECRET", 503);
  return result;
}
export function didaPublicBaseUrl(request, env) {
  const base = text(env.PUBLIC_BASE_URL) || new URL(request.url).origin;
  let url;
  try { url = new URL(base); } catch { throw didaError("PUBLIC_BASE_URL 必须是有效的 HTTP(S) 地址", 500); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw didaError("PUBLIC_BASE_URL 必须是有效的纯 HTTP(S) 地址", 500);
  }
  return url.href.replace(/\/+$/, "");
}
function callbackUrl(request, env) {
  return didaPublicBaseUrl(request, env) + "/api/integrations/dida/callback";
}
function stateCookie(request, state, maxAge) {
  return `${STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}` +
    (new URL(request.url).protocol === "https:" ? "; Secure" : "");
}
function readStateCookie(request) {
  const parts = (request.headers.get("Cookie") || "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(STATE_COOKIE + "="));
  return parts.length === 1 ? parts[0].slice(STATE_COOKIE.length + 1) : "";
}
function safeDetail(value, env, config = {}, extraSecrets = []) {
  let result = String(value ?? "");
  const secrets = [env.DIDA_CLIENT_ID, env.DIDA_CLIENT_SECRET, env.AUTH_TOKEN, env.CAL_TOKEN,
    env.LLM_API_KEY, config.access_token, config.refresh_token, ...extraSecrets].filter(value => typeof value === "string" && value).flatMap(value => [value, value.trim()]).filter(Boolean);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      result = result.split(variant).join("[REDACTED]");
    }
  }
  return result.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[REDACTED]")
    .replace(/((?:access_token|refresh_token|client_id|client_secret|authorization|code)["']?\s*[:=]\s*)["']?[^\s,"'<>}&]+/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
}
async function responseJson(response, env, config, extraSecrets = []) {
  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try {
      const data = JSON.parse(raw);
      message = data?.error?.message || data?.error_description || data?.message || raw;
    } catch { /* 非 JSON 错误同样脱敏。 */ }
    const detail = safeDetail(message, env, config, extraSecrets);
    throw didaError(`滴答 API 请求失败（HTTP ${response.status}）${detail ? "：" + detail : ""}`, 502, response.status);
  }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); }
  catch { throw didaError("滴答 API 返回了无效的 JSON"); }
}
async function remoteJson(url, options, env, config = {}, extraSecrets = []) {
  try {
    const response = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(15000) });
    return await responseJson(response, env, config, extraSecrets);
  } catch (error) {
    if (error?.didaSafe) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw didaError("滴答 API 请求超时（15 秒）");
    throw didaError("滴答 API 网络连接失败，请稍后重试");
  }
}
async function tokenRequest(env, params, config = {}) {
  const { id, secret } = requireCredentials(env);
  return remoteJson(OAUTH_BASE + "/token", {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${id}:${secret}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  }, env, config, [params.code, params.refresh_token, btoa(`${id}:${secret}`)]);
}
function expiry(data) {
  const seconds = Number(data.expires_in);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function validToken(data) {
  if (!text(data?.access_token)) throw didaError("滴答授权响应缺少 access_token，请重新连接");
}
async function refreshAccessToken(env, oldConfig) {
  if (!oldConfig?.refresh_token) throw didaError("滴答授权已失效，请重新连接", 409);
  if (!refreshes.has(env.DB)) {
    const pending = (async () => {
      // 并发请求若已完成刷新，直接复用 D1 中的新 Token。
      const current = await getIntegrationConfig(env.DB);
      if (!current?.access_token) throw didaError("滴答授权已失效，请重新连接", 409);
      if (current.access_token !== oldConfig.access_token) return current;
      let data;
      try { data = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: current.refresh_token }, current); }
      catch { throw didaError("滴答授权已失效，请重新连接", 409); }
      validToken(data);
      // 断开连接发生在网络请求期间时，不能把授权重新写回。
      const latest = await getIntegrationConfig(env.DB);
      if (!latest || latest.access_token !== current.access_token) {
        if (latest?.access_token) return latest;
        throw didaError("滴答授权已失效，请重新连接", 409);
      }
      return upsertIntegrationConfig(env.DB, { access_token: data.access_token,
        refresh_token: text(data.refresh_token) || current.refresh_token, expires_at: expiry(data) });
    })();
    refreshes.set(env.DB, pending);
  }
  const pending = refreshes.get(env.DB);
  try { return await pending; }
  finally { if (refreshes.get(env.DB) === pending) refreshes.delete(env.DB); }
}
async function apiRequest(env, path, method = "GET", payload, initialConfig = null) {
  let config = initialConfig || await getIntegrationConfig(env.DB);
  if (!config?.access_token) throw didaError("尚未连接滴答清单，请先完成授权", 409);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await remoteJson(API_BASE + path, { method,
        headers: { Authorization: "Bearer " + config.access_token, ...(payload ? { "Content-Type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }, env, config);
    } catch (error) {
      if (error.upstreamStatus !== 401) throw error;
      if (attempt || !config.refresh_token) throw didaError("滴答授权已失效，请重新连接", 409);
      config = await refreshAccessToken(env, config);
    }
  }
}
export async function getDidaStatus(env) {
  const config = await getIntegrationConfig(env.DB);
  return { ok: true, configured: Boolean(credentials(env)), connected: Boolean(config?.access_token),
    target_project_id: config?.target_project_id ?? null, target_project_name: config?.target_project_name ?? null,
    expires_at: config?.expires_at ?? null, updated_at: config?.updated_at ?? null };
}
export function authorizeDida(request, env) {
  const { id } = requireCredentials(env);
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const url = new URL(OAUTH_BASE + "/authorize");
  url.search = new URLSearchParams({ client_id: id, scope: SCOPE, state,
    redirect_uri: callbackUrl(request, env), response_type: "code" }).toString();
  return { authorize_url: url.href, cookie: stateCookie(request, state, 600) };
}
export async function handleDidaCallback(request, env, onFailure = () => {}) {
  let reason = "callback_failed";
  const params = new URL(request.url).searchParams;
  const callbackSecrets = [params.get("code")];
  try {
    const state = params.get("state"), storedState = readStateCookie(request);
    if (!state || !/^[a-f0-9]{64}$/.test(state) || state !== storedState) {
      reason = "invalid_state";
      throw didaError("滴答授权状态校验失败，请重新连接", 400);
    }
    if (params.has("error") || !text(params.get("code"))) {
      reason = "authorization_denied";
      throw didaError("滴答授权未完成或缺少授权码", 400);
    }
    reason = "token_exchange_failed";
    const data = await tokenRequest(env, { code: params.get("code"), grant_type: "authorization_code",
      scope: SCOPE, redirect_uri: callbackUrl(request, env) });
    reason = "token_response_invalid";
    validToken(data);
    callbackSecrets.push(data.access_token, data.refresh_token);
    reason = "integration_save_failed";
    await upsertIntegrationConfig(env.DB, { access_token: data.access_token,
      refresh_token: text(data.refresh_token) || null, expires_at: expiry(data) });
    return new Response(null, { status: 302, headers: { Location: "/?dida=connected", "Set-Cookie": stateCookie(request, "", 0), "Cache-Control": "no-store" } });
  } catch (error) {
    const status = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus :
      Number.isInteger(error?.status) ? error.status : 500;
    // 只交给路由层已清洗的摘要，绝不传递请求 URL、Cookie、授权码或 Token。
    onFailure({ reason, status, detail: safeDetail(error?.message || "滴答回调处理失败", env, {}, callbackSecrets) });
    return new Response(null, { status: 302, headers: { Location: "/?dida=error&reason=" + reason,
      "Set-Cookie": stateCookie(request, "", 0), "Cache-Control": "no-store" } });
  }
}
export async function getDidaProjects(env) {
  const projects = await apiRequest(env, "/project");
  if (!Array.isArray(projects)) throw didaError("滴答清单列表响应格式无效");
  return projects.filter(project => project && project.closed !== true && text(project.id))
    .map(project => ({ id: project.id, name: text(project.name), color: project.color ?? null }));
}
export async function saveDidaConfig(env, data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some(key => !["target_project_id", "target_project_name"].includes(key)) ||
      !Object.hasOwn(data, "target_project_id") ||
      (data.target_project_id != null && typeof data.target_project_id !== "string") ||
      (data.target_project_name != null && typeof data.target_project_name !== "string")) {
    throw didaError("清单配置必须包含字符串或 null 类型的 target_project_id，可选 target_project_name", 400);
  }
  await upsertIntegrationConfig(env.DB, { target_project_id: text(data.target_project_id) || null,
    target_project_name: text(data.target_project_id) ? text(data.target_project_name) || null : null });
}
export async function disconnectDida(env) {
  await deleteIntegrationConfig(env.DB);
}
export function didaSyncSummary(record) {
  return record ? { status: record.sync_status, external_task_id: record.external_task_id ?? null,
    external_project_id: record.external_project_id ?? null, synced_at: record.synced_at ?? null,
    last_error: record.last_error ?? null } : null;
}
function time(value) {
  const ms = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function didaTime(ms) {
  const iso = new Date(ms + 8 * 3600000).toISOString();
  if (!/^\d{4}-/.test(iso)) throw didaError("活动日期超出滴答支持范围", 400);
  return iso.slice(0, 19) + "+0800";
}
export function buildDidaPayload(event, request, env, targetProjectId) {
  // view 已由 buildEventPresentation 合并人工锁；不读取未合并的 compiled_data。
  const core = event?.view?.l1_core;
  const start = time(core?.start_time);
  if (start === null) return null;
  const end = time(core.end_time), placeholderEnd = end === null || end <= start;
  const name = text(core.location_name), address = text(core.location_address);
  const location = address.includes(name) ? address : [name, address].filter(Boolean).join(" ");
  const content = [`详情与签到码：${didaPublicBaseUrl(request, env)}/?event=${encodeURIComponent(event.id)}`];
  if (location) content.push("地点：" + location);
  const rules = Array.isArray(core.must_know) ? core.must_know.filter(value => text(value)).slice(0, 5) : [];
  if (rules.length) content.push(...rules.map(value => "• " + text(value)));
  if (placeholderEnd) content.push("结束时间待定，暂按 2 小时占位");
  return { ...(text(targetProjectId) ? { projectId: text(targetProjectId) } : {}),
    title: text(core.title) || "未命名活动", startDate: didaTime(start),
    dueDate: didaTime(placeholderEnd ? start + 2 * 3600000 : end), timeZone: "Asia/Shanghai", isAllDay: false,
    reminders: ["TRIGGER:-P1D", "TRIGGER:-PT1H"], content: content.join("\n") };
}
async function payloadHash(payload) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({
    projectId: payload.projectId ?? null, title: payload.title, startDate: payload.startDate,
    dueDate: payload.dueDate, reminders: payload.reminders, content: payload.content,
  })));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function deleteRemoteTask(env, record, config) {
  if (!record?.external_task_id) return;
  if (!text(record.external_project_id)) throw didaError("缺少滴答任务所属清单，无法撤回旧任务");
  try {
    await apiRequest(env, `/project/${encodeURIComponent(record.external_project_id)}/task/${encodeURIComponent(record.external_task_id)}`, "DELETE", undefined, config);
  } catch (error) { if (error.upstreamStatus !== 404) throw error; }
}
export async function syncEventToDida(env, event, request, options = {}) {
  // 同一 Worker 内串行处理同一活动，避免并发编译重复创建任务。
  if (!syncQueues.has(env.DB)) syncQueues.set(env.DB, new Map());
  const queue = syncQueues.get(env.DB), previous = queue.get(event.id) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => performDidaSync(env, event, request, options));
  queue.set(event.id, pending);
  try { return await pending; }
  finally { if (queue.get(event.id) === pending) queue.delete(event.id); }
}
async function performDidaSync(env, event, request, { force = false } = {}) {
  let existing = null, config = null;
  try {
    config = await getIntegrationConfig(env.DB);
    if (!config?.access_token && !force) return null;
    existing = await getEventSync(env.DB, event.id);
    if (!config?.access_token) {
      return didaSyncSummary(await upsertEventSync(env.DB, { event_id: event.id, sync_status: "disabled", last_error: "尚未连接滴答清单" }));
    }
    const payload = buildDidaPayload(event, request, env, config.target_project_id);
    if (!payload) {
      return didaSyncSummary(await upsertEventSync(env.DB, { event_id: event.id, sync_status: "skipped_no_time", last_error: null }));
    }
    const hash = await payloadHash(payload);
    const sameHash = existing?.payload_hash === hash;
    const sameTarget = payload.projectId ? existing?.external_project_id === payload.projectId : sameHash;
    if (!force && existing?.sync_status === "synced" && existing.external_task_id && sameHash && sameTarget) return didaSyncSummary(existing);
    let task, create = true;
    if (existing?.external_task_id) {
      // 收件箱配置为空，但实际 ID 由上游分配；载荷变化时重建以确保不会滞留先前清单。
      if (!sameTarget) {
        await deleteRemoteTask(env, existing, config);
        await upsertEventSync(env.DB, { event_id: event.id, sync_status: "disabled", external_task_id: null,
          external_project_id: null, payload_hash: null, last_error: null });
      } else {
        try {
          task = await apiRequest(env, "/task/" + encodeURIComponent(existing.external_task_id), "POST", {
            ...payload, id: existing.external_task_id, projectId: existing.external_project_id,
          }, config);
          create = false;
        } catch (error) {
          if (error.upstreamStatus !== 404) throw error;
        }
      }
    }
    if (create) task = await apiRequest(env, "/task", "POST", payload, config);
    if (!text(task?.id) || !text(task?.projectId)) throw didaError("滴答任务响应缺少 id 或 projectId，无法确认同步结果");
    return didaSyncSummary(await upsertEventSync(env.DB, { event_id: event.id, external_task_id: task.id,
      external_project_id: task.projectId, payload_hash: hash, sync_status: "synced", last_error: null, synced_at: new Date().toISOString() }));
  } catch (error) {
    const message = error?.didaSafe ? safeDetail(error.message, env, config || {}) : "滴答同步失败，请稍后重试";
    try {
      return didaSyncSummary(await upsertEventSync(env.DB, { event_id: event.id, sync_status: "failed", last_error: message }));
    } catch {
      return didaSyncSummary({ ...existing, sync_status: "failed", last_error: message });
    }
  }
}
export async function deleteDidaEventTask(env, eventId) {
  try {
    const record = await getEventSync(env.DB, eventId);
    const config = await getIntegrationConfig(env.DB);
    if (record?.external_task_id && config?.access_token) await deleteRemoteTask(env, record, config);
  } finally {
    await deleteEventSync(env.DB, eventId);
  }
}
