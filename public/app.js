"use strict";

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "offline-bar", "offline-text", "refresh-cache",
  "toast", "toast-message", "toast-close", "new-event", "event-list", "welcome",
  "detail", "back-list", "compile-meta", "delete-event", "detail-loading",
  "composer", "material-text", "choose-images", "image-files", "image-queue",
  "save-compile", "save-only", "workflow-status", "cards", "archive",
  "lightbox", "lightbox-close", "lightbox-space", "lightbox-image",
  "auth-gate", "auth-form", "auth-token", "auth-message", "login-submit", "workspace",
  "lock-logout", "upcoming-tab", "archived-tab", "archive-search-area", "archive-search",
  "calendar-dialog", "calendar-content", "calendar-url", "calendar-message", "calendar-copy", "calendar-close", "calendar-subscribe",
  "field-editor", "editor-form", "editor-title", "editor-fields", "editor-help", "editor-error", "editor-save", "editor-cancel",
].map((id) => [id, $(id)]));
const narrow = window.matchMedia("(max-width: 768px)");
const state = {
  isOffline: false, cacheSupported: false, offlineEpoch: 0, offlineMeta: null,
  offlineStatus: "unsupported", swRegistration: null, syncPromise: null, clearPromise: Promise.resolve(),
  events: [], selected: null, event: null, drafts: new Map(),
  authenticated: false, authConfigured: null, authBusy: false, authGeneration: 0,
  activeTab: "upcoming", archiveQuery: "",
  busy: false, preparing: 0, loading: false, sequence: 0, listSequence: 0, toastTimer: null,
};
const fieldNames = {
  title: "标题", location: "地点", location_name: "地点", location_address: "详细地址",
  start_time: "时间", end_time: "时间", time: "时间", date: "日期",
  credential_requirement: "入场要求", must_know: "入场要求",
};
const roleNames = { credential: "凭证", map: "地图", schedule: "议程", poster: "海报", chat: "聊天截图", other: "其他" };
const list = (value) => Array.isArray(value) ? value : [];
const words = (value, fallback = "") => typeof value === "string" ? value : fallback;
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const locked = () => !state.authenticated || state.busy || state.preparing > 0;
const writeLocked = () => locked() || state.isOffline;
function el(tag, className = "", content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}
function button(label, className, action) {
  const node = el("button", "button " + className, label);
  node.type = "button";
  node.addEventListener("click", () => run(action));
  return node;
}
function run(action) {
  Promise.resolve().then(action).catch((error) => {
    if (error.status !== 401) toast(error.message || "操作失败，请重试", "error");
  });
}
function toast(message, kind = "success") {
  clearTimeout(state.toastTimer);
  ui.toast.dataset.kind = kind;
  ui["toast-message"].textContent = message;
  ui.toast.hidden = false;
  state.toastTimer = setTimeout(() => { ui.toast.hidden = true; }, kind === "error" ? 10000 : 6000);
}
function status(message = "", error = false) {
  ui["workflow-status"].textContent = message;
  ui["workflow-status"].classList.toggle("error", error);
}
const PRIVATE_CACHE = "eb-private-v1";
const OFFLINE_META_KEY = "eb_offline_meta_v1";
const LOCAL_CHECKS_KEY = "eb_local_checks_v1";
const PENDING_LOGOUT_KEY = "eb_offline_logout_pending_v1";
function readLocal(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function privateReadPath(path) {
  const url = new URL(path, location.origin);
  return url.origin === location.origin && (url.pathname === "/api/events" ||
    /^\/api\/events\/[^/]+$/.test(url.pathname) || url.pathname.startsWith("/api/images/"));
}
function offlineFailure() {
  return Object.assign(new Error("当前离线且本机暂无该项缓存"), { offline: true, status: 503 });
}
async function timedFetch(path, options = {}, ms = 2500) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(path, { ...options, signal: controller.signal }),
      new Promise((resolve, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(Object.assign(new Error("网络超时，已切换本地缓存"), { offline: true }));
      }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function swMessage(type, wait = false) {
  const worker = navigator.serviceWorker?.controller || state.swRegistration?.active;
  if (!worker) return;
  if (!wait || typeof MessageChannel === "undefined") { worker.postMessage({ type }); return; }
  await new Promise(resolve => {
    const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); resolve(); }, 1200);
    channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
    worker.postMessage({ type }, [channel.port2]);
  });
}
function syncTime(meta = state.offlineMeta) {
  const ms = timestamp(meta?.lastSyncAt);
  return ms === null ? "尚未同步" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}
