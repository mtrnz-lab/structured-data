import { getDashboardStatus } from "../cloudflare/shared/repository.mjs";
import { runDueChecks } from "../cloudflare/shared/monitoring.mjs";
import {
  jsonResponse,
  requireBasicAuth,
} from "../cloudflare/shared/security.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authResponse = requireBasicAuth(request, env, "DOM Metadata Scheduler");

    if (authResponse) {
      return authResponse;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(await getDashboardStatus(env));
    }

    if (request.method === "POST" && url.pathname === "/run-now") {
      await runDueChecks(env);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Endpoint not found." }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDueChecks(env));
  },
};
