"use strict";

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "mobile-sync-list", "mobile-sync-detail", "mobile-more-list", "mobile-more-detail",
  "mobile-sheet", "mobile-sheet-title", "mobile-sheet-close", "mobile-sheet-content", "mobile-compile-meta",
  "offline-bar", "offline-text", "refresh-cache",
  "dida-settings", "dida-dot", "dida-dialog", "dida-close", "dida-content", "dida-message", "dida-event-status",
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
const narrow = window.matchMedia("(max-width: 767px)");
const state = {
  isOffline: false, cacheSupported: false, offlineEpoch: 0, offlineMeta: null,
  offlineStatus: "unsupported", swRegistration: null, syncPromise: null, clearPromise: Promise.resolve(),
  events: [], selected: null, event: null, drafts: new Map(),
  authenticated: false, authConfigured: null, authBusy: false, authGeneration: 0,
  activeTab: "upcoming", archiveQuery: "", deepLinkPending: true,
  didaStatus: null, didaBusy: false, didaProjects: [], didaProjectsReady: false, didaProjectsError: "", didaSyncing: new Set(),
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
    ? "已离线就绪 · 同步于 " + syncTime() + " · 已缓存 " + (Number(meta?.upcomingCount) || 0) + " 场即将发生 / " + (Number(meta?.imageCount) || 0) + " 张关键图"
    : mode === "syncing" ? "正在同步离线缓存..."
    : mode === "pending" ? "正在准备离线缓存…"
    : mode === "offline" ? "当前离线模式 · 正在查看本地缓存副本（同步于 " + syncTime() + "）"
    : mode === "unsupported" ? "当前环境不支持离线缓存，请使用 HTTPS 或本机 localhost / 127.0.0.1"
    : "离线同步未完成，请联网后刷新缓存");
  paintCompactSync();
  ui["refresh-cache"].disabled = !state.authenticated || state.isOffline || !state.cacheSupported || mode === "syncing";
}
function enterOfflineMode() {
  if (!state.authenticated) return;
  state.isOffline = true;
  if (ui["field-editor"].open) ui["field-editor"].close();
  closeCalendarDialog(); closeDidaDialog();
  paintOfflineStatus("offline"); updateControls();
}
function clearAllOfflineData(notify = true) {
  state.offlineEpoch++;
  state.offlineMeta = null; state.syncPromise = null;
  dismissedNotices.clear();
  for (const key of [OFFLINE_META_KEY, LOCAL_CHECKS_KEY, CHANGE_NOTICE_KEY]) {
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
  const located = await locateEventFromUrl();
  if (!located && available.length) await selectEvent(available[0].id);
  run(didaWorkspaceReady);
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
  paintOfflineStatus("pending");
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
  closeMobileSheet(); ui["mobile-compile-meta"].textContent = "";
  closeCalendarDialog(); closeDidaDialog();
  didaStatusRequest++; didaStatusPending = null; state.didaStatus = null; state.didaBusy = false; state.didaSyncing.clear();
  state.didaProjects = []; state.didaProjectsReady = false; state.didaProjectsError = "";
  state.deepLinkPending = true;
  ui["dida-event-status"].replaceChildren(); ui["dida-event-status"].hidden = true;
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
  try {
    const hadSelection = Boolean(state.selected && state.event);
    await loadList();
    if (hadSelection && state.selected && state.event) await refreshCurrent();
    if (state.authenticated && workspaceGeneration === state.authGeneration) run(didaWorkspaceReady);
  }
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
  setEventUrl(null);
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
  parent.append(box);
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
async function patchOverrides(payload, message, fromEditor=false, conflictOnly=false) {
  if (state.isOffline) return;
  const conflictKey = Object.keys(payload || {});
  const safeConflict = conflictOnly && conflictKey.length === 1 &&
    ["unlock", "dismiss_conflicts"].includes(conflictKey[0]) &&
    Array.isArray(payload[conflictKey[0]]) && payload[conflictKey[0]].length === 1 &&
    list(state.event?.pending_conflicts).some(item => item.field === payload[conflictKey[0]][0]);
  if((narrow.matches && !safeConflict)||locked()||!state.event)return;
  const id=state.selected,generation=state.authGeneration;
  state.busy=true;updateControls();ui["editor-save"].disabled=true;
  try {
    const result=await apiFetch(eventPath(id)+"/overrides",{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),
    });
    if(generation!==state.authGeneration||id!==state.selected)return;
    const event = { ...result.event, dida_sync: result.dida_sync ?? result.event.dida_sync ?? null };
    state.event=event;state.activeTab=event.timeline_bucket==="archived"?"archived":"upcoming";
    state.events=state.events.map(item=>item.id===id?{...event,raw_count:list(event.raw_items).length}:item);
    state.busy=false;
    if(fromEditor)closeEditor();
    state.busy=true;
    renderDetail();renderList();didaSavedNotice(event.dida_sync,message);
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
  await locateEventFromUrl();
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
  document.querySelectorAll("[data-conflict-action]").forEach(node => { node.disabled = locked(); });
  for (const id of ["mobile-more-list", "mobile-more-detail"]) ui[id].disabled = locked();
  paintOfflineStatus(); updateDidaControls();
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
  state.selected = id; setEventUrl(id);
  const summary = state.events.find(event => event.id === id);
  if (summary) state.activeTab = summary.timeline_bucket === "archived" ? "archived" : "upcoming";
  state.event = null; renderDidaSync();
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
  ui["mobile-compile-meta"].textContent = ui["compile-meta"].textContent;
  ui.composer.hidden = false;
  renderQueue();
  renderCards(event);
  renderArchive(event); renderDidaSync();
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
      narrow.matches ? "活动尚未整理，请在电脑端补充素材并整理，原始素材仍可在下方查看。" : "把活动通知、截图或二维码粘贴到上方，点击「保存并整理」即可生成现场卡片"));
    return;
  }
  const data = object(presentation(event)), core = object(data.l1_core), modules = object(data.l2_modules);
  if (narrow.matches) { renderMobileCore(event); renderModules(event, data, modules); return; }
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
  renderModules(event, data, modules);
}
function renderModules(event, data, modules) {
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
  const gallery = narrow.matches ? el("div", "raw-gallery") : null;
  if (gallery && items.some(item => item.type === "image")) ui.archive.append(gallery);
  for (const item of [...items].reverse()) {
    const row = el("article", "raw-item" + (item.type === "image" ? " raw-image-item" : "")), header = el("div", "raw-header");
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
    if (item.type === "image") row.append(imageButton(narrow.matches ? {...item,content:"原始图片 · " + localTime(item.created_at)} : item, "raw-image"));
    if (words(item.content) && !(narrow.matches && item.type === "image")) {
      const url = item.type === "url" ? validLink(item.content) : null;
      row.append(url ? externalLink(item.content, url, "raw-text") : el("p", "raw-text raw-caption", item.content));
    }
    if (gallery && item.type === "image") gallery.append(row); else ui.archive.append(row);
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
    state.event = null; state.selected = null; state.sequence++; setEventUrl(null); renderDidaSync();
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
      const result = await apiFetch(eventPath(id) + "/compile", { method: "POST" });
      const event = { ...result.event, dida_sync: result.dida_sync ?? result.event.dida_sync ?? null }, stats = result.stats;
      state.event = event; renderDetail();
      status("整理完成");
      const isArchived = event.timeline_bucket === "archived";
      state.activeTab = isArchived ? "archived" : "upcoming";
      didaSavedNotice(event.dida_sync, isArchived ? "该活动时间已过，已自动归入「历史归档」" :
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
  clearSelection();
  ui["upcoming-tab"].focus();
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
narrow.addEventListener("change", () => {
  if (narrow.matches) {
    if (ui["field-editor"].open) ui["field-editor"].close();
    closeDidaDialog();
  } else if (ui["dida-dialog"].open) run(openDidaDialog);
  closeMobileSheet();
  ui.composer.open = !narrow.matches; if (state.event) renderDetail(); renderList(); renderDidaSync(); updateControls();
});
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
ui["dida-settings"].addEventListener("click", () => run(openDidaDialog));
ui["dida-close"].addEventListener("click", closeDidaDialog);
ui["dida-dialog"].addEventListener("close", () => {
  didaDialogRequest++; ui["dida-content"].replaceChildren(); ui["dida-message"].textContent = "";
});
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
function setEventUrl(id) {
  const url = new URL(window.location.href);
  url.pathname = "/";
  if (id) url.searchParams.set("event", id); else url.searchParams.delete("event");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}
async function locateEventFromUrl() {
  if (!state.deepLinkPending || locked()) return false;
  state.deepLinkPending = false;
  const id = new URL(window.location.href).searchParams.get("event");
  if (!id) return false;
  const event = state.events.find(item => item.id === id);
  if (!event) { toast("链接中的活动不存在或当前列表尚未缓存该活动", "warning"); return true; }
  state.activeTab = event.timeline_bucket === "archived" ? "archived" : "upcoming";
  state.archiveQuery = ""; ui["archive-search"].value = "";
  await selectEvent(id);
  return true;
}
function clearSelection() {
  state.sequence++; state.selected = null; state.event = null; state.loading = false;
  ui.detail.hidden = true; ui.welcome.hidden = false; ui["detail-loading"].hidden = true;
  ui.cards.replaceChildren(); ui.archive.replaceChildren();
  ui["dida-event-status"].replaceChildren(); ui["dida-event-status"].hidden = true;
  document.body.classList.remove("detail-open");
  setEventUrl(null); renderList(); updateControls();
}
const DIDA_ROOT = "/api/integrations/dida";
let didaStatusRequest = 0, didaDialogRequest = 0, didaStatusPending = null;
function didaErrorText(value) {
  return words(value).replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[已脱敏]")
    .replace(/((?:access_token|refresh_token|client_secret)["']?\s*[:=]\s*)["']?[^\s,"'<>}&]+/gi, "$1[已脱敏]")
    .replace(/sk-[A-Za-z0-9_.-]+/g, "[已脱敏]").slice(0, 200);
}
function updateDidaControls() {
  const disabled = !state.authenticated || state.isOffline || state.didaBusy || narrow.matches;
  ui["dida-settings"].disabled = !state.authenticated || state.isOffline;
  const connected = state.didaStatus?.connected === true;
  ui["dida-dot"].classList.toggle("connected", connected);
  ui["dida-settings"].setAttribute("aria-label", "滴答同步：" + (connected ? "已连接" : "未连接或状态未知"));
  ui["dida-settings"].title = state.isOffline ? "联网后管理滴答连接" : connected ? "滴答清单已连接" : "设置滴答清单同步";
  ui["dida-dialog"].setAttribute("aria-busy", String(state.didaBusy));
  ui["dida-content"].querySelectorAll("[data-dida-action]").forEach(node => {
    node.disabled = disabled || (node.dataset.requiresProjects === "true" && !state.didaProjectsReady);
  });
  document.querySelectorAll("[data-dida-sync]").forEach(node => {
    node.disabled = writeLocked() || state.loading || narrow.matches || !connected || state.didaBusy || state.didaSyncing.has(state.selected);
  });
}
function renderDidaSync() {
  paintMobileDidaBadge();
  const region = ui["dida-event-status"], event = state.event;
  region.replaceChildren(); region.hidden = !event;
  if (!event) return;
  const sync = event.dida_sync, connected = state.didaStatus?.connected === true;
  const status = sync?.status;
  const label = status === "synced" ? "已同步滴答" : status === "skipped_no_time" ? "无时间·未推滴答"
    : status === "failed" ? "滴答同步失败" : connected ? "未同步滴答" : "";
  if (!label) { region.hidden = true; return; }
  const badge = el("span", "badge dida-badge " + (status === "synced" ? "dida-synced" : status === "failed" ? "dida-failed" : ""), label);
  if (status === "synced" && sync.synced_at) badge.title = "同步于 " + sync.synced_at;
  if (status === "failed") badge.title = didaErrorText(sync.last_error) || "稍后可在电脑端重试";
  region.append(badge);
  if (connected) {
    const pending = state.didaSyncing.has(event.id);
    const action = button(pending ? "正在同步…" : status === "failed" ? "重试同步" : "同步滴答", "ghost pc-only dida-sync-button", syncCurrentToDida);
    action.dataset.didaSync = ""; region.append(action);
  }
  if (status === "failed" && sync.last_error) region.append(el("span", "dida-sync-error pc-only", didaErrorText(sync.last_error)));
  updateDidaControls();
}
async function refreshDidaStatus() {
  if (!state.authenticated || state.isOffline) return null;
  const generation = state.authGeneration;
  if (didaStatusPending?.generation === generation) return didaStatusPending.promise;
  const sequence = ++didaStatusRequest;
  const pending = (async () => {
    const data = await apiFetch(DIDA_ROOT + "/status", { cache: "no-store" });
    if (sequence !== didaStatusRequest || generation !== state.authGeneration || !state.authenticated) return null;
    state.didaStatus = { configured: data.configured === true, connected: data.connected === true,
      target_project_id: words(data.target_project_id), target_project_name: words(data.target_project_name),
      updated_at: words(data.updated_at), expires_at: words(data.expires_at) };
    renderDidaSync(); updateDidaControls();
    return state.didaStatus;
  })().finally(() => { if (didaStatusPending?.promise === pending) didaStatusPending = null; });
  didaStatusPending = { generation, promise: pending };
  return pending;
}
function closeDidaDialog() {
  didaDialogRequest++;
  if (ui["dida-dialog"].open) ui["dida-dialog"].close();
  ui["dida-content"].replaceChildren(); ui["dida-message"].textContent = "";
}
function didaAction(label, kind, action, needsProjects = false) {
  const node = button(label, kind + " pc-only", action);
  node.dataset.didaAction = "";
  if (needsProjects) node.dataset.requiresProjects = "true";
  return node;
}
function paintDidaPanel() {
  if (!ui["dida-dialog"].open || !state.authenticated) return;
  const area = ui["dida-content"], config = state.didaStatus;
  area.replaceChildren();
  if (!config) {
    area.append(didaAction("重新读取状态", "ghost", openDidaDialog)); updateDidaControls(); return;
  }
  if (narrow.matches) {
    area.append(el("span", "badge " + (config.connected ? "dida-synced" : ""), config.connected ? "已连接" : "未连接滴答"));
    if (config.connected) area.append(el("p", "", "当前清单：" + (config.target_project_id ? config.target_project_name || config.target_project_id : "收集箱（默认）")));
    area.append(el("p", "helper", "手机端仅查看同步状态，请在电脑端连接滴答或选择目标清单。"));
    updateDidaControls(); return;
  }
  if (!config.configured) {
    area.append(el("p", "helper", "尚未配置滴答应用。请在服务端设置 DIDA_CLIENT_ID 与 DIDA_CLIENT_SECRET 后重试。"),
      didaAction("重新读取状态", "ghost", openDidaDialog));
  } else if (!config.connected) {
    area.append(el("p", "helper", "连接后，整理活动或微调时间会自动写入滴答。已有活动可在电脑端点击「同步滴答」补推。"),
      didaAction("一键连接滴答清单", "primary", connectDida));
  } else {
    const summary = el("div", "dida-connection");
    summary.append(el("span", "badge dida-synced", "已连接"),
      el("p", "", "当前清单：" + (config.target_project_id ? config.target_project_name || config.target_project_id : "收集箱（默认）")),
      el("p", "helper", "更新于 " + (config.updated_at ? localTime(config.updated_at) : "时间未知")));
    area.append(summary);
    const label = el("label", "", "目标清单"); label.htmlFor = "dida-project-select";
    const select = el("select", "dida-project-select"); select.id = "dida-project-select";
    select.dataset.didaAction = ""; select.dataset.requiresProjects = "true";
    const inbox = el("option", "", "收集箱（默认）"); inbox.value = ""; select.append(inbox);
    for (const project of state.didaProjects) {
      const option = el("option", "", words(project.name) || project.id); option.value = project.id; select.append(option);
    }
    if (config.target_project_id && !state.didaProjects.some(project => project.id === config.target_project_id)) {
      const option = el("option", "", (config.target_project_name || "当前清单") + "（尚未读取或不可用）");
      option.value = config.target_project_id; option.disabled = true; select.append(option);
    }
    select.value = config.target_project_id;
    area.append(label, select);
    if (!state.didaProjectsReady && !state.didaProjectsError) area.append(el("p", "helper", "正在读取可用清单…"));
    if (state.didaProjectsError) {
      const error = el("p", "auth-message", state.didaProjectsError); error.setAttribute("role", "alert"); area.append(error);
    }
    area.append(didaAction("保存目标清单", "primary", () => saveDidaTarget(select), true),
      el("p", "helper", "保存后，下次整理、微调或手动同步时会使用此清单。"));
    const actions = el("div", "inline-actions");
    if (state.didaProjectsError) actions.append(didaAction("重新读取清单", "ghost", openDidaDialog));
    actions.append(didaAction("重新授权", "ghost", connectDida), didaAction("断开连接", "ghost danger", disconnectDidaConnection));
    area.append(actions);
  }
  updateDidaControls();
}
async function openDidaDialog() {
  if (!state.authenticated || state.isOffline || state.didaBusy) return;
  closeCalendarDialog();
  const request = ++didaDialogRequest, generation = state.authGeneration;
  state.didaProjects = []; state.didaProjectsReady = false; state.didaProjectsError = "";
  ui["dida-content"].replaceChildren(); ui["dida-message"].textContent = "正在读取滴答同步设置…"; ui["dida-message"].dataset.kind = "";
  if (!ui["dida-dialog"].open) ui["dida-dialog"].showModal();
  const current = () => request === didaDialogRequest && generation === state.authGeneration && ui["dida-dialog"].open && !state.isOffline;
  try {
    const config = await refreshDidaStatus();
    if (!current() || !config) return;
    ui["dida-message"].textContent = ""; paintDidaPanel();
    if (!config.configured || !config.connected || narrow.matches) return;
    try {
      const data = await apiFetch(DIDA_ROOT + "/projects", { cache: "no-store" });
      if (!current()) return;
      state.didaProjects = list(data.projects).filter(project => typeof project?.id === "string");
      state.didaProjectsReady = true;
    } catch (error) {
      if (!current() || error.status === 401) return;
      state.didaProjectsError = didaErrorText(error.message) || "清单读取失败，请重新授权后重试";
    }
    if (current()) paintDidaPanel();
  } catch (error) {
    if (current() && error.status !== 401) {
      state.didaStatus = null; ui["dida-message"].textContent = didaErrorText(error.message); renderDidaSync(); paintDidaPanel();
    }
  }
}
async function didaMutation(action) {
  if (!state.authenticated || state.isOffline || state.didaBusy || narrow.matches) return;
  const generation = state.authGeneration;
  state.didaBusy = true; updateDidaControls(); ui["dida-message"].textContent = ""; ui["dida-message"].dataset.kind = "";
  try { await action(generation); }
  catch (error) {
    if (generation === state.authGeneration && error.status !== 401 && state.authenticated) {
      const message = didaErrorText(error.message) || "操作失败，请稍后重试";
      if (ui["dida-dialog"].open) ui["dida-message"].textContent = message;
      else toast(message, "error");
    }
  } finally { if (generation === state.authGeneration) { state.didaBusy = false; updateDidaControls(); } }
}
async function connectDida() {
  return didaMutation(async generation => {
    const data = await apiFetch(DIDA_ROOT + "/authorize", { method: "POST" });
    if (generation !== state.authGeneration || !state.authenticated || state.isOffline || narrow.matches) return;
    const url = new URL(data.authorize_url);
    if (url.origin !== "https://dida365.com" || url.pathname !== "/oauth/authorize") throw new Error("滴答授权地址无效，请重新读取设置");
    window.location.assign(url.href);
  });
}
async function saveDidaTarget(select) {
  if (narrow.matches || !state.didaProjectsReady || select.selectedOptions[0]?.disabled) return;
  const id = select.value, name = id ? state.didaProjects.find(project => project.id === id)?.name || "" : "";
  return didaMutation(async generation => {
    await apiFetch(DIDA_ROOT + "/config", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_project_id: id, target_project_name: name }) });
    if (generation !== state.authGeneration) return;
    didaStatusRequest++; didaStatusPending = null;
    await refreshDidaStatus();
    if (generation !== state.authGeneration || state.isOffline) return;
    paintDidaPanel(); ui["dida-message"].textContent = "目标清单已保存"; ui["dida-message"].dataset.kind = "success";
    toast("滴答目标清单已保存");
  });
}
async function disconnectDidaConnection() {
  if (narrow.matches || !state.authenticated || state.isOffline || state.didaBusy || !confirm("确定断开滴答清单？已有任务会保留，后续活动将不再自动同步。")) return;
  return didaMutation(async generation => {
    await apiFetch(DIDA_ROOT + "/disconnect", { method: "POST" });
    if (generation !== state.authGeneration) return;
    state.didaStatus = null; didaStatusRequest++; didaStatusPending = null; await refreshDidaStatus();
    if (generation !== state.authGeneration) return;
    paintDidaPanel(); toast("已断开滴答连接，已有任务保留");
  });
}
function didaSavedNotice(sync, successMessage, successKind = "success") {
  if (sync?.status === "failed") {
    toast("看板已保存成功，仅滴答同步失败；可稍后在电脑端点击「重试同步」。", "warning");
  } else toast(successMessage, successKind);
}
async function syncCurrentToDida() {
  if (narrow.matches || writeLocked() || state.loading || !state.event || !state.didaStatus?.connected || state.didaBusy) return;
  const id = state.selected, generation = state.authGeneration;
  if (state.didaSyncing.has(id)) return;
  state.didaSyncing.add(id); renderDidaSync();
  try {
    const data = await apiFetch(eventPath(id) + "/sync/dida", { method: "POST" });
    if (generation !== state.authGeneration || !state.authenticated) return;
    state.listSequence++;
    const sync = data.dida_sync ?? null;
    state.events = state.events.map(event => event.id === id ? { ...event, dida_sync: sync } : event);
    if (state.selected === id && state.event) { state.event = { ...state.event, dida_sync: sync }; renderDidaSync(); }
    if (sync?.status === "failed") toast("滴答同步失败：" + (didaErrorText(sync.last_error) || "稍后请重试"), "warning");
    else if (sync?.status === "skipped_no_time") toast("活动尚无明确开始时间，暂未推送滴答", "warning");
    else if (sync?.status === "synced") toast("已同步滴答清单");
    else toast("尚未连接滴答清单，请重新读取同步设置", "warning");
    // 读取最新详情也让 SW 更新私有缓存；失败不覆盖刚收到的同步结果。
    try {
      const latest = await apiFetch(eventPath(id));
      if (generation === state.authGeneration && state.selected === id && state.event) {
        state.event = { ...state.event, dida_sync: latest.event?.dida_sync ?? sync }; renderDidaSync();
      }
    } catch { /* 同步结果已经显示，稍后可刷新离线缓存。 */ }
  } catch (error) {
    if (generation === state.authGeneration && error.status !== 401) toast(didaErrorText(error.message), "error");
  } finally {
    if (generation === state.authGeneration) { state.didaSyncing.delete(id); renderDidaSync(); updateControls(); }
  }
}
async function didaWorkspaceReady() {
  if (!state.authenticated) return;
  const generation = state.authGeneration, url = new URL(window.location.href), result = url.searchParams.get("dida");
  if (result) {
    const reason = url.searchParams.get("reason");
    url.searchParams.delete("dida"); url.searchParams.delete("reason");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    if (result === "connected") toast("滴答清单连接成功");
    else if (result === "error") {
      const reasons = {
        invalid_state: "授权校验已失效，请重新连接滴答清单",
        authorization_denied: "滴答授权未完成，请重新连接",
        token_exchange_failed: "滴答换票失败，请查看服务端诊断后重新连接",
        token_response_invalid: "滴答换票响应缺少有效凭据，请重新连接",
        integration_save_failed: "滴答授权结果保存失败，请检查数据库后重新连接",
        callback_failed: "滴答授权回调处理失败，请重新连接",
        unauthorized: "本地登录会话已失效，请登录后重新连接",
        authorization_failed: "滴答授权失败，请检查应用配置后重新连接",
      };
      // 只展示白名单短码，未知 Query 内容不能混入诊断提示。
      const shortReason = Object.hasOwn(reasons, reason) ? reason : "unknown";
      toast((reasons[shortReason] || "滴答授权失败，请打开同步设置重新连接") + "（原因码：" + shortReason + "）", "error");
    }
  }
  if (state.isOffline) return;
  try {
    const config = await refreshDidaStatus();
    if (generation === state.authGeneration && config?.connected && !config.target_project_id && result === "connected") await openDidaDialog();
  } catch (error) {
    if (generation === state.authGeneration && error.status !== 401 && result === "connected") toast("已收到滴答连接回执，暂时无法读取设置，请联网后重试", "warning");
  }
}


