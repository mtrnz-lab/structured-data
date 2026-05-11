const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const storage = require("./storage");
const { createMonitor } = require("./monitor");
const {
  addSecurityHeaders,
  enforceWriteRateLimit,
  requireBasicAuth,
  validateLabel,
  validateMonitorUrl,
} = require("./security");

const PORT = Number(process.env.PORT || 4010);
const PUBLIC_DIR = path.join(process.cwd(), "public");

const monitor = createMonitor(storage);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, addSecurityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, addSecurityHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(requestPath, response) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const relativePath = normalized.replace(/^\/+/, "");
  const resolvedPath = path.resolve(PUBLIC_DIR, relativePath);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(resolvedPath);
    const extension = path.extname(resolvedPath);
    response.writeHead(200, addSecurityHeaders({
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=300",
    }));
    response.end(data);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function sortByCreatedAt(items) {
  return [...items].sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
}

async function listTargets() {
  const state = await storage.readState();

  return state.targets
    .map((target) => ({
      ...target,
      openAlerts: state.alerts.filter((alert) => alert.targetId === target.id && alert.status === "open").length,
      recentRuns: state.runs.filter((run) => run.targetId === target.id).slice(0, 5),
    }))
    .sort((left, right) => (left.createdAt || "").localeCompare(right.createdAt || ""));
}

async function listAlerts() {
  const state = await storage.readState();
  return sortByCreatedAt(state.alerts);
}

async function getStatus() {
  const state = await storage.readState();
  const runtime = monitor.getRuntimeStatus();
  const openAlerts = state.alerts.filter((alert) => alert.status === "open").length;
  const changedTargets = state.targets.filter((target) => target.status === "changed").length;
  const okTargets = state.targets.filter((target) => target.status === "ok").length;

  return {
    changedTargets,
    dbPath: storage.DB_PATH,
    okTargets,
    openAlerts,
    runtime,
    totalTargets: state.targets.length,
  };
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, await getStatus());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/targets") {
    sendJson(response, 200, await listTargets());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/alerts") {
    sendJson(response, 200, await listAlerts());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/targets") {
    const body = await readBody(request);
    const url = validateMonitorUrl(body.url);
    const label = validateLabel(body.label);

    const target = await storage.withState((state) => {
      const existing = state.targets.find((entry) => entry.url === url);

      if (existing) {
        throw new Error("This URL is already being monitored.");
      }

      const createdAt = new Date().toISOString();
      const nextTarget = {
        active: true,
        baselineSnapshot: null,
        checkEveryHours: 24,
        createdAt,
        id: crypto.randomUUID(),
        label: label || monitor.getDefaultLabel(url),
        lastChangeAt: null,
        lastCheckAt: null,
        lastError: null,
        lastSnapshot: null,
        status: "queued",
        updatedAt: createdAt,
        url,
      };

      state.targets.push(nextTarget);
      return nextTarget;
    });

    await monitor.queueTargetCheck(target.id);
    sendJson(response, 201, target);
    return true;
  }

  const targetCheckMatch = pathname.match(/^\/api\/targets\/([^/]+)\/check$/);
  if (request.method === "POST" && targetCheckMatch) {
    const targetId = targetCheckMatch[1];
    await monitor.queueTargetCheck(targetId);
    sendJson(response, 202, { queued: true, targetId });
    return true;
  }

  const targetToggleMatch = pathname.match(/^\/api\/targets\/([^/]+)\/toggle$/);
  if (request.method === "POST" && targetToggleMatch) {
    const targetId = targetToggleMatch[1];
    const target = await storage.withState((state) => {
      const current = state.targets.find((entry) => entry.id === targetId);

        if (!current) {
          throw new Error("Target not found.");
        }

      current.active = !current.active;
      current.updatedAt = new Date().toISOString();

      if (current.active) {
        current.status =
          current.pausedFromStatus ||
          (current.lastError
            ? "error"
            : current.baselineSnapshot
              ? "ok"
              : "queued");
        delete current.pausedFromStatus;
      } else {
        current.pausedFromStatus = current.status;
        current.status = "paused";
      }

      return current;
    });

    sendJson(response, 200, target);
    return true;
  }

  const targetBaselineMatch = pathname.match(/^\/api\/targets\/([^/]+)\/reset-baseline$/);
  if (request.method === "POST" && targetBaselineMatch) {
    const targetId = targetBaselineMatch[1];
    const target = await storage.withState((state) => {
      const current = state.targets.find((entry) => entry.id === targetId);

      if (!current) {
        throw new Error("Target not found.");
      }

      if (current.lastSnapshot) {
        current.baselineSnapshot = current.lastSnapshot;
        current.status = "ok";
      } else {
        current.baselineSnapshot = null;
        current.status = "queued";
      }

      current.updatedAt = new Date().toISOString();
      return current;
    });

    if (!target.lastSnapshot) {
      await monitor.queueTargetCheck(targetId);
    }

    sendJson(response, 200, target);
    return true;
  }

  const targetDeleteMatch = pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (request.method === "DELETE" && targetDeleteMatch) {
    const targetId = targetDeleteMatch[1];

    await storage.withState((state) => {
      state.targets = state.targets.filter((entry) => entry.id !== targetId);
      state.runs = state.runs.filter((entry) => entry.targetId !== targetId);
      state.alerts = state.alerts.filter((entry) => entry.targetId !== targetId);
    });

    sendJson(response, 204, {});
    return true;
  }

  const alertAckMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/ack$/);
  if (request.method === "POST" && alertAckMatch) {
    const alertId = alertAckMatch[1];
    const alert = await storage.withState((state) => {
      const current = state.alerts.find((entry) => entry.id === alertId);

      if (!current) {
        throw new Error("Alert not found.");
      }

      current.status = "acknowledged";
      current.acknowledgedAt = new Date().toISOString();
      return current;
    });

    sendJson(response, 200, alert);
    return true;
  }

  return false;
}

async function bootstrap() {
  await storage.ensureStorage();
  monitor.startScheduler();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    try {
      const authChallenge = requireBasicAuth(request);
      if (authChallenge) {
        response.writeHead(authChallenge.statusCode, authChallenge.headers);
        response.end(authChallenge.payload);
        return;
      }

      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "")) {
        const rateLimit = enforceWriteRateLimit(request);
        if (rateLimit) {
          response.writeHead(rateLimit.statusCode, rateLimit.headers);
          response.end(rateLimit.payload);
          return;
        }
      }

      const handled = await handleApi(request, response, url.pathname);

      if (handled) {
        return;
      }

      if (request.method === "GET") {
        await serveStatic(url.pathname, response);
        return;
      }

      sendJson(response, 404, { error: "Endpoint not found." });
    } catch (error) {
      sendJson(response, 500, { error: error.message || "Unexpected error." });
    }
  });

  server.listen(PORT, () => {
    console.log(`Dashboard available at http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    server.close();
    await monitor.stopScheduler();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
