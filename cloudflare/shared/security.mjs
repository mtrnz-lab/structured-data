const DEFAULT_WRITE_LIMIT = {
  maxRequests: 30,
  windowMs: 60_000,
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

function constantTimeEquals(left, right) {
  const leftBuffer = new TextEncoder().encode(String(left || ""));
  const rightBuffer = new TextEncoder().encode(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < leftBuffer.length; index += 1) {
    mismatch |= leftBuffer[index] ^ rightBuffer[index];
  }

  return mismatch === 0;
}

function decodeBasicAuthorization(headerValue) {
  if (!headerValue || !headerValue.toLowerCase().startsWith("basic ")) {
    return null;
  }

  try {
    const decoded = atob(headerValue.slice(6).trim());
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

export function readEnvString(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value == null) {
    return "";
  }

  const candidateKeys = ["value", "secret", "plaintext", "plainText", "text"];

  for (const key of candidateKeys) {
    if (typeof value?.[key] === "string") {
      return value[key].trim();
    }
  }

  if (typeof value?.valueOf === "function") {
    const evaluated = value.valueOf();
    if (typeof evaluated === "string") {
      return evaluated.trim();
    }
  }

  if (typeof value?.toJSON === "function") {
    const jsonValue = value.toJSON();
    if (typeof jsonValue === "string") {
      return jsonValue.trim();
    }
  }

  if (typeof value === "object") {
    for (const entry of Object.values(value)) {
      if (typeof entry === "string" && entry.trim()) {
        return entry.trim();
      }
    }
  }

  return "";
}

export function getSecurityHeaders() {
  return { ...SECURITY_HEADERS };
}

export function withSecurityHeaders(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(payload), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
      status,
    }),
    extraHeaders
  );
}

export function unauthorizedResponse(realm = "DOM Metadata Monitor") {
  return jsonResponse(
    { error: "Authentication required." },
    401,
    { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` }
  );
}

export function serviceUnavailableResponse(message) {
  return jsonResponse({ error: message }, 503);
}

export function requireBasicAuth(request, env, realm = "DOM Metadata Monitor") {
  const expectedUsername = readEnvString(env.MONITOR_USERNAME);
  const expectedPassword = readEnvString(env.MONITOR_PASSWORD);

  if (!expectedUsername || !expectedPassword) {
    return serviceUnavailableResponse(
      "Set MONITOR_USERNAME and MONITOR_PASSWORD before exposing the dashboard."
    );
  }

  const credentials = decodeBasicAuthorization(request.headers.get("authorization"));

  if (
    !credentials ||
    !constantTimeEquals(credentials.username, expectedUsername) ||
    !constantTimeEquals(credentials.password, expectedPassword)
  ) {
    return unauthorizedResponse(realm);
  }

  return null;
}

export function getClientAddress(request) {
  const headerValue =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  return String(headerValue).split(",")[0].trim() || "unknown";
}

export function enforceWriteRateLimit(request, limit = DEFAULT_WRITE_LIMIT) {
  const now = Date.now();
  const ipAddress = normalizeIp(getClientAddress(request)) || "unknown";
  const path = new URL(request.url).pathname;
  const key = `${ipAddress}:${request.method}:${path}`;
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
    return jsonResponse(
      { error: "You have exceeded the write request limit. Please try again shortly." },
      429,
      {
        "Retry-After": String(Math.ceil((current.resetAt - now) / 1000)),
      }
    );
  }

  return null;
}

export function validateMonitorUrl(urlString) {
  let parsedUrl;

  try {
    parsedUrl = new URL(String(urlString || "").trim());
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  if (!parsedUrl.hostname) {
    throw new Error("The URL must contain a valid hostname.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  if (isPrivateHost(parsedUrl.hostname)) {
    throw new Error("Local, private, or reserved hosts cannot be monitored.");
  }

  if (parsedUrl.href.length > 2048) {
    throw new Error("The URL is too long.");
  }

  return parsedUrl.toString();
}

export function validateLabel(label) {
  const normalized = String(label || "").trim();

  if (normalized.length > 120) {
    throw new Error("The label cannot exceed 120 characters.");
  }

  return normalized;
}
