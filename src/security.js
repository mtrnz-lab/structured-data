const crypto = require("crypto");

const DEFAULT_WRITE_LIMIT = {
  maxRequests: 30,
  windowMs: 60 * 1000,
};

const rateLimitStore = new Map();

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function normalizeIp(ipAddress) {
  return String(ipAddress || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .split("%")[0];
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }

  const numbers = parts.map((part) => Number(part));

  if (numbers.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  return (
    numbers[0] === 10 ||
    numbers[0] === 127 ||
    numbers[0] === 0 ||
    (numbers[0] === 169 && numbers[1] === 254) ||
    (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) ||
    (numbers[0] === 192 && numbers[1] === 168) ||
    (numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127) ||
    (numbers[0] === 198 && (numbers[1] === 18 || numbers[1] === 19))
  );
}

function isPrivateIpv6(hostname) {
  const normalized = normalizeIp(hostname);

  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "0.0.0.0"
  );
}

function isPrivateHost(hostname) {
  return isLocalHostname(hostname) || isPrivateIpv4(hostname) || isPrivateIpv6(hostname);
}

function addSecurityHeaders(headers, extraHeaders = {}) {
  return {
    ...SECURITY_HEADERS,
    ...headers,
    ...extraHeaders,
  };
}

function decodeBasicAuthorization(headerValue) {
  if (!headerValue || !headerValue.toLowerCase().startsWith("basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6).trim(), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) {
      return null;
    }

    return {
      password: decoded.slice(separatorIndex + 1),
      username: decoded.slice(0, separatorIndex),
    };
  } catch {
    return null;
  }
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getClientAddress(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (forwardedFor) {
    return String(forwardedFor).split(",")[0].trim();
  }

  return (
    request.socket?.remoteAddress ||
    request.connection?.remoteAddress ||
    "unknown"
  );
}

function enforceWriteRateLimit(request, limit = DEFAULT_WRITE_LIMIT) {
  const now = Date.now();
  const ipAddress = normalizeIp(getClientAddress(request)) || "unknown";
  const key = `${ipAddress}:${request.method}:${request.url || ""}`;
  const current = rateLimitStore.get(key);

  if (!current || now >= current.resetAt) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + limit.windowMs,
    });
    return null;
  }

  current.count += 1;
  if (current.count > limit.maxRequests) {
    return {
      headers: addSecurityHeaders(
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(Math.ceil((current.resetAt - now) / 1000)),
        }
      ),
      payload: JSON.stringify({
        error: "Hai superato il limite di richieste in scrittura. Riprova tra poco.",
      }),
      statusCode: 429,
    };
  }

  return null;
}

function requireBasicAuth(request, realm = "DOM Metadata Monitor") {
  const expectedUsername = String(process.env.MONITOR_USERNAME || "").trim();
  const expectedPassword = String(process.env.MONITOR_PASSWORD || "").trim();

  if (!expectedUsername || !expectedPassword) {
    return {
      headers: addSecurityHeaders({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      }),
      payload: JSON.stringify({
        error: "Configura MONITOR_USERNAME e MONITOR_PASSWORD prima di esporre la dashboard.",
      }),
      statusCode: 503,
    };
  }

  const credentials = decodeBasicAuthorization(request.headers.authorization);

  if (
    !credentials ||
    !constantTimeEquals(credentials.username, expectedUsername) ||
    !constantTimeEquals(credentials.password, expectedPassword)
  ) {
    return {
      headers: addSecurityHeaders({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
      }),
      payload: JSON.stringify({ error: "Autenticazione richiesta." }),
      statusCode: 401,
    };
  }

  return null;
}

function validateMonitorUrl(urlString) {
  let parsedUrl;

  try {
    parsedUrl = new URL(String(urlString || "").trim());
  } catch {
    throw new Error("Inserisci una URL valida.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Sono permesse solo URL http o https.");
  }

  if (!parsedUrl.hostname) {
    throw new Error("La URL deve contenere un hostname valido.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("Le URL con credenziali integrate non sono consentite.");
  }

  if (isPrivateHost(parsedUrl.hostname)) {
    throw new Error("Non e possibile monitorare host locali, privati o riservati.");
  }

  if (parsedUrl.href.length > 2048) {
    throw new Error("La URL e troppo lunga.");
  }

  return parsedUrl.toString();
}

function validateLabel(label) {
  const normalized = String(label || "").trim();

  if (normalized.length > 120) {
    throw new Error("L'etichetta non puo superare 120 caratteri.");
  }

  return normalized;
}

module.exports = {
  addSecurityHeaders,
  enforceWriteRateLimit,
  requireBasicAuth,
  validateLabel,
  validateMonitorUrl,
};
