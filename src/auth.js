const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const CONFIG_ERROR = "服务端尚未配置有效的 AUTH_TOKEN 访问口令，请在 .dev.vars 中设置";

export function isAuthConfigured(env) {
  return typeof env.AUTH_TOKEN === "string" && env.AUTH_TOKEN.trim().length > 0 &&
    !/替换|占位|placeholder|your[_ -]*(?:auth[_ -]*)?token|changeme|<[^>]+>/i.test(env.AUTH_TOKEN);
}

export function requireAuthConfigured(env) {
  if (!isAuthConfigured(env)) throw Object.assign(new Error(CONFIG_ERROR), { status: 500 });
}

export async function verifyToken(candidate, env) {
  requireAuthConfigured(env);
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(typeof candidate === "string" ? candidate : "")),
    crypto.subtle.digest("SHA-256", encoder.encode(env.AUTH_TOKEN)),
  ]);
  const left = new Uint8Array(actual), right = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < right.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function signingKey(env) {
  const material = await crypto.subtle.digest(
    "SHA-256", encoder.encode("event-board/session/v1\0" + env.AUTH_TOKEN)
  );
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function cookieAttributes(request, maxAge) {
  return "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" + maxAge +
    (new URL(request.url).protocol === "https:" ? "; Secure" : "");
}

export async function createSessionCookie(request, env) {
  requireAuthConfigured(env);
  const payload = "v1." + (Date.now() + SESSION_SECONDS * 1000);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(payload)));
  const encoded = btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "eb_session=" + payload + "." + encoded + cookieAttributes(request, SESSION_SECONDS);
}

export function clearSessionCookie(request) {
  return "eb_session=" + cookieAttributes(request, 0);
}

export async function isAuthenticated(request, env) {
  requireAuthConfigured(env);
  const cookie = (request.headers.get("Cookie") || "").split(";")
    .map((part) => part.trim()).find((part) => part.startsWith("eb_session="));
  const session = cookie?.slice("eb_session=".length);
  const match = session?.match(/^v1\.(\d+)\.([A-Za-z0-9_-]{43})$/);
  if (match) {
    const expiresAt = Number(match[1]);
    if (Number.isSafeInteger(expiresAt) && Date.now() < expiresAt) {
      try {
        const signature = Uint8Array.from(atob(match[2].replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
        if (await crypto.subtle.verify(
          "HMAC", await signingKey(env), signature, encoder.encode("v1." + match[1])
        )) return true;
      } catch { /* 畸形或伪造 Cookie 继续尝试 Bearer，不向外暴露签名细节。 */ }
    }
  }
  const bearer = request.headers.get("Authorization")?.match(/^Bearer[ \t]+(.+)$/i);
  return bearer ? verifyToken(bearer[1], env) : false;
}

export function isCalendarTokenConfigured(env) {
  return typeof env.CAL_TOKEN === "string" && env.CAL_TOKEN.trim().length > 0 &&
    !/替换成|占位|placeholder|your[_ -]*(?:cal[_ -]*)?token|changeme|<[^>]+>/i.test(env.CAL_TOKEN) &&
    env.CAL_TOKEN.trim() !== env.AUTH_TOKEN;
}
export async function verifyCalendarToken(candidate, env) {
  if (!isCalendarTokenConfigured(env)) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(typeof candidate === "string" ? candidate : "")),
    crypto.subtle.digest("SHA-256", encoder.encode(env.CAL_TOKEN.trim())),
  ]);
  const left = new Uint8Array(actual), right = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < right.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