function paintOfflineStatus(mode = state.offlineStatus, message = "") {
  state.offlineStatus = mode;
  ui["offline-bar"].dataset.state = mode;
  const meta = state.offlineMeta;
  ui["offline-text"].textContent = message || (mode === "ready"
    ? "已离线就绪 · 同步于 " + syncTime() + " · 已缓存 " + meta.upcomingCount + " 场即将发生 / " + meta.imageCount + " 张关键图"
    : mode === "syncing" ? "正在同步离线缓存..."
    : mode === "offline" ? "当前离线模式 · 正在查看本地缓存副本（同步于 " + syncTime() + "）"
    : mode === "unsupported" ? "当前环境不支持离线缓存，请使用 HTTPS 或本机 localhost / 127.0.0.1"
    : "离线同步未完成，请联网后刷新缓存");
  ui["refresh-cache"].disabled = !state.authenticated || state.isOffline || !state.cacheSupported || mode === "syncing";
}
function enterOfflineMode() {
  if (!state.authenticated) return;
  state.isOffline = true;
  if (ui["field-editor"].open) ui["field-editor"].close();
  closeCalendarDialog();
  paintOfflineStatus("offline"); updateControls();
}
function clearAllOfflineData(notify = true) {
  state.offlineEpoch++;
  state.offlineMeta = null; state.syncPromise = null;
  for (const key of [OFFLINE_META_KEY, LOCAL_CHECKS_KEY]) {
    try { localStorage.removeItem(key); } catch { /* 浏览器存储不可用时不会允许离线启动。 */ }
  }
  const clear = async () => {
    if ("caches" in window) await caches.delete(PRIVATE_CACHE);
    if (notify) await swMessage("CLEAR_PRIVATE_CACHE", true);
  };
  state.clearPromise = clear().catch(() => {
    ui["auth-message"].textContent = "本机私密缓存清理失败，请清除浏览器站点数据后再使用。";
  });
  return state.clearPromise;
}
async function cachedPrivateResponse(path) {
  if (!state.authenticated || !state.cacheSupported) throw offlineFailure();
  const epoch = state.offlineEpoch;
  const response = await (await caches.open(PRIVATE_CACHE)).match(path);
  if (!response || epoch !== state.offlineEpoch || !state.authenticated) throw offlineFailure();
  const headers = new Headers(response.headers); headers.set("X-EB-Offline-Cache", "1");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function pwaRead(path, options) {
  const generation = state.authGeneration, epoch = state.offlineEpoch;
  if (state.isOffline) return cachedPrivateResponse(path);
  try { return await timedFetch(path, { ...options, cache: "no-store" }); }
  catch (error) {
    if (generation !== state.authGeneration || epoch !== state.offlineEpoch) throw authInterrupted();
    if (!state.authenticated) throw error;
    enterOfflineMode();
    return cachedPrivateResponse(path);
  }
}
async function tryOfflineBoot() {
  if (!state.cacheSupported || readLocal(PENDING_LOGOUT_KEY, false)) return false;
  const meta = readLocal(OFFLINE_META_KEY);
  if (!meta?.hasOfflineSnapshot) return false;
  const epoch = state.offlineEpoch;
  const cache = await caches.open(PRIVATE_CACHE), response = await cache.match("/api/events");
  if (!response || epoch !== state.offlineEpoch) return false;
  let data;
  try { data = await response.json(); } catch { return false; }
  if (!data.ok || !Array.isArray(data.events)) return false;
  const available = [];
  for (const event of data.events) {
    if (event.timeline_bucket === "upcoming" && await cache.match(eventPath(event.id))) available.push(event);
  }
  if (epoch !== state.offlineEpoch) return false;
  state.authenticated = true; state.authConfigured = true; state.authGeneration++;
  state.offlineMeta = meta; state.isOffline = true; state.events = data.events;
  ui["auth-gate"].hidden = true; ui.workspace.hidden = false;
  ui["auth-token"].value = "";
  await swMessage("ENABLE_PRIVATE_CACHE", true);
  if (epoch !== state.offlineEpoch || !state.authenticated) return false;
  renderList(); paintOfflineStatus("offline"); updateControls();
  if (available.length) await selectEvent(available[0].id);
  return true;
}
async function fetchForSync(path, epoch, generation) {
  let response;
  try { response = await timedFetch(path, { credentials: "same-origin", cache: "reload" }); }
  catch { if (epoch === state.offlineEpoch && generation === state.authGeneration) enterOfflineMode(); throw offlineFailure(); }
  if (epoch !== state.offlineEpoch || generation !== state.authGeneration || !state.authenticated) throw authInterrupted();
  if (response.status === 401) { showGate(); await state.clearPromise; throw authInterrupted(); }
  if (response.headers.get("X-EB-Offline-Cache") === "1") { enterOfflineMode(); throw offlineFailure(); }
  if (!response.ok) throw new Error("离线同步失败（HTTP " + response.status + "）");
  return response;
}
function syncUpcomingOfflineCache(upcomingEvents, force = false) {
  if (!state.cacheSupported || !state.authenticated || state.isOffline) return Promise.resolve();
  if (state.syncPromise) return state.syncPromise;
  const epoch = state.offlineEpoch, generation = state.authGeneration;
  const current = () => epoch === state.offlineEpoch && generation === state.authGeneration && state.authenticated && !state.isOffline;
  const task = (async () => {
    await state.clearPromise;
    if (!current()) return;
    await state.swReadyPromise;
    if (!current() || !state.cacheSupported) return;
    await swMessage("ENABLE_PRIVATE_CACHE", true);
    if (!current()) return;
    paintOfflineStatus("syncing");
    const cache = await caches.open(PRIVATE_CACHE), old = readLocal(OFFLINE_META_KEY, {});
    const versions = {}, images = new Set(), detailPaths = new Set();
    const listResponse = await fetchForSync("/api/events", epoch, generation);
    const data = await listResponse.clone().json();
    if (!data.ok || !Array.isArray(data.events)) throw new Error("活动列表无法用于离线同步");
    const upcoming = data.events.filter(event => event.timeline_bucket === "upcoming");
    if (!current()) return;
    for (const event of upcoming) {
      const path = eventPath(event.id); detailPaths.add(path);
      let response = await cache.match(path);
      if (force || old.cachedEventVersions?.[event.id] !== event.version || !response) {
        response = await fetchForSync(path, epoch, generation);
        if (!current()) return;
        await cache.put(path, response.clone());
      }
      const detail = (await response.json()).event;
      if (!detail) throw new Error("活动详情无法用于离线同步");
      versions[event.id] = detail.version;
      const view = presentation(detail), ids = new Set(list(view?.l1_core?.credential_item_ids));
      for (const zone of list(view?.l2_modules?.zones)) for (const id of list(zone?.map_item_ids)) ids.add(id);
      for (const raw of list(detail.raw_items)) {
        if (raw.type !== "image" || !ids.has(raw.id)) continue;
        const full = imageUrl(raw);
        if (!full) continue;
        const url = new URL(full).pathname + new URL(full).search; images.add(url);
        if (force || !await cache.match(url)) {
          const image = await fetchForSync(url, epoch, generation);
          if (!current()) return;
          await cache.put(url, image.clone());
        }
      }
      if (!current()) return;
    }
    if (!current()) return;
    await cache.put("/api/events", listResponse);
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (url.pathname === "/api/events" && !url.search) continue;
      const path = url.pathname + url.search;
      if (!detailPaths.has(path) && !images.has(path)) await cache.delete(request);
    }
    if (!current()) return;
    const meta = { hasOfflineSnapshot: true, lastSyncAt: new Date().toISOString(),
      upcomingCount: upcoming.length, imageCount: images.size, cachedEventVersions: versions, cachedImageUrls: [...images] };
    writeLocal(OFFLINE_META_KEY, meta);
    state.offlineMeta = meta; paintOfflineStatus("ready");
  })().catch(error => {
    if (current() && error.status !== 401) paintOfflineStatus("error", error.message || "离线同步未完成");
  }).finally(() => { if (state.syncPromise === task) state.syncPromise = null; });
  state.syncPromise = task;
  return task;
}
function localCheck(eventId, fingerprint, text, className = "") {
  const label = el("label", "local-check " + className), input = el("input"), caption = el("span", "", text);
  input.type = "checkbox";
  const checks = readLocal(LOCAL_CHECKS_KEY, {});
  input.checked = checks[eventId]?.[fingerprint] === true;
  caption.classList.toggle("completed", input.checked);
  input.addEventListener("change", () => {
    if (!state.authenticated) { input.checked = false; return; }
    const data = readLocal(LOCAL_CHECKS_KEY, {});
    // 使用 own-property 防止活动/条目文本影响对象原型。
    const perEvent = Object.hasOwn(data, eventId) && data[eventId] && typeof data[eventId] === "object" ? data[eventId] : {};
    const next = { ...data, [eventId]: { ...perEvent, [fingerprint]: input.checked } };
    try { writeLocal(LOCAL_CHECKS_KEY, next); caption.classList.toggle("completed", input.checked); }
    catch { input.checked = !input.checked; toast("浏览器未允许保存本机勾选状态", "warning"); }
  });
  label.append(input, caption);
  return label;
}
async function flushPendingLogout() {
  if (!readLocal(PENDING_LOGOUT_KEY, false)) return;
  const response = await timedFetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("上次本地退出尚未完成，请联网后重试");
  localStorage.removeItem(PENDING_LOGOUT_KEY);
}
function setupPwa() {
  state.cacheSupported = window.isSecureContext && "serviceWorker" in navigator && "caches" in window;
  if (!state.cacheSupported) { paintOfflineStatus("unsupported"); return; }
  try { localStorage.setItem("eb_storage_probe", "1"); localStorage.removeItem("eb_storage_probe"); }
  catch { state.cacheSupported = false; paintOfflineStatus("unsupported"); return; }
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type === "AUTHORIZE_PRIVATE_READ") {
      event.ports?.[0]?.postMessage({ authorized: state.authenticated && !readLocal(PENDING_LOGOUT_KEY, false) });
      return;
    }
    if (event.data?.type === "PRIVATE_CACHE_CLEARED") {
      showGate("会话已锁定，请重新输入访问口令", false);
      clearAllOfflineData(false);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (state.authenticated) swMessage("ENABLE_PRIVATE_CACHE").catch(() => {});
  });
  state.swReadyPromise = navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(async registration => {
    await navigator.serviceWorker.ready;
    ui["offline-bar"].dataset.worker = "active";
    state.swRegistration = registration;
    if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
    if (state.authenticated) swMessage("ENABLE_PRIVATE_CACHE").catch(() => {});
  }).catch(() => { state.cacheSupported = false; paintOfflineStatus("unsupported"); });
}
async function init() {
  setupPwa();
  await checkAuth();
}

