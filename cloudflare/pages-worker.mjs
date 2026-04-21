import {
  ackAlert,
  deleteTarget,
  getDashboardStatus,
  listAlerts,
  listTargets,
  resetBaseline,
  toggleTarget,
} from "./shared/repository.mjs";
import { addTargetAndQueueCheck, runTargetCheck } from "./shared/monitoring.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
    status,
  });
}

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

  if (request.method === "POST" && pathname === "/api/targets") {
    const body = await readJsonBody(request);
    const url = String(body.url || "").trim();
    const label = String(body.label || "").trim();

    try {
      new URL(url);
    } catch {
      return jsonResponse({ error: "Inserisci una URL valida." }, 400);
    }

    const target = await addTargetAndQueueCheck(env, { label, url }, ctx);
    return jsonResponse(target, 201);
  }

  const targetCheckMatch = pathname.match(/^\/api\/targets\/([^/]+)\/check$/);
  if (request.method === "POST" && targetCheckMatch) {
    const targetId = targetCheckMatch[1];
    ctx.waitUntil(
      runTargetCheck(env, targetId).catch((error) => {
        console.error("Errore check manuale:", error.message);
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
          console.error("Errore baseline refresh:", error.message);
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
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(request, env, ctx, url.pathname);
        if (response) {
          return response;
        }

        return jsonResponse({ error: "Endpoint non trovato." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse({ error: error.message || "Errore inatteso." }, 500);
    }
  },
};
