import {
  ackAlert,
  deleteTarget,
  exportMonitoringData,
  getDashboardStatus,
  listAlerts,
  listTargets,
  resetBaseline,
  toggleTarget,
} from "./shared/repository.mjs";
import { addTargetAndQueueCheck, runTargetCheck } from "./shared/monitoring.mjs";
import {
  enforceWriteRateLimit,
  jsonResponse,
  requireBasicAuth,
  validateLabel,
  validateMonitorUrl,
  withSecurityHeaders,
} from "./shared/security.mjs";

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleApi(request, env, ctx, pathname) {
  if (request.method === "GET" && pathname === "/api/status") {
    return jsonResponse(await getDashboardStatus(env));
  }

  if (request.method === "GET" && pathname === "/api/targets") {
    return jsonResponse(await listTargets(env));
  }

  if (request.method === "GET" && pathname === "/api/alerts") {
    return jsonResponse(await listAlerts(env));
  }

  if (request.method === "GET" && pathname === "/api/export") {
    const payload = await exportMonitoringData(env);
    const filename = `dom-metadata-monitor-backup-${new Date().toISOString().slice(0, 10)}.json`;

    return withSecurityHeaders(
      new Response(JSON.stringify(payload, null, 2), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/json; charset=utf-8",
        },
      })
    );
  }

  if (request.method === "POST" && pathname === "/api/targets") {
    const body = await readJsonBody(request);
    const url = validateMonitorUrl(body.url);
    const label = validateLabel(body.label);

    const target = await addTargetAndQueueCheck(env, { label, url }, ctx);
    return jsonResponse(target, 201);
  }

  const targetCheckMatch = pathname.match(/^\/api\/targets\/([^/]+)\/check$/);
  if (request.method === "POST" && targetCheckMatch) {
    const targetId = targetCheckMatch[1];
    ctx.waitUntil(
      runTargetCheck(env, targetId).catch((error) => {
        console.error("Manual check error:", error.message);
      })
    );
    return jsonResponse({ queued: true, targetId }, 202);
  }

  const targetToggleMatch = pathname.match(/^\/api\/targets\/([^/]+)\/toggle$/);
  if (request.method === "POST" && targetToggleMatch) {
    return jsonResponse(await toggleTarget(env, targetToggleMatch[1]));
  }

  const targetBaselineMatch = pathname.match(/^\/api\/targets\/([^/]+)\/reset-baseline$/);
  if (request.method === "POST" && targetBaselineMatch) {
    const target = await resetBaseline(env, targetBaselineMatch[1]);

    if (!target.lastSnapshot) {
      ctx.waitUntil(
        runTargetCheck(env, target.id).catch((error) => {
          console.error("Baseline refresh error:", error.message);
        })
      );
    }

    return jsonResponse(target);
  }

  const targetDeleteMatch = pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (request.method === "DELETE" && targetDeleteMatch) {
    await deleteTarget(env, targetDeleteMatch[1]);
    return new Response(null, { status: 204 });
  }

  const alertAckMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/ack$/);
  if (request.method === "POST" && alertAckMatch) {
    return jsonResponse(await ackAlert(env, alertAckMatch[1]));
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      const authResponse = requireBasicAuth(request, env);
      if (authResponse) {
        return authResponse;
      }

      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        const rateLimitResponse = enforceWriteRateLimit(request);
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, env, ctx, url.pathname);
        if (response) {
          return response;
        }

        return jsonResponse({ error: "Endpoint not found." }, 404);
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      return jsonResponse({ error: error.message || "Unexpected error." }, 500);
    }
  },
};