function authInterrupted() {
  return Object.assign(new Error("请先输入访问口令"), { status: 401 });
}
function updateAuthControls() {
  ui["auth-token"].disabled = state.authBusy || state.authConfigured !== true;
  ui["login-submit"].disabled = state.authBusy || state.authConfigured === false;
  ui["login-submit"].textContent = state.authBusy ? "正在验证…" :
    state.authConfigured === null ? "重试连接" : "进入看板";
}
function showGate(message = "请先输入访问口令", clearOffline = true) {
  if (clearOffline) clearAllOfflineData();
  state.isOffline = false;
  closeCalendarDialog();
  state.busy = false; closeEditor();
  state.authGeneration++;
  state.authenticated = false;
  state.sequence++; state.listSequence++;
  state.events = []; state.event = null; state.selected = null;
  state.activeTab = "upcoming"; state.archiveQuery = "";
  for (const d of state.drafts.values()) for (const image of d.images) URL.revokeObjectURL(image.url);
  state.drafts.clear();
  state.busy = false; state.loading = false; state.preparing = 0;
  ui.workspace.hidden = true; ui["auth-gate"].hidden = false;
  ui["event-list"].replaceChildren(); ui.cards.replaceChildren(); ui.archive.replaceChildren();
  ui["image-queue"].replaceChildren(); ui["material-text"].value = "";
  ui["compile-meta"].textContent = ""; ui["archive-search"].value = "";
  ui["upcoming-tab"].textContent = "即将发生 (0)";
  ui["archived-tab"].textContent = "历史归档 (0)";
  ui.detail.hidden = true; ui.welcome.hidden = false;
  ui["detail-loading"].hidden = true;
  ui["lightbox-image"].removeAttribute("src");
  if (ui.lightbox.open) ui.lightbox.close();
  document.body.classList.remove("detail-open", "lightbox-open");
  clearTimeout(state.toastTimer); ui.toast.hidden = true;
  ui["toast-message"].textContent = ""; status();
  ui["auth-token"].value = "";
  ui["auth-message"].textContent = message;
  updateAuthControls(); updateControls();
  if (!ui["auth-token"].disabled) ui["auth-token"].focus();
}
async function apiFetch(path, options = {}, responseType = "json") {
  const generation = state.authGeneration;
  let response;
  try {
    const method = (options.method || "GET").toUpperCase();
    if (state.isOffline && !(method === "GET" && (privateReadPath(path) || path === "/api/auth/status"))) throw offlineFailure();
    const requestOptions = { ...options, credentials: "same-origin" };
    response = method === "GET" && privateReadPath(path) ? await pwaRead(path, requestOptions)
      : path === "/api/auth/status" ? await timedFetch(path, requestOptions) : await fetch(path, requestOptions);
  } catch {
    if (generation !== state.authGeneration) throw authInterrupted();
    throw Object.assign(new Error("网络连接失败，请检查连接后重试"), { offline: true });
  }
  if (generation !== state.authGeneration) throw authInterrupted();
  if (response.status === 401) {
    showGate();
    await state.clearPromise;
    let data;
    try { data = await response.json(); } catch { /* 门禁已经即时关闭。 */ }
    throw Object.assign(new Error(words(data?.error) || "请先输入访问口令"), { status: 401 });
  }
  if (response.headers.get("X-EB-Offline-Cache") === "1") enterOfflineMode();
  if (response.ok && responseType === "blob") {
    const blob = await response.blob();
    if (generation !== state.authGeneration) throw authInterrupted();
    return blob;
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error("服务返回了无法读取的响应（HTTP " + response.status + "），请稍后重试"); }
  if (generation !== state.authGeneration) throw authInterrupted();
  if (!response.ok || !data?.ok) {
    throw Object.assign(new Error(words(data?.error) || "请求失败（HTTP " + response.status + "）"), { status: response.status, offline: data?.offline === true });
  }
  return data;
}
async function enterWorkspace() {
  state.authenticated = true; state.authGeneration++;
  const workspaceGeneration = state.authGeneration;
  state.isOffline = false; state.offlineMeta = readLocal(OFFLINE_META_KEY);
  await state.clearPromise;
  if (!state.authenticated || workspaceGeneration !== state.authGeneration) return;
  await swMessage("ENABLE_PRIVATE_CACHE", true);
  if (!state.authenticated || workspaceGeneration !== state.authGeneration) return;
  ui["auth-token"].value = ""; ui["auth-message"].textContent = "";
  ui["auth-gate"].hidden = true; ui.workspace.hidden = false;
  renderList(); updateControls();
  try { await loadList(); if (state.selected && state.event) await refreshCurrent(); }
  catch (error) {
    if (!state.authenticated || error.status === 401) return;
    ui["event-list"].replaceChildren(el("p", "empty-state", error.message),
      button("重新加载", "ghost", loadList));
    throw error;
  }
}
async function checkAuth() {
  const generation = state.authGeneration;
  state.authBusy = true; updateAuthControls();
  try {
    await flushPendingLogout();
    const data = await apiFetch("/api/auth/status");
    if (generation !== state.authGeneration) return;
    state.authConfigured = data.auth_configured === true;
    if (!state.authConfigured) showGate("服务端尚未配置有效的 AUTH_TOKEN 访问口令，请在 .dev.vars 中设置");
    else if (data.authenticated) await enterWorkspace();
    else showGate("请输入访问口令");
  } catch (error) {
    if (error.status !== 401) {
      if (error.offline && await tryOfflineBoot()) return;
      showGate(error.offline
        ? "当前处于离线状态且本机暂无缓存，请在联网状态下登录一次以启用断网秒开"
        : error.message);
    }
  } finally { state.authBusy = false; updateAuthControls(); }
}
async function login(event) {
  event.preventDefault();
  if (state.authBusy || state.authConfigured === false) return;
  if (state.authConfigured === null) { await checkAuth(); return; }
  const generation = state.authGeneration;
  state.authBusy = true; ui["auth-message"].textContent = ""; updateAuthControls();
  try {
    await flushPendingLogout();
    await apiFetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ui["auth-token"].value }),
    });
    if (generation !== state.authGeneration) return;
    await enterWorkspace();
  } catch (error) {
    if (!state.authenticated) ui["auth-message"].textContent = error.message;
    else if (error.status !== 401) toast(error.message, "error");
  } finally {
    state.authBusy = false; ui["auth-token"].value = ""; updateAuthControls();
    if (!state.authenticated && !ui["auth-token"].disabled) ui["auth-token"].focus();
  }
}
async function logout() {
  if (state.authBusy) return;
  state.authBusy = true;
  const wasOffline = state.isOffline || navigator.onLine === false;
  try { writeLocal(PENDING_LOGOUT_KEY, true); } catch { /* 同步清缓存仍然执行。 */ }
  showGate("正在安全退出…");
  try {
    await state.clearPromise;
    if (wasOffline) {
      ui["auth-message"].textContent = "已清除本机缓存并锁定，联网后会完成服务端退出。";
      return;
    }
    await apiFetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem(PENDING_LOGOUT_KEY);
    ui["auth-message"].textContent = "已锁定，请输入访问口令";
  } catch {
    ui["auth-message"].textContent = "页面已锁定，但服务端退出请求失败；请检查网络后重新加载并再次退出。";
  } finally {
    state.authBusy = false; updateAuthControls();
    if (!ui["auth-token"].disabled) ui["auth-token"].focus();
  }
}

async function checkImageAuth() {
  if (!state.authenticated || state.isOffline) return;
  const generation = state.authGeneration;
  try {
    const data = await apiFetch("/api/auth/status");
    if (generation !== state.authGeneration) return;
    if (!data.authenticated || !data.auth_configured) {
      state.authConfigured = data.auth_configured === true;
      showGate(state.authConfigured ? "访问会话已失效，请重新输入口令" :
        "服务端尚未配置有效的 AUTH_TOKEN 访问口令，请在 .dev.vars 中设置");
    }
  } catch { /* 离线或缺图不误判为退出；401 由 apiFetch 处理。 */ }
}