// Mobile presentation reuses the same event, auth and write pipeline as desktop.
const CHANGE_NOTICE_KEY = "eb_change_notices_v1";
const dismissedNotices = new Map();
let sheetOpener = null;
const iconPaths = {
  more: "M5 12h.01M12 12h.01M19 12h.01",
  back: "m12 5-7 7 7 7M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  route: "m21 3-6 18-4-8-8-4 18-6Z",
  copy: "M9 9h11v11H9zM5 15H3V3h12v2",
  calendar: "M4 5h16v16H4zM8 3v4m8-4v4M4 11h16",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  lock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3",
  check: "m5 12 4 4L19 6",
  warning: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
  info: "M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  chevron: "m6 9 6 6 6-6",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", "stroke-width":"1.8", "stroke-linecap":"round", "stroke-linejoin":"round", "aria-hidden":"true", focusable:"false" })) svg.setAttribute(key, value);
  svg.classList.add("ui-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPaths[name] || iconPaths.info); svg.append(path);
  return svg;
}
function touchButton(label, glyph, className, action) {
  const node = button("", className, action);
  node.append(icon(glyph), el("span", "", label)); return node;
}
function readableChange(value) {
  if (typeof value !== "string") return valueDisplay(value);
  return value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g, raw => {
    const ms = timestamp(raw);
    return ms === null ? raw : new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai", month:"long", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false}).format(ms);
  });
}
function changeFingerprint(event) {
  // Canonical fields ignore response key order and unrelated compile metadata.
  const text = JSON.stringify(list(presentation(event)?.l1_core?.change_alerts).map(entry =>
    [entry?.field ?? null, entry?.old_value ?? null, entry?.new_value ?? null, entry?.reason ?? null]));
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return (a >>> 0).toString(16).padStart(8,"0") + (b >>> 0).toString(16).padStart(8,"0") + ":" + text.length;
}
function noticeIgnored(event) {
  const fingerprint = changeFingerprint(event), saved = object(readLocal(CHANGE_NOTICE_KEY, {}));
  return dismissedNotices.get(event.id) === fingerprint ||
    (Object.hasOwn(saved, event.id) && saved[event.id] === fingerprint);
}
function dismissChanges(event) {
  if (!state.authenticated || event.id !== state.selected) return;
  const fingerprint = changeFingerprint(event), saved = object(readLocal(CHANGE_NOTICE_KEY, {}));
  dismissedNotices.set(event.id, fingerprint);
  Object.defineProperty(saved, event.id, {value:fingerprint, enumerable:true, configurable:true, writable:true});
  try { writeLocal(CHANGE_NOTICE_KEY, saved); toast("已隐藏这次变更提醒，可在更多菜单中查看"); }
  catch { toast("已暂时隐藏提醒；浏览器未允许保存已读状态", "warning"); }
  renderCards(state.event);
  updateControls();
}
function appendChanges(parent, event) {
  for (const entry of list(presentation(event)?.l1_core?.change_alerts)) {
    const item = object(entry), row = el("div", "notice-entry");
    row.append(el("h3", "", fieldNames[item.field] || words(item.field) || "活动信息"),
      el("p", "change-before", "此前 · " + readableChange(item.old_value)),
      el("p", "change-after", "现在 · " + readableChange(item.new_value)));
    if (words(item.reason)) row.append(el("p", "helper", item.reason));
    parent.append(row);
  }
}
async function resolveMobileConflict(field, decision) {
  if (state.isOffline) { toast("离线状态下暂无法提交，联网后可一键处理", "warning"); return; }
  if (locked() || !list(state.event?.pending_conflicts).some(item => item.field === field)) return;
  if (!['keep','ai'].includes(decision)) return;
  await patchOverrides(decision === "ai" ? {unlock:[field]} : {dismiss_conflicts:[field]}, "已解决冲突", false, true);
}
function renderMobileNotices(event) {
  const wrap = el("div", "mobile-notices"), conflicts = list(event.pending_conflicts);
  if (conflicts.length) {
    const details = el("details", "notice notice-conflict"), summary = el("summary", "notice-summary");
    summary.append(icon("warning"), el("span", "", "有 " + conflicts.length + " 项字段冲突待确认"), el("span", "notice-prompt", "去处理"), icon("chevron"));
    details.append(summary);
    const body = el("div", "notice-body");
    for (const conflict of conflicts) {
      const row = el("div", "notice-entry");
      row.append(el("h3", "", words(conflict.label) || "字段"),
        el("p", "conflict-value", "我的锁定值\n" + readableChange(conflict.current_value)),
        el("p", "conflict-value", "AI 最新值\n" + readableChange(conflict.ai_value)));
      const actions = el("div", "conflict-actions");
      const keep = touchButton("保留我的锁定值", "lock", "secondary", () => resolveMobileConflict(conflict.field, "keep"));
      const accept = touchButton("采用 AI 最新值", "check", "primary", () => resolveMobileConflict(conflict.field, "ai"));
      for (const action of [keep, accept]) { action.dataset.conflictAction = ""; action.disabled = locked(); actions.append(action); }
      row.append(actions); body.append(row);
    }
    details.append(body); wrap.append(details);
  }
  if (list(presentation(event)?.l1_core?.change_alerts).length && !noticeIgnored(event)) {
    const row = el("div", "notice-change-row"), details = el("details", "notice notice-change"), summary = el("summary", "notice-summary");
    summary.append(icon("info"), el("span", "", "活动信息有最新变更"), el("span", "notice-prompt", "查看"), icon("chevron"));
    details.append(summary);
    const body = el("div", "notice-body"); appendChanges(body, event);
    body.append(touchButton("我知道了，隐藏提示", "check", "secondary", () => dismissChanges(event)));
    details.append(body);
    const dismiss = touchButton("", "close", "notice-dismiss", () => dismissChanges(event));
    dismiss.setAttribute("aria-label", "隐藏最新变更提醒"); dismiss.title = "隐藏本次变更提醒";
    row.append(details, dismiss); wrap.append(row);
  }
  if (wrap.childElementCount) ui.cards.append(wrap);
}
function mobileDidaBadge(event) {
  const status = event.dida_sync?.status;
  const label = status === "synced" ? "已同步滴答" : status === "failed" ? "滴答同步失败" : status === "skipped_no_time" ? "无时间·未推滴答" : state.didaStatus?.connected ? "未同步滴答" : "";
  const node = el("span", "badge dida-badge " + (status === "synced" ? "dida-synced" : status === "failed" ? "dida-failed" : ""), label);
  node.hidden = !label;
  node.title = status === "synced" ? "同步于 " + localTime(event.dida_sync.synced_at) : status === "failed" ? didaErrorText(event.dida_sync.last_error) : label;
  return node;
}
function paintMobileDidaBadge() {
  const target = document.getElementById("mobile-dida-badge");
  if (target && state.event) target.replaceChildren(mobileDidaBadge(state.event));
}
function renderMobileCore(event) {
  const core = object(presentation(event)?.l1_core), hero = el("section", "card mobile-hero");
  const heading = el("div", "hero-heading"), badge = el("span", "mobile-dida-slot"); badge.id = "mobile-dida-badge";
  badge.append(mobileDidaBadge(event));
  heading.append(el("h2", "core-title", words(core.title) || "未命名活动"), badge); hero.append(heading);
  const time = el("div", "hero-time");
  time.append(el("p", "", words(core.time_display) || "时间待定"), countdownBadge(core, event)); hero.append(time);
  const name = words(core.location_name), address = words(core.location_address), full = [name,address].filter(Boolean).join(" ");
  if (name || address) {
    const location = el("div", "hero-location");
    if (name) location.append(el("p", "location-name", name));
    if (address) location.append(el("p", "location-address", address));
    hero.append(location);
  }
  const actions = el("div", "hero-actions");
  if (full) {
    const nav = externalLink("", "https://uri.amap.com/search?keyword=" + encodeURIComponent(full), "button primary");
    nav.append(icon("route"), el("span", "", "高德导航"));
    actions.append(nav, touchButton("复制地址", "copy", "secondary", () => copyText(full)));
  }
  const calendar = touchButton("导出 .ics", "calendar", "secondary", exportCalendar);
  calendar.dataset.calendarExport = "";
  calendar.title = timestamp(core.start_time) === null ? "时间待定，明确时间后可导出" : "导出到系统日历";
  actions.append(calendar); hero.append(actions); ui.cards.append(hero);
  renderMobileNotices(event);
  const credentials = [...new Set(list(core.credential_item_ids))].map(id => list(event.raw_items).find(item => item.id === id && item.type === "image" && imageUrl(item))).filter(Boolean);
  if (credentials.length) {
    const section = card("入场凭证 / 签到码"); section.classList.add("credential-card");
    for (const [index, item] of credentials.entries()) {
      const image = imageButton({...item,content:"入场凭证 " + (index + 1)}, "credential-image");
      const action = touchButton(credentials.length > 1 ? "全屏亮码 · 凭证 " + (index + 1) : "一键亮码", "expand", "primary credential-open", () => openImage(imageUrl(item), "入场凭证 " + (index + 1)));
      section.append(image, action);
    }
    ui.cards.append(section);
  }
  if (list(core.must_know).length) { const rules = card("入场前务必确认"); rules.classList.add("mobile-rules"); addTags(rules, core.must_know); ui.cards.append(rules); }
}
function paintCompactSync() {
  const mode = state.offlineStatus, label = mode === "ready" ? "离线就绪" : mode === "syncing" ? "同步中" : mode === "pending" ? "准备缓存" : mode === "offline" ? "离线副本" : mode === "unsupported" ? "离线未就绪" : "待同步";
  for (const id of ["mobile-sync-list", "mobile-sync-detail"]) {
    const node = ui[id]; node.dataset.state = mode;
    node.replaceChildren(el("span", "sync-dot"), el("span", "", label));
    node.setAttribute("aria-label", label + "，查看缓存状态"); node.disabled = !state.authenticated;
  }
}
function closeMobileSheet() { if (ui["mobile-sheet"].open) ui["mobile-sheet"].close(); }
function openMobileSheet(view = "menu", opener = null) {
  if (!state.authenticated || !narrow.matches) return;
  sheetOpener = opener || document.activeElement;
  const content = ui["mobile-sheet-content"]; content.replaceChildren();
  ui["mobile-sheet-title"].textContent = view === "sync" ? "离线缓存" : view === "changes" ? "已忽略的变更提醒" : view === "logout" ? "锁定看板" : "更多操作";
  if (view === "sync") {
    const meta = state.offlineMeta;
    content.append(el("p", "sheet-description", ui["offline-text"].textContent),
      el("p", "helper", meta ? "上次同步 " + localTime(meta.lastSyncAt) + " · " + (Number(meta.upcomingCount)||0) + " 场活动 · " + (Number(meta.imageCount)||0) + " 张关键图" : "联网后同步，即可在现场离线查看已缓存的活动和凭证。"));
    const refresh = touchButton("刷新缓存", "refresh", "primary sheet-action", refreshMobileCache);
    refresh.disabled = state.isOffline || !state.cacheSupported || state.offlineStatus === "syncing"; content.append(refresh);
  } else if (view === "changes") {
    if (state.event && list(presentation(state.event)?.l1_core?.change_alerts).length) {
      appendChanges(content, state.event);
      content.append(touchButton("重新显示提醒", "refresh", "secondary sheet-action", () => {
        const saved = object(readLocal(CHANGE_NOTICE_KEY, {})); delete saved[state.event.id]; dismissedNotices.delete(state.event.id);
        try { writeLocal(CHANGE_NOTICE_KEY, saved); } catch { toast("浏览器未允许保存，重新打开时可能仍隐藏", "warning"); }
        closeMobileSheet(); renderCards(state.event); updateControls();
      }));
    } else content.append(el("p", "sheet-description", "当前活动没有变更提醒。"));
  } else if (view === "logout") {
    content.append(el("p", "sheet-description", "锁定后会清除本机私密活动缓存。下次打开需重新输入访问口令。"));
    content.append(touchButton("确认锁定并清理缓存", "lock", "secondary danger sheet-action", async () => { closeMobileSheet(); await logout(); }),
      touchButton("继续查看", "back", "secondary sheet-action", closeMobileSheet));
  } else {
    if (state.event) {
      const exp = touchButton("导出日程 .ics", "calendar", "secondary sheet-action", () => { closeMobileSheet(); return exportCalendar(); });
      exp.dataset.calendarExport = ""; content.append(exp);
      content.append(touchButton("查看已忽略的变更提醒", "info", "secondary sheet-action", () => openMobileSheet("changes", sheetOpener)));
    }
    const subscription = touchButton("日历订阅", "calendar", "secondary sheet-action", () => { closeMobileSheet(); return openCalendarDialog(); });
    subscription.disabled = state.isOffline; content.append(subscription,
      touchButton("离线状态与刷新缓存", "refresh", "secondary sheet-action", () => openMobileSheet("sync", sheetOpener)),
      touchButton("锁定退出", "lock", "secondary danger sheet-action", () => openMobileSheet("logout", sheetOpener)));
    if (state.event) content.append(el("p", "helper sheet-meta", ui["compile-meta"].textContent));
  }
  if (!ui["mobile-sheet"].open) ui["mobile-sheet"].showModal();
  updateControls(); ui["mobile-sheet-close"].focus();
}
async function refreshMobileCache() {
  if (state.isOffline) { toast("请联网后刷新缓存", "warning"); return; }
  closeMobileSheet(); await syncUpcomingOfflineCache([], true);
}
function setupMobileControls() {
  for (const id of ["mobile-more-list", "mobile-more-detail"]) {
    ui[id].append(icon("more")); ui[id].addEventListener("click", () => openMobileSheet("menu", ui[id]));
  }
  for (const id of ["mobile-sync-list", "mobile-sync-detail"]) ui[id].addEventListener("click", () => openMobileSheet("sync", ui[id]));
  ui["back-list"].replaceChildren(icon("back"), el("span", "", "返回"));
  ui["mobile-sheet-close"].append(icon("close"));
  ui["lightbox-close"].replaceChildren(icon("close"));
  ui["mobile-sheet-close"].addEventListener("click", closeMobileSheet);
  ui["mobile-sheet"].addEventListener("click", event => { if (event.target === ui["mobile-sheet"]) closeMobileSheet(); });
  ui["mobile-sheet"].addEventListener("close", () => {
    ui["mobile-sheet-content"].replaceChildren();
    if (state.authenticated) sheetOpener?.focus(); sheetOpener = null;
  });
}
setupMobileControls();

run(init);
