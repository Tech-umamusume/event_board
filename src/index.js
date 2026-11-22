import { buildCalendarFeed, buildSingleEventIcs } from "./calendar.js";
import { isAuthConfigured, requireAuthConfigured, verifyToken, isAuthenticated,
  createSessionCookie, clearSessionCookie, isCalendarTokenConfigured, verifyCalendarToken } from "./auth.js";
import { compileEvent } from "./compiler.js";
import {
  listEvents, createEvent, getEventDetail, deleteEvent,
  addTextOrUrlItem, addImageItem, deleteRawItem, getImageObject, updateEventOverrides,
} from "./storage.js";

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("路径编码无效"), { status: 400 });
  }
}

/**
 * 统一 JSON 响应辅助函数
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      const authConfigured = isAuthConfigured(env);
      if (url.pathname === "/api/auth/status" && request.method === "GET") {
        return jsonResponse({ ok: true, auth_configured: authConfigured,
          authenticated: authConfigured && await isAuthenticated(request, env) });
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        requireAuthConfigured(env);
        let data;
        try { data = await request.json(); }
        catch { return jsonResponse({ ok: false, error: "JSON 格式损坏" }, 400); }
        if (!await verifyToken(data?.token, env)) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return jsonResponse({ ok: false, error: "访问口令错误" }, 401);
        }
        return jsonResponse({ ok: true, authenticated: true }, 200, {
          "Set-Cookie": await createSessionCookie(request, env),
        });
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return jsonResponse({ ok: true, authenticated: false }, 200, {
          "Set-Cookie": clearSessionCookie(request),
        });
      }
      const feedMatch = url.pathname.match(/^\/api\/cal\/(.+)\.ics$/);
      if (feedMatch && request.method === "GET") {
        if (!isCalendarTokenConfigured(env)) {
          return jsonResponse({ ok: false, error: "日历订阅令牌 CAL_TOKEN 尚未配置" }, 503);
        }
        if (!await verifyCalendarToken(decodePath(feedMatch[1]), env)) {
          await new Promise(resolve => setTimeout(resolve, 300));
          return jsonResponse({ ok: false, error: "无效的日历订阅令牌" }, 401);
        }
        return new Response(buildCalendarFeed(await listEvents(env)), { headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="event-board.ics"',
          "Cache-Control": "private, no-cache, no-store, must-revalidate",
        } });
      }
      const protectedPath = url.pathname === "/api/events" || url.pathname.startsWith("/api/events/") ||
        url.pathname === "/api/cal/info" || url.pathname === "/api/images" || url.pathname.startsWith("/api/images/");
      if (protectedPath && !await isAuthenticated(request, env)) {
        return jsonResponse({ ok: false, error: "请先输入访问口令" }, 401);
      }

  
      if (url.pathname === "/api/cal/info" && request.method === "GET") {
        const configured = isCalendarTokenConfigured(env);
        return jsonResponse({ ok: true, configured,
          subscribe_path: configured ? "/api/cal/" + encodeURIComponent(env.CAL_TOKEN.trim()) + ".ics" : null });
      }
      const calendarMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/calendar\.ics$/);
      if (calendarMatch && request.method === "GET") {
        const event = await getEventDetail(env, decodePath(calendarMatch[1]));
        if (!event) return jsonResponse({ ok: false, error: "活动不存在" }, 404);
        const safeId = String(event.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "event";
        return new Response(buildSingleEventIcs(event), { headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="event-' + safeId + '.ics"',
          "Cache-Control": "private, no-cache",
        } });
      }
      // 1. 底座自检接口：GET /api/health
      if (url.pathname === "/api/health" && request.method === "GET") {
        if (!authConfigured || !await isAuthenticated(request, env)) {
          return jsonResponse({ ok: true, status: "up", auth_configured: authConfigured, authenticated: false });
        }
        try {
          const { results } = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events', 'raw_items') ORDER BY name"
          ).all();
  
          const tables = results.map((row) => row.name);
          const hasValidKey =
            Boolean(env.LLM_API_KEY) && !env.LLM_API_KEY.includes("替换成你的");
  
          return jsonResponse({
            ok: tables.length === 2 && Boolean(env.BUCKET) && hasValidKey,
            checks: {
              auth_token_configured: authConfigured,
              cal_token_configured: isCalendarTokenConfigured(env),
              database_tables: tables,
              r2_bucket_ready: Boolean(env.BUCKET),
              llm_base_url: env.LLM_BASE_URL || null,
              llm_model: env.LLM_MODEL || null,
              llm_api_key_configured: hasValidKey,
            },
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          return jsonResponse(
            { ok: false, error: err.message || "Health check failed" },
            500
          );
        }
      }
  
      const overridesMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/overrides$/);
      if (overridesMatch && request.method === "PATCH") {
        let body;
        try { body = await request.json(); }
        catch { return jsonResponse({ ok: false, error: "JSON 格式损坏" }, 400); }
        return jsonResponse({ ok: true, event: await updateEventOverrides(env, decodePath(overridesMatch[1]), body) });
      }

      const compileMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/compile$/);
      if (compileMatch && request.method === "POST") {
        const { event, stats } = await compileEvent(env, decodePath(compileMatch[1]));
        return jsonResponse({ ok: true, event, stats });
      }

      const eventsPath = url.pathname === "/api/events";
      if (eventsPath && request.method === "GET") {
        const events = await listEvents(env);
        const upcoming = events.filter((event) => event.timeline_bucket === "upcoming");
        const archived = events.filter((event) => event.timeline_bucket === "archived");
        return jsonResponse({ ok: true, events, upcoming, archived });
      }
      if (eventsPath && request.method === "POST") {
        return jsonResponse({ ok: true, event: await createEvent(env) }, 201);
      }

      const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
      if (eventMatch) {
        const eventId = decodePath(eventMatch[1]);
        if (request.method === "GET") {
          const event = await getEventDetail(env, eventId);
          return event
            ? jsonResponse({ ok: true, event })
            : jsonResponse({ ok: false, error: "活动不存在" }, 404);
        }
        if (request.method === "DELETE") {
          return await deleteEvent(env, eventId)
            ? jsonResponse({ ok: true, deleted: true })
            : jsonResponse({ ok: false, error: "活动不存在" }, 404);
        }
      }

      const itemsMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/items$/);
      if (itemsMatch && request.method === "POST") {
        const eventId = decodePath(itemsMatch[1]);
        const contentType = (request.headers.get("Content-Type") || "")
          .split(";")[0].trim().toLowerCase();
        let item;
        if (contentType === "application/json") {
          let data;
          try {
            data = await request.json();
          } catch {
            return jsonResponse({ ok: false, error: "JSON 格式损坏" }, 400);
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            return jsonResponse({ ok: false, error: "请求内容必须是 JSON 对象" }, 400);
          }
          item = await addTextOrUrlItem(env, eventId, data);
        } else if (contentType === "multipart/form-data") {
          let formData;
          try {
            formData = await request.formData();
          } catch {
            return jsonResponse({ ok: false, error: "无法解析上传表单" }, 400);
          }
          item = await addImageItem(
            env, eventId, formData.get("file"), formData.get("caption") ?? ""
          );
        } else {
          return jsonResponse({
            ok: false, error: "仅支持 application/json 或 multipart/form-data",
          }, 415);
        }
        return jsonResponse({ ok: true, item }, 201);
      }

      const itemMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/items\/([^/]+)$/);
      if (itemMatch && request.method === "DELETE") {
        return await deleteRawItem(env, decodePath(itemMatch[1]), decodePath(itemMatch[2]))
          ? jsonResponse({ ok: true, deleted: true })
          : jsonResponse({ ok: false, error: "素材不存在" }, 404);
      }

      if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
        const imageKey = decodePath(url.pathname.slice("/api/images/".length));
        const object = await getImageObject(env, imageKey);
        if (!object) {
          return jsonResponse({ ok: false, error: "图片不存在" }, 404);
        }
        const headers = new Headers({
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          "ETag": object.httpEtag || '"' + object.etag + '"',
          "Cache-Control": "private, max-age=3600",
        });
        return new Response(object.body, { headers });
      }

      // 未实现的 API 返回明确 404
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({ ok: false, error: "API route not found" }, 404);
      }
  
      // 3. 非 API 请求交回静态前端资源（public/）
      return await env.ASSETS.fetch(request);
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
        ? err.status : 500;
      return jsonResponse({
        ok: false,
        error: err?.message || "请求处理失败",
      }, status);
    }
  },
};