let calendarInfoRequest = 0;
function closeCalendarDialog() {
  calendarInfoRequest++;
  if (ui["calendar-dialog"].open) ui["calendar-dialog"].close();
  ui["calendar-url"].value = "";
  ui["calendar-content"].hidden = true;
  ui["calendar-message"].textContent = "";
}
async function openCalendarDialog() {
  if (!state.authenticated || state.authBusy || state.isOffline) return;
  const request = ++calendarInfoRequest;
  const generation = state.authGeneration;
  ui["calendar-url"].value = ""; ui["calendar-content"].hidden = true;
  ui["calendar-message"].textContent = "正在读取日历订阅设置…";
  if (!ui["calendar-dialog"].open) ui["calendar-dialog"].showModal();
  try {
    const data = await apiFetch("/api/cal/info");
    if (request !== calendarInfoRequest || generation !== state.authGeneration || !ui["calendar-dialog"].open) return;
    if (!data.configured || typeof data.subscribe_path !== "string") {
      ui["calendar-message"].textContent = "请先在 .dev.vars 中配置 CAL_TOKEN 并重启服务（必须使用独立于主访问口令的令牌）。";
      return;
    }
    if (!data.subscribe_path.startsWith("/api/cal/") || !data.subscribe_path.endsWith(".ics")) {
      throw new Error("日历订阅地址格式无效");
    }
    ui["calendar-url"].value = window.location.origin + data.subscribe_path;
    ui["calendar-content"].hidden = false; ui["calendar-message"].textContent = "";
  } catch (error) {
    if (request === calendarInfoRequest && error.status !== 401) ui["calendar-message"].textContent = error.message;
  }
}
async function exportCalendar() {
  if (state.isOffline || locked() || !state.event) return;
  if (timestamp(presentation(state.event)?.l1_core?.start_time) === null) {
    toast("时间待定，完善明确时间后可导出日程", "warning"); return;
  }
  const id = state.selected, generation = state.authGeneration;
  state.busy = true; updateControls();
  try {
    const blob = await apiFetch(eventPath(id) + "/calendar.ics", {}, "blob");
    if (generation !== state.authGeneration || !state.authenticated) return;
    const url = URL.createObjectURL(blob), link = el("a");
    link.href = url;
    link.download = "event-" + String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0,32) + ".ics";
    document.body.append(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    toast("已导出日程文件，可直接导入日历");
  } catch (error) {
    if (error.status !== 401 && state.authenticated) toast(error.message, "error");
  } finally { state.busy = false; updateControls(); }
}

const editGroups = {
  title: { title: "活动标题", fields: [["l1_core.title","活动标题","text"]] },
  time: { title: "时间", fields: [["l1_core.time_display","时间展示","text"],["l1_core.start_time","开始时间（东八区）","datetime-local"],["l1_core.end_time","结束时间（东八区）","datetime-local"]] },
  location: { title: "地点", fields: [["l1_core.location_name","地点名称","text"],["l1_core.location_address","详细地址","text"]] },
  rules: { title: "硬性红线提示", fields: [["l1_core.must_know","硬性红线提示","lines"]] },
  focus: { title: "个人关注目标", fields: [["l2_modules.personal_focus","个人关注目标","lines"]] },
  contacts: { title: "入口与联络", fields: [["l2_modules.links_and_contacts","入口与联络","contacts"]] },
};
let editorState = null;
const presentation = (event) => event?.view || event?.compiled_data;
function pathValue(data, path) { const [a,b]=path.split("."); return data?.[a]?.[b] ?? null; }
function valueDisplay(value) {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item :
    [words(item?.label),words(item?.value)].filter(Boolean).join(" | ")).join("\n") || "（空）";
  return value == null || value === "" ? "（空）" : String(value);
}
function addEditTools(parent, group, event, includeEdit = true) {
  const controls = el("div", "edit-tools pc-only");
  const edit = button("微调", "ghost", () => openEditor(group));
  edit.dataset.mutating = ""; edit.setAttribute("aria-label", "微调："+editGroups[group].title); if(includeEdit)controls.append(edit);
  for (const [path,label] of editGroups[group].fields) {
    if (!list(event.locked_fields).includes(path)) continue;
    controls.append(el("span", "badge locked-badge", label + " · 已锁定"));
    const unlock=button("解锁恢复AI值", "ghost", () => patchOverrides({unlock:[path]},"已恢复 AI 的「"+label+"」"));
    unlock.setAttribute("aria-label","解锁恢复AI值："+label); unlock.dataset.mutating=""; controls.append(unlock);
  }
  parent.append(controls);
}
function renderConflicts(parent, event) {
  if (!list(event.pending_conflicts).length) return;
  const box=el("section","conflict-panel");
  box.append(el("h3","","检测到最新通知与你的手动修改冲突，请确认"));
  for (const conflict of event.pending_conflicts) {
    const row=el("div","conflict-entry");
    row.append(el("strong","",words(conflict.label)||"字段"),
      el("p","conflict-value","我的锁定值：\n"+valueDisplay(conflict.current_value)),
      el("p","conflict-value","AI 最新提取：\n"+valueDisplay(conflict.ai_value)));
    const actions=el("div","inline-actions pc-only");
    for (const [label,payload] of [
      ["采用 AI 新值并解锁",{unlock:[conflict.field]}],
      ["保留我的修改",{dismiss_conflicts:[conflict.field]}],
    ]) {
      const action=button(label,"ghost",()=>patchOverrides(payload,label+"："+conflict.label));
      action.dataset.mutating="";actions.append(action);
    }
    row.append(actions);box.append(row);
  }
  box.append(el("p","helper mobile-only","请在电脑端处理字段冲突"));parent.append(box);
}
function closeEditor() {
  if (state.busy) return;
  if (ui["field-editor"].open) ui["field-editor"].close();
  editorState=null;ui["editor-fields"].replaceChildren();ui["editor-error"].textContent="";
}
function openEditor(group) {
  if (state.isOffline) return;
  if (narrow.matches || locked() || !presentation(state.event)) return;
  closeEditor();
  const data=presentation(state.event);
  editorState={eventId:state.selected,generation:state.authGeneration,group,inputs:[]};
  ui["editor-title"].textContent="微调"+editGroups[group].title;
  for (const [path,label,type] of editGroups[group].fields) {
    const wrap=el("div","editor-field"), input=el(type==="lines"||type==="contacts"?"textarea":"input");
    input.id="edit-"+path.replaceAll(".","-");
    if(input.tagName.toLowerCase()==="input")input.type=type;
    const value=pathValue(data,path);
    let initial=typeof value==="string"?value:"";
    if(type==="datetime-local") {
      const ms=timestamp(value);initial=ms===null?"":new Date(ms+8*3600000).toISOString().slice(0,16);
    } else if(type==="lines")initial=list(value).join("\n");
    else if(type==="contacts")initial=list(value).map(item=>(words(item.label)||"参考信息")+" | "+words(item.value)).join("\n");
    input.value=initial;if(path==="l1_core.title")input.required=true;
    const lab=el("label","",label);lab.htmlFor=input.id;
    wrap.append(lab,input);ui["editor-fields"].append(wrap);
    editorState.inputs.push({path,type,input,initial});
  }
  ui["editor-help"].textContent=group==="contacts"?"每行「名称 | 链接或联系方式」；链接仅允许 http:// 或 https://":
    ["rules","focus"].includes(group)?"每行一条，空行自动忽略":"时间按东八区填写；只锁定实际修改过的字段，清空可选字段表示 null。";
  ui["field-editor"].showModal();editorState.inputs[0]?.input.focus();
}
function readEditorValue(entry) {
  const value=entry.input.value.trim();
  if(entry.type==="datetime-local")return value ? value+":00+08:00" : null;
  if(entry.type==="lines")return value.split("\n").map(v=>v.trim()).filter(Boolean);
  if(entry.type==="contacts")return value.split("\n").map(line=>{
    const index=line.indexOf("|"),label=index<0?"参考信息":line.slice(0,index).trim()||"参考信息";
    const content=(index<0?line:line.slice(index+1)).trim();
    if(!content)return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(content) && !validLink(content) && !/^(tel|mailto):/i.test(content)) {
      throw new Error("链接仅允许 http:// 或 https:// 协议");
    }
    return {label,value:content,type:validLink(content)?"url":"text"};
  }).filter(Boolean);
  if(entry.path==="l1_core.title"&&!value)throw new Error("活动标题不可为空");
  return value || null;
}
async function saveEditor(event) {
  if (state.isOffline) return;
  event.preventDefault();
  if(narrow.matches||locked()||!editorState)return;
  const current=editorState,set={};
  try {
    for(const entry of current.inputs) {
      if(entry.input.value===entry.initial)continue;
      const next=readEditorValue(entry);
      // 仅提交变化的子字段，不会顺带锁住整个时间或地点组。
      if(JSON.stringify(next)!==JSON.stringify(pathValue(presentation(state.event),entry.path)))set[entry.path]=next;
    }
    if(!Object.keys(set).length){closeEditor();toast("没有改动字段");return;}
    await patchOverrides({set},"已保存并锁定修改字段，后续重新整理不会覆盖",true);
  } catch(error) {
    if(editorState===current && error.status!==401)ui["editor-error"].textContent=error.message;
  }
}
async function patchOverrides(payload, message, fromEditor=false) {
  if (state.isOffline) return;
  if(narrow.matches||locked()||!state.event)return;
  const id=state.selected,generation=state.authGeneration;
  state.busy=true;updateControls();ui["editor-save"].disabled=true;
  try {
    const {event}=await apiFetch(eventPath(id)+"/overrides",{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),
    });
    if(generation!==state.authGeneration||id!==state.selected)return;
    state.event=event;state.activeTab=event.timeline_bucket==="archived"?"archived":"upcoming";
    state.events=state.events.map(item=>item.id===id?{...event,raw_count:list(event.raw_items).length}:item);
    state.busy=false;
    if(fromEditor)closeEditor();
    state.busy=true;
    renderDetail();renderList();toast(message);
    try{await loadList()}catch(error){if(error.status!==401)toast("字段已保存，列表刷新失败，可稍后重试","warning")}
  } catch(error) {
    if(!fromEditor&&error.status!==401)toast(error.message,"error");
    throw error;
  } finally {state.busy=false;ui["editor-save"].disabled=false;updateControls();}
}

