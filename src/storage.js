function storageError(message, status) {
  return Object.assign(new Error(message), { status });
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

export const OVERRIDE_FIELD_LABELS = Object.freeze({
  "l1_core.title": "活动标题", "l1_core.time_display": "时间展示",
  "l1_core.start_time": "开始时间", "l1_core.end_time": "结束时间",
  "l1_core.location_name": "地点名称", "l1_core.location_address": "详细地址",
  "l1_core.must_know": "硬性红线提示", "l2_modules.personal_focus": "个人关注目标",
  "l2_modules.links_and_contacts": "入口与联络",
});
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copyValue = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));
const fieldValue = (data, path) => data?.[path.split(".")[0]]?.[path.split(".")[1]] ?? null;
function checkField(path) {
  if (!Object.hasOwn(OVERRIDE_FIELD_LABELS, path)) throw storageError("不支持微调该字段", 400);
}
function validIso(value) {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [y, month, day, h, minute, second] = m.slice(1).map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && h < 24 && minute < 60 && (!second || second < 60);
}
function cleanContacts(value, strict = false) {
  if (!Array.isArray(value)) {
    if (strict) throw storageError("入口与联络必须是对象数组", 400);
    return [];
  }
  const result = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.label != null && typeof entry.label !== "string") ||
        (entry.value != null && typeof entry.value !== "string")) {
      if (strict) throw storageError("联络条目必须包含字符串名称和内容", 400);
      continue;
    }
    const content = (entry.value || "").trim();
    if (!content) continue;
    let type = entry.type || "text";
    if (/^https?:\/\//i.test(content)) {
      try { const url = new URL(content); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
      catch { if (strict) throw storageError("链接地址无效", 400); continue; }
      type = "url";
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(content) && !/^(?:tel|mailto):/i.test(content)) {
      if (strict) throw storageError("链接仅允许 http:// 或 https:// 协议", 400);
      continue;
    } else if (!["url", "contact", "text"].includes(type)) {
      if (strict) throw storageError("联络类型必须是 url、contact 或 text", 400);
      type = "text";
    } else if (type === "url") {
      if (strict) throw storageError("链接仅允许 http:// 或 https:// 协议", 400);
      type = "text";
    }
    result.push({ label: (entry.label || "").trim() || "参考信息", value: content, type });
  }
  return result;
}
function normalizeOverrideValue(path, value) {
  checkField(path);
  if (path === "l2_modules.links_and_contacts") return cleanContacts(value, true);
  if (["l1_core.must_know", "l2_modules.personal_focus"].includes(path)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw storageError("清单必须是字符串数组", 400);
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (value === null && path !== "l1_core.title") return null;
  if (typeof value !== "string") throw storageError(OVERRIDE_FIELD_LABELS[path] + "必须是字符串或 null", 400);
  value = value.trim();
  if (path === "l1_core.title" && !value) throw storageError("活动标题不可为空", 400);
  if (["l1_core.start_time", "l1_core.end_time"].includes(path) && !validIso(value)) {
    throw storageError("时间必须是带时区的合法 ISO 8601 时间或 null", 400);
  }
  return value;
}
export function normalizeOverrides(raw) {
  const parsed = typeof raw === "string" ? safeJsonParse(raw, {}) : raw;
  const result = { version: 1, fields: {} };
  if (!isRecord(parsed?.fields)) return result;
  for (const [path, entry] of Object.entries(parsed.fields)) {
    if (!Object.hasOwn(OVERRIDE_FIELD_LABELS, path) || !isRecord(entry)) continue;
    try {
      result.fields[path] = {
        value: normalizeOverrideValue(path, entry.value),
        base_compiled_value: copyValue(entry.base_compiled_value),
        dismissed_ai_value: copyValue(entry.dismissed_ai_value),
        updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
      };
    } catch { /* 损坏的旧锁记录不参与合并。 */ }
  }
  return result;
}
function comparableValue(path, value) {
  if (path === "l2_modules.links_and_contacts") return cleanContacts(value);
  if (["l1_core.must_know", "l2_modules.personal_focus"].includes(path)) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
  }
  return typeof value === "string" ? value.trim() || null : value ?? null;
}
export function areFieldValuesEqual(path, a, b) {
  return JSON.stringify(comparableValue(path, a)) === JSON.stringify(comparableValue(path, b));
}
export function isFieldValueEmpty(path, value) {
  const normalized = comparableValue(path, value);
  return normalized === null || normalized === "" || (Array.isArray(normalized) && normalized.length === 0);
}
export function buildEventPresentation(compiledData, overrides) {
  if (!isRecord(compiledData)) return { view: null, locked_fields: [], pending_conflicts: [] };
  const view = copyValue(compiledData), normalized = normalizeOverrides(overrides), conflicts = [];
  for (const [path, entry] of Object.entries(normalized.fields)) {
    const [section, key] = path.split(".");
    if (!isRecord(view[section])) view[section] = {};
    view[section][key] = copyValue(entry.value);
    const ai = fieldValue(compiledData, path);
    if (!isFieldValueEmpty(path, ai) && !areFieldValuesEqual(path, ai, entry.value) &&
        !areFieldValuesEqual(path, ai, entry.base_compiled_value) &&
        (entry.dismissed_ai_value == null || !areFieldValuesEqual(path, ai, entry.dismissed_ai_value))) {
      conflicts.push({ field: path, label: OVERRIDE_FIELD_LABELS[path], current_value: copyValue(entry.value), ai_value: copyValue(ai) });
    }
  }
  return { view, locked_fields: Object.keys(normalized.fields), pending_conflicts: conflicts };
}
export async function updateEventOverrides(env, eventId, payload) {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();
  if (!row) throw storageError("活动不存在", 404);
  const compiled = safeJsonParse(row.compiled_json, null);
  if (!isRecord(compiled)) throw storageError("请先完成至少一次 AI 整理后再微调字段", 400);
  if (!isRecord(payload) || Object.keys(payload).some((key) => !["set", "unlock", "dismiss_conflicts"].includes(key))) {
    throw storageError("覆写请求格式无效", 400);
  }
  const overrides = normalizeOverrides(row.overrides_json), now = new Date().toISOString();
  let actions = 0;
  if (Object.hasOwn(payload, "set")) {
    if (!isRecord(payload.set)) throw storageError("set 必须是字段对象", 400);
    for (const [path, value] of Object.entries(payload.set)) {
      checkField(path); actions++;
      overrides.fields[path] = { value: normalizeOverrideValue(path, value),
        base_compiled_value: copyValue(fieldValue(compiled, path)), dismissed_ai_value: null, updated_at: now };
    }
  }
  for (const action of ["unlock", "dismiss_conflicts"]) {
    if (!Object.hasOwn(payload, action)) continue;
    if (!Array.isArray(payload[action]) || payload[action].some((v) => typeof v !== "string")) throw storageError(action + " 必须是字段路径数组", 400);
    for (const path of payload[action]) {
      checkField(path); actions++;
      if (action === "unlock") delete overrides.fields[path];
      else if (Object.hasOwn(overrides.fields, path)) {
        overrides.fields[path].dismissed_ai_value = copyValue(fieldValue(compiled, path));
        overrides.fields[path].updated_at = now;
      }
    }
  }
  if (!actions) throw storageError("请至少提供一个待修改或处理的字段", 400);
  await env.DB.prepare("UPDATE events SET overrides_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(overrides), now, eventId).run();
  return getEventDetail(env, eventId);
}

function parseEventTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function computeEventTimeline(row, compiledData, nowMs = Date.now()) {
  const startMs = parseEventTime(compiledData?.l1_core?.start_time);
  let effectiveEndMs = parseEventTime(compiledData?.l1_core?.end_time);
  if (effectiveEndMs === null && startMs !== null) {
    const dayMs = 24 * 60 * 60 * 1000, offsetMs = 8 * 60 * 60 * 1000;
    effectiveEndMs = (Math.floor((startMs + offsetMs) / dayMs) + 1) * dayMs - offsetMs - 1;
  }
  // 统一显示为东八区 ISO；极端的非法日期不能让列表读取崩溃。
  const endDate = effectiveEndMs === null ? null : new Date(effectiveEndMs + 8 * 60 * 60 * 1000);
  const effectiveEndTime = endDate && Number.isFinite(endDate.getTime())
    ? endDate.toISOString().replace("Z", "+08:00") : null;
  if (effectiveEndTime === null) effectiveEndMs = null;
  let timelineBucket = "upcoming", timeState;
  if (row.status === "archived") {
    timelineBucket = "archived"; timeState = "archived";
  } else if (effectiveEndMs !== null && nowMs > effectiveEndMs) {
    timelineBucket = "archived"; timeState = "ended";
  } else if (startMs !== null) {
    timeState = nowMs >= startMs ? "ongoing" : "upcoming";
  } else {
    timeState = compiledData !== null && compiledData !== undefined ? "tbd" : "draft";
  }
  return { timeline_bucket: timelineBucket, time_state: timeState, effective_end_time: effectiveEndTime };
}

function compareTimelineEvents(left, right) {
  if (left.timeline_bucket !== right.timeline_bucket) return left.timeline_bucket === "upcoming" ? -1 : 1;
  if (left.timeline_bucket === "upcoming") {
    const a = parseEventTime((left.view || left.compiled_data)?.l1_core?.start_time);
    const b = parseEventTime((right.view || right.compiled_data)?.l1_core?.start_time);
    if (a !== null && b === null) return -1;
    if (a === null && b !== null) return 1;
    if (a !== null && b !== null && a !== b) return a - b;
  } else {
    const a = parseEventTime(left.effective_end_time) ?? parseEventTime(left.updated_at) ?? -Infinity;
    const b = parseEventTime(right.effective_end_time) ?? parseEventTime(right.updated_at) ?? -Infinity;
    if (a !== b) return a > b ? -1 : 1;
  }
  const a = parseEventTime(left.updated_at) ?? -Infinity, b = parseEventTime(right.updated_at) ?? -Infinity;
  if (a !== b) return a > b ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function eventData(row, nowMs = Date.now()) {
  const compiledData = safeJsonParse(row.compiled_json, null);
  const overrides = normalizeOverrides(row.overrides_json);
  const presentation = buildEventPresentation(compiledData, overrides);
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    compiled_data: compiledData,
    ...presentation,
    pending_conflict_count: presentation.pending_conflicts.length,
    ...computeEventTimeline(row, presentation.view || compiledData, nowMs),
    user_overrides: overrides,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rawItemData(item) {
  return item.image_key
    ? { ...item, image_url: "/api/images/" + item.image_key }
    : item;
}

async function requireEvent(env, eventId) {
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?")
    .bind(eventId).first();
  if (!event) throw storageError("活动不存在", 404);
}

function versionUpdate(env, eventId, timestamp) {
  return env.DB.prepare(
    "UPDATE events SET version = version + 1, updated_at = ? WHERE id = ?"
  ).bind(timestamp, eventId);
}

function insertItem(env, item) {
  return env.DB.prepare(
    "INSERT INTO raw_items (id, event_id, type, content, image_key, image_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    item.id, item.event_id, item.type, item.content,
    item.image_key, item.image_summary, item.created_at
  );
}

export async function listEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM raw_items r WHERE r.event_id = e.id) AS raw_count
     FROM events e ORDER BY e.updated_at DESC`
  ).all();
  const nowMs = Date.now();
  return results.map((row) => ({ ...eventData(row, nowMs), raw_count: row.raw_count }))
    .sort(compareTimelineEvents);
}

export async function createEvent(env) {
  const timestamp = new Date().toISOString();
  const event = {
    id: crypto.randomUUID(),
    status: "draft",
    compiled_json: null,
    overrides_json: "{}",
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await env.DB.prepare(
    "INSERT INTO events (id, status, compiled_json, overrides_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    event.id, event.status, event.compiled_json, event.overrides_json,
    event.version, event.created_at, event.updated_at
  ).run();
  return { ...eventData(event), raw_items: [] };
}

export async function getEventDetail(env, eventId) {
  const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?")
    .bind(eventId).first();
  if (!event) return null;
  const { results } = await env.DB.prepare(
    "SELECT * FROM raw_items WHERE event_id = ? ORDER BY created_at ASC, rowid ASC"
  ).bind(eventId).all();
  return { ...eventData(event), raw_items: results.map(rawItemData) };
}

export async function deleteEvent(env, eventId) {
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?")
    .bind(eventId).first();
  if (!event) return false;
  const { results } = await env.DB.prepare(
    "SELECT image_key FROM raw_items WHERE event_id = ? AND image_key IS NOT NULL AND image_key != ''"
  ).bind(eventId).all();
  for (const item of results) await env.BUCKET.delete(item.image_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM raw_items WHERE event_id = ?").bind(eventId),
    env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
  ]);
  return true;
}

export async function addTextOrUrlItem(env, eventId, { type, content }) {
  await requireEvent(env, eventId);
  if (typeof content !== "string" || !content.trim()) {
    throw storageError("素材内容必须是非空字符串", 400);
  }
  content = content.trim();
  if (type === undefined) {
    type = /^https?:\/\//.test(content) && !/[\r\n]/.test(content) ? "url" : "text";
  }
  if (type !== "text" && type !== "url") {
    throw storageError("素材类型仅支持 text 或 url", 400);
  }
  const item = {
    id: crypto.randomUUID(),
    event_id: eventId,
    type,
    content,
    image_key: null,
    image_summary: null,
    created_at: new Date().toISOString(),
  };
  await env.DB.batch([
    insertItem(env, item),
    versionUpdate(env, eventId, item.created_at),
  ]);
  return item;
}

export async function addImageItem(env, eventId, file, caption = "") {
  await requireEvent(env, eventId);
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  if (!file || typeof file.arrayBuffer !== "function" ||
      typeof file.name !== "string" || !Number.isFinite(file.size) || file.size < 0) {
    throw storageError("请提供有效的图片文件", 400);
  }
  if (!Object.hasOwn(extensions, file.type)) {
    throw storageError("图片类型仅支持 PNG、JPEG、JPG、WebP 或 GIF", 400);
  }
  if (file.size > 10 * 1024 * 1024) {
    throw storageError("图片大小不能超过 10 MB", 400);
  }
  if (typeof caption !== "string") {
    throw storageError("图片说明必须是字符串", 400);
  }
  const itemId = crypto.randomUUID();
  const imageKey = "events/" + eventId + "/" + itemId + "." + extensions[file.type];
  const item = {
    id: itemId,
    event_id: eventId,
    type: "image",
    content: caption || file.name || null,
    image_key: imageKey,
    image_summary: null,
    created_at: new Date().toISOString(),
  };
  await env.BUCKET.put(imageKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  try {
    await env.DB.batch([
      insertItem(env, item),
      versionUpdate(env, eventId, item.created_at),
    ]);
  } catch (err) {
    // 保留数据库异常；清理失败也不能使原始异常丢失。
    try {
      await env.BUCKET.delete(imageKey);
    } catch (cleanupError) {
      console.error("图片上传回滚清理失败", cleanupError);
    }
    throw err;
  }
  return rawItemData(item);
}

export async function deleteRawItem(env, eventId, itemId) {
  const item = await env.DB.prepare(
    "SELECT * FROM raw_items WHERE id = ? AND event_id = ?"
  ).bind(itemId, eventId).first();
  if (!item) return false;
  if (item.image_key) await env.BUCKET.delete(item.image_key);
  const timestamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM raw_items WHERE id = ? AND event_id = ?")
      .bind(itemId, eventId),
    versionUpdate(env, eventId, timestamp),
  ]);
  return true;
}

export async function getImageObject(env, imageKey) {
  if (typeof imageKey !== "string" || !imageKey.startsWith("events/") ||
      imageKey.includes("..") || imageKey.includes("\\")) {
    return null;
  }
  return env.BUCKET.get(imageKey);
}



export async function updateRawItemSummary(env, itemId, summaryText) {
  await env.DB.prepare("UPDATE raw_items SET image_summary = ? WHERE id = ?")
    .bind(summaryText, itemId).run();
}

export async function saveCompiledEvent(env, eventId, compiledData) {
  await env.DB.prepare(
    "UPDATE events SET compiled_json = ?, status = 'compiled', version = version + 1, updated_at = ? WHERE id = ?"
  ).bind(JSON.stringify(compiledData), new Date().toISOString(), eventId).run();
  return getEventDetail(env, eventId);
}