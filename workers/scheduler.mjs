import { getDashboardStatus } from "../cloudflare/shared/repository.mjs";
import { runDueChecks } from "../cloudflare/shared/monitoring.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify(await getDashboardStatus(env)), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/run-now") {
      await runDueChecks(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDueChecks(env));
  },
};