const eventPath = (id) => "/api/events/" + encodeURIComponent(id);
function draft(id = state.selected) {
  if (!state.drafts.has(id)) state.drafts.set(id, { text: "", savedText: null, images: [] });
  return state.drafts.get(id);
}
function validLink(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function imageUrl(item) {
  if (typeof item?.image_url !== "string") return null;
  try {
    const url = new URL(item.image_url, location.origin);
    return url.origin === location.origin && url.pathname.startsWith("/api/images/") ? url.href : null;
  } catch { return null; }
}
function externalLink(label, href, className = "") {
  const node = el("a", className, label);
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}
function timestamp(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.getTime() : null;
}
function localTime(value) {
  const ms = timestamp(value);
  return ms === null ? "时间未知" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}
function countdown(core, event = {}) {
  const end = timestamp(event.effective_end_time) ?? timestamp(core.end_time);
  if (["ended", "archived"].includes(event.time_state) || event.timeline_bucket === "archived" ||
      (end !== null && Date.now() > end)) return ["已结束", ""];
  if (event.time_state === "draft") return ["待整理", ""];
  const start = timestamp(core.start_time), now = Date.now();
  if (start === null) return ["时间待定", ""];
  if (start <= now) return ["进行中", "active"];
  const hours = (start - now) / 3600000;
  return [hours >= 24 ? "距开始 " + Math.ceil(hours / 24) + " 天" :
    hours >= 1 ? "距开始 " + Math.ceil(hours) + " 小时" : "距开始不足 1 小时", "upcoming"];
}
function countdownBadge(core, event) {
  const [label, kind] = countdown(core, event);
  const node = el("span", "badge " + kind, label);
  node.dataset.countdown = "";
  node.dataset.start = words(core.start_time);
  node.dataset.end = words(event.effective_end_time) || words(core.end_time);
  node.dataset.timeState = words(event.time_state);
  node.dataset.bucket = words(event.timeline_bucket);
  return node;
}
function switchTab(tab) {
  if (locked()) return;
  state.activeTab = tab;
  renderList();
}
function renderList() {
  const upcoming = state.events.filter((event) => event.timeline_bucket === "upcoming");
  const archived = state.events.filter((event) => event.timeline_bucket === "archived");
  ui["upcoming-tab"].textContent = "即将发生 (" + upcoming.length + ")";
  ui["archived-tab"].textContent = "历史归档 (" + archived.length + ")";
  for (const tab of ["upcoming", "archived"]) {
    const selected = state.activeTab === tab;
    ui[tab + "-tab"].setAttribute("aria-selected", String(selected));
    ui[tab + "-tab"].tabIndex = selected ? 0 : -1;
  }
  ui["event-list"].setAttribute("aria-labelledby", state.activeTab + "-tab");
  ui["archive-search-area"].hidden = state.activeTab !== "archived";
  const query = state.archiveQuery.trim().toLocaleLowerCase("zh-CN");
  const events = (state.activeTab === "archived" ? archived : upcoming).filter((event) => {
    if (state.activeTab !== "archived" || !query) return true;
    const core = object(object(presentation(event)).l1_core);
    return [core.title, core.location_name, core.location_address, core.time_display]
      .some((value) => words(value).toLocaleLowerCase("zh-CN").includes(query));
  });
  ui["event-list"].replaceChildren();
  if (!events.length) {
    const message = state.activeTab === "archived"
      ? query ? "没有匹配的历史活动。" : "暂无历史归档，结束的活动会自动归入这里。"
      : narrow.matches ? "暂无即将发生的活动，请在电脑端新建并整理素材。" : "暂无即将发生的活动，点击「+ 新活动」开始收集素材。";
    ui["event-list"].append(el("p", "empty-state", message));
    return;
  }
  for (const event of events) {
    const core = object(object(presentation(event)).l1_core);
    const node = button("", "event-row" + (event.id === state.selected ? " selected" : ""), () => selectEvent(event.id));
    if (event.id === state.selected) node.setAttribute("aria-current", "true");
    node.dataset.navigation = "";
    node.append(el("span", "event-title", words(core.title) || "未整理活动"),
      el("span", "event-time", words(core.time_display) || "时间待定"));
    const bottom = el("span", "event-bottom");
    bottom.append(countdownBadge(core, event), el("span", "", String(Number(event.raw_count) || 0) + " 条素材"));
    if (event.pending_conflict_count > 0) bottom.append(el("span","badge conflict-badge","待确认冲突"));
    node.append(bottom); node.disabled = locked();
    ui["event-list"].append(node);
  }
}
async function loadList() {
  const token = ++state.listSequence;
  let data;
  try { data = await apiFetch("/api/events"); }
  catch (error) {
    if (token !== state.listSequence) return;
    throw error;
  }
  if (token !== state.listSequence) return;
  state.events = list(data.events);
  renderList();
  if (!state.isOffline) syncUpcomingOfflineCache(state.events.filter(event => event.timeline_bucket === "upcoming"));
}
function updateControls() {
  const hasEvent = !!state.event && !state.loading;
  const d = state.selected ? draft() : { text: "", images: [] };
  const hasInput = !!d.text.trim() || d.images.some((item) => !item.uploaded);
  ui["save-compile"].textContent = !hasInput && list(state.event?.raw_items).length ? "重新整理" : "保存并整理";
  ui["save-compile"].disabled = writeLocked() || !hasEvent || (!hasInput && !list(state.event?.raw_items).length);
  ui["save-only"].disabled = writeLocked() || !hasEvent || !hasInput;
  ui["new-event"].disabled = writeLocked();
  ui["delete-event"].disabled = writeLocked() || !hasEvent;
  ui["choose-images"].disabled = writeLocked() || !hasEvent;
  ui["material-text"].disabled = state.busy || state.isOffline || !hasEvent;
  ui["back-list"].disabled = locked();
  ui["upcoming-tab"].disabled = locked();
  ui["archived-tab"].disabled = locked();
  ui["archive-search"].disabled = locked();
  document.querySelectorAll("[data-navigation]").forEach((node) => {
    node.disabled = locked();
  });
  document.querySelectorAll("[data-mutating]").forEach(node => { node.disabled = writeLocked(); });
  ui["editor-save"].disabled = writeLocked();
  ui["calendar-subscribe"].disabled = state.isOffline || !state.authenticated;
  document.querySelectorAll("[data-calendar-export]").forEach(node => {
    node.disabled = writeLocked() || timestamp(presentation(state.event)?.l1_core?.start_time) === null;
  });
  paintOfflineStatus();
  ui.composer.setAttribute("aria-busy", String(locked()));
}
function renderQueue() {
  if (!state.authenticated) { ui["image-queue"].replaceChildren(); return; }
  const d = draft();
  ui["image-queue"].replaceChildren();
  for (const entry of d.images) {
    const figure = el("figure", "queue-item");
    const img = el("img"); img.src = entry.url; img.alt = entry.file.name;
    const remove = button("×", "icon-button queue-remove", () => {
      if (locked()) return;
      URL.revokeObjectURL(entry.url);
      d.images = d.images.filter((item) => item !== entry);
      renderQueue(); updateControls();
    });
    remove.setAttribute("aria-label", "移除待传图片：" + entry.file.name);
    remove.dataset.mutating = "";
    figure.append(img, remove, el("figcaption", "", entry.uploaded ? "已暂存，无需重传" : entry.file.name));
    ui["image-queue"].append(figure);
  }
}
async function selectEvent(id, focusInput = false) {
  if (locked()) return;
  state.selected = id;
  state.event = null;
  state.loading = true;
  const token = ++state.sequence;
  document.body.classList.add("detail-open");
  ui.welcome.hidden = true;
  ui.detail.hidden = false;
  ui["detail-loading"].hidden = false;
  ui.cards.replaceChildren(); ui.archive.replaceChildren();
  ui["compile-meta"].textContent = "";
  ui.composer.hidden = true;
  status();
  renderList(); updateControls();
  try {
    const { event } = await apiFetch(eventPath(id));
    if (token !== state.sequence) return;
    state.event = event;
    ui.composer.open = !narrow.matches || focusInput;
    ui["material-text"].value = draft(id).text;
    renderDetail();
  } catch (error) {
    if (token !== state.sequence) return;
    ui.cards.replaceChildren(el("div", "card empty-state", error.message),
      button("重新读取", "ghost", () => selectEvent(id, focusInput)));
    toast(error.message, "error");
  } finally {
    if (token === state.sequence) {
      state.loading = false;
      ui["detail-loading"].hidden = true;
      updateControls();
      if (focusInput && state.event) ui["material-text"].focus();
    }
  }
}
function renderDetail() {
  const event = state.event;
  if (!event) return;
  const meta = object(object(presentation(event)).meta);
  ui["compile-meta"].textContent = event.compiled_data
    ? "最后整理 " + localTime(meta.compiled_at) + (words(meta.model) ? " · " + meta.model : "")
    : "尚未整理";
  ui.composer.hidden = false;
  renderQueue();
  renderCards(event);
  renderArchive(event);
  updateControls();
}
function card(title) {
  const node = el("section", "card module");
  node.append(el("h2", "", title));
  return node;
}
function addTags(parent, values, className = "") {
  const tags = el("ul", "tags " + className);
  for (const value of list(values)) if (typeof value === "string" && value) tags.append(el("li", "tag", value));
  if (tags.childElementCount) parent.append(tags);
}
async function copyText(value) {
  const generation = state.authGeneration;
  const subscription = ui["calendar-dialog"].open && ui["calendar-url"].value === value;
  const allowed = () => state.authenticated && generation === state.authGeneration &&
    (!subscription || (ui["calendar-dialog"].open && ui["calendar-url"].value === value));
  if (!allowed()) return;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); if (allowed()) toast("已复制"); return; }
    catch { /* 回退前重新确认会话和弹窗仍然有效。 */ }
  }
  if (!allowed()) return;
  const previous = document.activeElement;
  const input = el("textarea");
  input.value = value;
  input.style.position = "fixed"; input.style.opacity = "0";
  (subscription ? ui["calendar-dialog"] : document.body).append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请长按文字手动复制");
    toast("已复制");
  } finally { input.remove(); if (allowed()) previous?.focus(); }
}
function openImage(url, description) {
  ui["lightbox-image"].src = url;
  ui["lightbox-image"].alt = description || "原始图片";
  if (!ui.lightbox.open) ui.lightbox.showModal();
  document.body.classList.add("lightbox-open");
  ui["lightbox-close"].focus();
}
function imageButton(item, className = "") {
  const url = imageUrl(item);
  if (!url) return el("p", "helper", "原始图片不可用");
  const node = button("", "image-button " + className, () => openImage(url, item.content));
  node.setAttribute("aria-label", "放大查看：" + (words(item.content) || "原始图片"));
  const img = el("img"); img.src = url; img.alt = words(item.content) || "原始图片";
  img.loading = className.includes("raw-image") ? "lazy" : "eager";
  img.addEventListener("error", () => {
    run(checkImageAuth);
    node.replaceChildren(el("span", "image-caption", "图片读取失败，点击可重试查看"));
  }, { once: true });
  node.append(img);
  return node;
}
function imageReferences(parent, ids, event) {
  const grid = el("div", "image-grid");
  for (const id of new Set(list(ids))) {
    const item = list(event.raw_items).find((raw) => raw.id === id && raw.type === "image");
    if (item) grid.append(imageButton(item));
  }
  if (grid.childElementCount) parent.append(grid);
}
function renderCards(event) {
  ui.cards.replaceChildren();
  if (!presentation(event)) {
    ui.cards.append(el("div", "card empty-state",
      "把活动通知、截图或二维码粘贴到上方，点击「保存并整理」即可生成现场卡片"));
    return;
  }
  const data = object(presentation(event)), core = object(data.l1_core), modules = object(data.l2_modules);
  const main = el("section", "card core-card");
  renderConflicts(main,event);
  main.append(el("h2", "core-title", words(core.title) || "未命名活动"));
  addEditTools(main,"title",event);
  const time = el("div", "time-anchor");
  time.append(el("span", "", words(core.time_display) || "时间待定"), countdownBadge(core, event));
  const calendarExport = button("导出日程 .ics", "ghost", exportCalendar);
  calendarExport.dataset.calendarExport = "";
  calendarExport.disabled = timestamp(core.start_time) === null || locked();
  if (timestamp(core.start_time) === null) calendarExport.title = "时间待定，完善明确时间后可导出日程";
  time.append(calendarExport);
  main.append(time);addEditTools(main,"time",event);
  if (list(core.change_alerts).length) {
    const alert = el("div", "change-alerts");
    alert.append(el("h3", "", "请留意最新变更"));
    const alerts = el("ul");
    for (const entry of list(core.change_alerts)) {
      const item = object(entry), field = words(item.field) || "信息";
      alerts.append(el("li", "", (fieldNames[field] || field) + "：" + (words(item.old_value) || "未明确") +
        " → " + (words(item.new_value) || "未明确") + (words(item.reason) ? "（" + item.reason + "）" : "")));
    }
    alert.append(alerts); main.append(alert);
  }
  const locationName = words(core.location_name), address = words(core.location_address);
  if (locationName || address) {
    const location = el("div", "location");
    if (locationName) location.append(el("p", "location-name", locationName));
    if (address) location.append(el("p", "location-address", address));
    const full = [locationName, address].filter(Boolean).join(" ");
    const actions = el("div", "inline-actions");
    actions.append(button("复制地址", "ghost", () => copyText(full)),
      externalLink("高德导航", "https://uri.amap.com/search?keyword=" + encodeURIComponent(full), "button ghost"));
    location.append(actions); main.append(location);
  }
  addEditTools(main,"location",event);
  if (list(core.credential_item_ids).length) {
    const credentials = el("div", "credentials");
    credentials.append(el("h3", "", "入场凭证 / 签到码"));
    imageReferences(credentials, core.credential_item_ids, event);
    main.append(credentials);
  }
  if (list(core.must_know).length) {
    const rules = el("div", "must-know");
    rules.append(el("h3", "", "入场前务必确认"));
    addTags(rules, core.must_know); main.append(rules);
  }
  addEditTools(main,"rules",event);
  ui.cards.append(main);
  if (list(modules.schedule).length) {
    const section = card("议程安排");
    for (const entry of modules.schedule) {
      const item = object(entry), row = el("div", "agenda-entry"), content = el("div");
      row.append(el("span", "agenda-time", words(item.time) || "时间待定"));
      content.append(el("h3", "", words(item.title) || "议程"));
      if (words(item.location)) content.append(el("p", "agenda-note", item.location));
      if (words(item.note)) content.append(el("p", "agenda-note", item.note));
      row.append(content); section.append(row);
    }
    ui.cards.append(section);
  }
  if (list(modules.zones).length) {
    const section = card("展馆与区域");
    for (const entry of modules.zones) {
      const zone = object(entry), row = el("div", "zone-entry");
      row.append(localCheck(event.id, "zone:" + words(zone.name), words(zone.name) || "区域", "zone-check"));
      addTags(row, zone.highlights);
      imageReferences(row, zone.map_item_ids, event);
      section.append(row);
    }
    ui.cards.append(section);
  }
  if (list(modules.personal_focus).length) {
    const section = card("个人关注与目标"), items = el("ul", "focus-list");
    for (const value of modules.personal_focus) if (typeof value === "string") {
      const row=el("li");row.append(localCheck(event.id,"focus:"+value,value));items.append(row);
    }
    section.append(items);addEditTools(section,"focus",event); ui.cards.append(section);
  }
  if (list(modules.links_and_contacts).length) {
    const section = card("入口与联络");addEditTools(section,"contacts",event);
    for (const entry of modules.links_and_contacts) {
      const item = object(entry), row = el("div", "contact-entry"), content = el("div");
      const value = words(item.value), url = validLink(value);
      content.append(el("span", "contact-label", words(item.label) || "联络信息"));
      content.append(url ? externalLink(value, url, "contact-value") : el("p", "contact-value", value));
      row.append(content);
      if (!url && value) row.append(button("复制", "ghost contact-copy", () => copyText(value)));
      section.append(row);
    }
    ui.cards.append(section);
  }
  const supplements=el("div","supplements pc-only");
  if(!list(modules.personal_focus).length)supplements.append(button("+ 补充个人关注","ghost",()=>openEditor("focus")));
  if(!list(modules.links_and_contacts).length)supplements.append(button("+ 补充入口/联络","ghost",()=>openEditor("contacts")));
  for(const [group,path] of [["focus","l2_modules.personal_focus"],["contacts","l2_modules.links_and_contacts"]]) {
    if(!list(pathValue(data,path)).length && list(event.locked_fields).includes(path))addEditTools(supplements,group,event,false);
  }
  if(supplements.childElementCount)ui.cards.append(supplements);
}
function renderArchive(event) {
  const items = list(event.raw_items);
  ui.archive.replaceChildren(el("h2", "", "原始素材档案（共 " + items.length + " 条）"));
  if (!items.length) { ui.archive.append(el("p", "helper", "暂无素材，原始通知会一直保留在这里。")); return; }
  for (const item of [...items].reverse()) {
    const row = el("article", "raw-item"), header = el("div", "raw-header");
    header.append(el("time", "", localTime(item.created_at)));
    if (item.type === "image") {
      let role = "图片";
      try { role = roleNames[JSON.parse(item.image_summary)?.role] || "图片"; } catch { /* 缓存为空或损坏不影响原图。 */ }
      header.append(el("span", "badge", role));
    } else header.append(el("span", "", item.type === "url" ? "链接" : "文本"));
    const remove = button("删除", "ghost danger", () => deleteItem(event.id, item.id));
    remove.dataset.mutating = "";remove.classList.add("pc-only");
    remove.setAttribute("aria-label", "删除这条" + (item.type === "image" ? "图片" : "素材"));
    header.append(remove); row.append(header);
    if (item.type === "image") row.append(imageButton(item, "raw-image"));
    if (words(item.content)) {
      const url = item.type === "url" ? validLink(item.content) : null;
      row.append(url ? externalLink(item.content, url, "raw-text") : el("p", "raw-text raw-caption", item.content));
    }
    ui.archive.append(row);
  }
}
async function refreshCurrent() {
  const id = state.selected;
  const { event } = await apiFetch(eventPath(id));
  if (id === state.selected) { state.event = event; renderDetail(); }
  await loadList();
}
async function newEvent() {
  if (state.isOffline) return;
  if(narrow.matches)return;
  if (locked()) return;
  state.busy = true; updateControls();
  let created;
  try {
    created = (await apiFetch("/api/events", { method: "POST" })).event;
    state.listSequence++;
    state.activeTab = "upcoming";
    state.events.unshift({ ...created, raw_count: 0 });
    renderList();
  } finally { state.busy = false; updateControls(); }
  await selectEvent(created.id, true);
}
async function deleteItem(eventId, itemId) {
  if (state.isOffline) return;
  if(narrow.matches)return;
  if (locked() || !confirm("确定删除这条原始素材？此操作不可撤销。")) return;
  state.busy = true; updateControls();
  try {
    await apiFetch(eventPath(eventId) + "/items/" + encodeURIComponent(itemId), { method: "DELETE" });
    await refreshCurrent();
    toast("素材已删除，可点击「重新整理」同步更新卡片", "warning");
  } finally { state.busy = false; updateControls(); }
}
async function deleteEvent() {
  if (state.isOffline) return;
  if(narrow.matches)return;
  if (locked() || !state.event || !confirm("确定删除整个活动及其所有原始素材和图片？此操作不可撤销。")) return;
  const id = state.selected;
  state.busy = true; updateControls();
  try {
    await apiFetch(eventPath(id), { method: "DELETE" });
    for (const item of draft(id).images) URL.revokeObjectURL(item.url);
    state.drafts.delete(id);
    state.listSequence++;
    state.events = state.events.filter((item) => item.id !== id);
    state.event = null; state.selected = null; state.sequence++;
    ui.detail.hidden = true; ui.welcome.hidden = false;
    document.body.classList.remove("detail-open");
    renderList();
    toast("活动已删除");
    await loadList();
  } finally { state.busy = false; updateControls(); }
}
async function persist(compile) {
  if (state.isOffline) return;
  if(narrow.matches)return;
  if (locked() || !state.event) return;
  const id = state.selected, d = draft(id);
  state.busy = true; updateControls();
  try {
    const content = d.text.trim();
    if (content && d.savedText !== content) {
      status("正在保存文字 / 链接…");
      await apiFetch(eventPath(id) + "/items", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
      });
      d.savedText = content;
    }
    const pending = d.images.filter((entry) => !entry.uploaded);
    for (const [index, entry] of pending.entries()) {
      status("正在上传图片 " + (index + 1) + "/" + pending.length + "…");
      const form = new FormData(); form.append("file", entry.file, entry.file.name);
      await apiFetch(eventPath(id) + "/items", { method: "POST", body: form });
      entry.uploaded = true;
      renderQueue(); updateControls();
    }
    // 只有所有上传均成功后清空；失败时保留草稿及已成功项的标记，重试不会重复入栈。
    d.text = ""; d.savedText = null;
    for (const entry of d.images) URL.revokeObjectURL(entry.url);
    d.images = [];
    ui["material-text"].value = ""; renderQueue();
    if (compile) {
      status("正在调用百炼 AI 整理中，约需 3~10 秒…");
      const { event, stats } = await apiFetch(eventPath(id) + "/compile", { method: "POST" });
      state.event = event; renderDetail();
      status("整理完成");
      const isArchived = event.timeline_bucket === "archived";
      state.activeTab = isArchived ? "archived" : "upcoming";
      toast(isArchived ? "该活动时间已过，已自动归入「历史归档」" :
        "整理完成" + (stats ? " · 新分析 " + stats.newly_analyzed_images + " 张图片" : ""), isArchived ? "warning" : "success");
      if (narrow.matches) { ui.composer.open = false; ui.cards.scrollIntoView({ block: "start" }); }
    } else {
      status("素材已暂存，可稍后重新整理");
      toast("素材已暂存");
    }
    await refreshCurrent();
  } catch (error) {
    if (error.status === 401 || !state.authenticated) return;
    status(error.message, true);
    toast(error.message, "error");
    // 刷新已经成功保存的素材，但不丢弃草稿或清空旧编译卡片。
    try { await refreshCurrent(); } catch { /* 保留当前画面及原始错误。 */ }
  } finally { state.busy = false; updateControls(); }
}
async function prepareImage(file) {
  if (!["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片");
  }
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.src = url;
    await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width <= 10 || height <= 10) throw new Error("已忽略微小图片：宽和高都需要大于 10px");
    if (Math.max(width, height) <= 1600 && file.size <= 1.5 * 1024 * 1024) return file;
    const scale = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    if (canvas.width <= 10 || canvas.height <= 10) {
      throw new Error("图片过于狭长，缩小后无法识别，请裁成几张清晰截图再上传");
    }
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理图片，请换一张重试");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片压缩失败，请重试")), "image/jpeg", 0.85);
    });
    if (blob.size > 10 * 1024 * 1024) throw new Error("处理后的图片仍超过 10 MB，请裁剪后重试");
    return new File([blob], (file.name || "image").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (error) {
    if (error.name === "EncodingError") throw new Error("图片无法解码，请换一张有效图片");
    throw error;
  } finally { URL.revokeObjectURL(url); }
}
async function enqueueImages(files) {
  if (state.isOffline) return;
  if(narrow.matches)return;
  if (locked() || !state.event) return;
  const d = draft(), errors = [], generation = state.authGeneration;
  let added = 0;
  state.preparing++; updateControls();
  try {
    status("正在检查图片尺寸与清晰度…");
    for (const file of files) {
      try {
        const prepared = await prepareImage(file);
        if (generation !== state.authGeneration || !state.authenticated) return;
        d.images.push({ file: prepared, url: URL.createObjectURL(prepared), uploaded: false });
        added++;
      } catch (error) { errors.push(error.message || "图片处理失败"); }
    }
    if (generation !== state.authGeneration || !state.authenticated) return;
    renderQueue();
    status(added ? "已加入 " + added + " 张待传图片，点击「保存并整理」开始" : "");
    if (errors.length) toast([...new Set(errors)].join("；"), "warning");
  } finally { state.preparing = Math.max(0, state.preparing - 1); updateControls(); }
}

