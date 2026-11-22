"use strict";
const SHELL_CACHE = "eb-shell-v4";
const PRIVATE_CACHE = "eb-private-v1";
const SHELL_ASSETS = ["/", "/styles.css", "/app.js", "/manifest.json", "/icon.svg", "/icon-192.png", "/icon-512.png"];
let privateEpoch = 0;
let privateEnabled = false;
let privateBlocked = false;
async function toCleanResponse(response) {
  if (!response.redirected) return response;
  return new Response(await response.clone().arrayBuffer(), {
    status: response.status, statusText: response.statusText, headers: new Headers(response.headers),
  });
}
self.addEventListener("install", event => event.waitUntil((async () => {
  // 绕过 HTTP 缓存；全部资源成功后才写入新版本缓存。
  const entries = await Promise.all(SHELL_ASSETS.map(async path => {
    const response = await fetch(new Request(new URL(path, self.location.origin), { cache: "reload" }));
    if (response.status !== 200) throw new Error(`应用壳预缓存失败：${path} (${response.status})`);
    return [path, await toCleanResponse(response)];
  }));
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(entries.map(([path, response]) => cache.put(path, response)));
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith("eb-shell-") && name !== SHELL_CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
async function clearPrivate(broadcast = true, exceptClientId = null) {
  privateEpoch++; privateEnabled = false; privateBlocked = true;
  await caches.delete(PRIVATE_CACHE);
  if (broadcast) {
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      if (client.id !== exceptClientId) client.postMessage({ type: "PRIVATE_CACHE_CLEARED" });
    }
  }
}
self.addEventListener("message", event => {
  if (event.data?.type === "CLEAR_PRIVATE_CACHE") {
    // 在第一个 await 前阻止全部旧请求回填。
    event.waitUntil(clearPrivate(true, event.source?.id).then(() => event.ports?.[0]?.postMessage({ ok: true })));
  } else if (event.data?.type === "ENABLE_PRIVATE_CACHE") {
    privateEnabled = true; privateBlocked = false;
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
function offlineError() {
  return new Response(JSON.stringify({ ok: false, offline: true, error: "当前离线且本机暂无该项缓存" }), {
    status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function shellOfflineError(navigation) {
  return new Response(navigation
    ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event Board · 离线</title><body><h1>当前离线</h1><p>本机尚未缓存应用，请联网打开一次后重试。</p></body></html>'
    : "当前离线，资源尚未缓存", {
    status: 503, headers: { "Content-Type": navigation ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
async function withDeadline(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("offline deadline")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function authorizePrivateClient(event, epoch) {
  if (privateEnabled) return true;
  if (privateBlocked || epoch !== privateEpoch || !event.clientId || typeof MessageChannel === "undefined") return false;
  try {
    const client = await self.clients.get(event.clientId);
    if (!client || privateBlocked || epoch !== privateEpoch) return false;
    const approved = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 200);
      channel.port1.onmessage = message => {
        clearTimeout(timer); channel.port1.close(); resolve(message.data?.authorized === true);
      };
      client.postMessage({ type: "AUTHORIZE_PRIVATE_READ" }, [channel.port2]);
    });
    if (approved && !privateBlocked && epoch === privateEpoch) privateEnabled = true;
    return privateEnabled && !privateBlocked && epoch === privateEpoch;
  } catch { return false; }
}
async function privateRead(request, event) {
  const epoch = privateEpoch;
  const authorization = authorizePrivateClient(event, epoch);
  const network = fetch(request, { cache: "no-store" }).then(async response => {
    const clean = await toCleanResponse(response);
    if (clean.status === 401) await clearPrivate();
    else if (clean.status === 200 && await authorization && privateEnabled && epoch === privateEpoch) {
      try {
        const cache = await caches.open(PRIVATE_CACHE);
        if (privateEnabled && epoch === privateEpoch) await cache.put(request, clean.clone());
      } catch { /* 缓存写入失败不影响网络响应。 */ }
    }
    return clean;
  });
  // 超时回退后仍观察网络结果：迟到的 401 必须清理，不能被旧缓存掩盖。
  event.waitUntil(network.catch(() => {}));
  try { return await withDeadline(network, 2500); }
  catch {
    if (!await authorization || !privateEnabled || epoch !== privateEpoch) return offlineError();
    const cached = await (await caches.open(PRIVATE_CACHE)).match(request);
    if (!cached || !privateEnabled || epoch !== privateEpoch) return offlineError();
    const clean = await toCleanResponse(cached);
    const headers = new Headers(clean.headers); headers.set("X-EB-Offline-Cache", "1");
    return new Response(clean.clone().body, { status: clean.status, statusText: clean.statusText, headers });
  }
}
async function shellRead(request, event, navigation) {
  const url = new URL(request.url);
  const key = navigation || url.pathname === "/index.html" ? "/" : url.pathname;
  const network = fetch(request, { cache: "no-cache" }).then(async response => {
    if (navigation && response.status !== 200) throw new Error("导航网络响应不可用");
    const clean = await toCleanResponse(response);
    if (clean.status === 200) {
      try { await (await caches.open(SHELL_CACHE)).put(key, clean.clone()); }
      catch { /* 缓存写入失败不影响网络响应。 */ }
    }
    return clean;
  });
  event.waitUntil(network.catch(() => {}));
  try { return await withDeadline(network, 2000); }
  catch {
    const cache = await caches.open(SHELL_CACHE);
    const candidates = navigation ? ["/", request] : [key];
    for (const candidate of candidates) {
      try {
        const cached = await cache.match(candidate, { ignoreSearch: true });
        if (cached?.status === 200) return await toCleanResponse(cached);
      } catch { /* 单条缓存损坏时继续查找。 */ }
    }
    return shellOfflineError(navigation);
  }
}
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  // OAuth、配置和同步控制接口必须直连网络，绝不进入离线私有缓存。
  if (url.pathname.startsWith("/api/integrations/")) return;
  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/health" ||
      url.pathname.startsWith("/api/cal/") || url.pathname.endsWith("/calendar.ics")) return;
  if (url.pathname === "/api/events" || /^\/api\/events\/[^/]+$/.test(url.pathname) ||
      url.pathname.startsWith("/api/images/")) {
    event.respondWith(privateRead(request, event).catch(() => offlineError())); return;
  }
  const navigation = request.mode === "navigate";
  if ((navigation && !url.pathname.startsWith("/api/")) || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(shellRead(request, event, navigation).catch(() => shellOfflineError(navigation)));
  }
});