ui["new-event"].addEventListener("click", () => run(newEvent));
ui["delete-event"].addEventListener("click", () => run(deleteEvent));
ui["save-compile"].addEventListener("click", () => run(() => persist(true)));
ui["save-only"].addEventListener("click", () => run(() => persist(false)));
ui["material-text"].addEventListener("input", () => { draft().text = ui["material-text"].value; updateControls(); });
ui["choose-images"].addEventListener("click", () => ui["image-files"].click());
ui["image-files"].addEventListener("change", () => {
  const files = [...ui["image-files"].files]; ui["image-files"].value = "";
  run(() => enqueueImages(files));
});
ui.composer.addEventListener("paste", (event) => {
  if (locked() || !state.event) return;
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return; // 纯文本保留浏览器原生粘贴行为。
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text) {
    const area = ui["material-text"];
    area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    draft().text = area.value;
  }
  run(() => enqueueImages(files));
});
let dragDepth = 0;
ui.composer.addEventListener("dragenter", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); dragDepth++; ui.composer.classList.add("dragging"); }
});
ui.composer.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
});
ui.composer.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; ui.composer.classList.remove("dragging"); } });
ui.composer.addEventListener("drop", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault(); dragDepth = 0; ui.composer.classList.remove("dragging");
  run(() => enqueueImages([...event.dataTransfer.files]));
});
ui["back-list"].addEventListener("click", () => {
  if (locked()) return;
  document.body.classList.remove("detail-open");
  ui["new-event"].focus();
});
ui["toast-close"].addEventListener("click", () => { ui.toast.hidden = true; });
ui["lightbox-image"].addEventListener("error", () => run(checkImageAuth));
ui["lightbox-close"].addEventListener("click", () => ui.lightbox.close());
ui.lightbox.addEventListener("click", (event) => {
  if (event.target === ui.lightbox || event.target === ui["lightbox-space"]) ui.lightbox.close();
});
ui.lightbox.addEventListener("close", () => {
  document.body.classList.remove("lightbox-open");
  ui["lightbox-image"].removeAttribute("src");
});
narrow.addEventListener("change", () => { if(narrow.matches && ui["field-editor"].open)ui["field-editor"].close();ui.composer.open = !narrow.matches; });
ui["auth-form"].addEventListener("submit", (event) => { event.preventDefault(); run(() => login(event)); });
ui["lock-logout"].addEventListener("click", () => run(logout));
for (const tab of ["upcoming", "archived"]) {
  ui[tab + "-tab"].addEventListener("click", () => switchTab(tab));
  ui[tab + "-tab"].addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || locked()) return;
    event.preventDefault();
    const next = event.key === "Home" ? "upcoming" : event.key === "End" ? "archived" :
      tab === "upcoming" ? "archived" : "upcoming";
    switchTab(next); ui[next + "-tab"].focus();
  });
}
ui["archive-search"].addEventListener("input", () => {
  state.archiveQuery = ui["archive-search"].value; renderList();
});
setInterval(() => {
  if (!state.authenticated) return;
  document.querySelectorAll("[data-countdown]").forEach((node) => {
    const [label, kind] = countdown({ start_time: node.dataset.start, end_time: node.dataset.end },
      { time_state: node.dataset.timeState, timeline_bucket: node.dataset.bucket, effective_end_time: node.dataset.end });
    node.textContent = label; node.className = "badge " + kind;
  });
  if (!state.isOffline && !locked()) loadList().catch(() => { /* 401 由 apiFetch 立即锁屏；短暂离线不反复弹窗。 */ });
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.authenticated && !state.isOffline && !locked()) run(loadList);
});
ui["editor-form"].addEventListener("submit",event=>{event.preventDefault();run(()=>saveEditor(event))});
ui["editor-cancel"].addEventListener("click",closeEditor);
ui["field-editor"].addEventListener("cancel",event=>{if(state.busy)event.preventDefault();else closeEditor()});
ui["field-editor"].addEventListener("close",()=>{editorState=null;ui["editor-fields"].replaceChildren();ui["editor-error"].textContent=""});
ui["calendar-subscribe"].addEventListener("click", () => run(openCalendarDialog));
ui["calendar-close"].addEventListener("click", closeCalendarDialog);
ui["calendar-dialog"].addEventListener("close", () => {
  calendarInfoRequest++; ui["calendar-url"].value = ""; ui["calendar-content"].hidden = true;
});
ui["calendar-copy"].addEventListener("click", () => {
  if (state.authenticated && ui["calendar-url"].value) run(() => copyText(ui["calendar-url"].value));
});
ui["refresh-cache"].addEventListener("click", () => {
  if (!state.isOffline && state.authenticated) run(() => syncUpcomingOfflineCache([], true));
});
window.addEventListener("offline", () => enterOfflineMode());
window.addEventListener("online", () => {
  // 已展示的快照保留到认证结果返回；失败时仍可继续只读。
  if (state.authBusy) return;
  run(checkAuth);
});
run(init);