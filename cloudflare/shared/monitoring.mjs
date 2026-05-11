import {
  createTarget,
  findOpenAlert,
  getNowIso,
  getTargetById,
  insertAlert,
  insertRun,
  listDueTargets,
  setAppStateValues,
  setTargetFields,
  updateAlert,
  updateRun,
} from "./repository.mjs";
import { readEnvString, validateMonitorUrl } from "./security.mjs";

const MAX_ALERT_HISTORY = 200;
const HTML_ENTITY_MAP = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function createHash(input) {
  let hash1 = 0xdeadbeef;
  let hash2 = 0x41c6ce57;

  for (let index = 0; index < input.length; index += 1) {
    const charCode = input.charCodeAt(index);
    hash1 = Math.imul(hash1 ^ charCode, 2654435761);
    hash2 = Math.imul(hash2 ^ charCode, 1597334677);
  }

  hash1 =
    Math.imul(hash1 ^ (hash1 >>> 16), 2246822507) ^
    Math.imul(hash2 ^ (hash2 >>> 13), 3266489909);
  hash2 =
    Math.imul(hash2 ^ (hash2 >>> 16), 2246822507) ^
    Math.imul(hash1 ^ (hash1 >>> 13), 3266489909);

  return `${(hash2 >>> 0).toString(16).padStart(8, "0")}${(hash1 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function decodeHtmlEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();

    if (normalized.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }

    if (normalized.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }

    return HTML_ENTITY_MAP[normalized] || match;
  });
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((accumulator, key) => {
      accumulator[key] = sortObject(value[key]);
      return accumulator;
    }, {});
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function uniqSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function normalizeSchemaTypeLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).trim().replace(/[#/]$/, "");
  const pieces = normalized.split(/[\/#]/).filter(Boolean);
  return pieces[pieces.length - 1] || normalized;
}

function visitJsonTree(node, visitor) {
  if (Array.isArray(node)) {
    for (const entry of node) {
      visitJsonTree(entry, visitor);
    }

    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  visitor(node);

  for (const value of Object.values(node)) {
    visitJsonTree(value, visitor);
  }
}

function groupCollection(items, makeKey, makeValue) {
  const bucket = new Map();

  for (const item of items) {
    const key = makeKey(item);
    const list = bucket.get(key) || [];
    list.push(makeValue(item));
    bucket.set(key, list);
  }

  return Array.from(bucket.entries())
    .map(([key, values]) => ({
      key,
      values: uniqSorted(values.map((entry) => stableStringify(entry))),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeSnapshot(rawSnapshot) {
  return {
    alternates: (rawSnapshot.alternates || [])
      .map((item) => ({
        href: item.href,
        hreflang: item.hreflang || "default",
        rel: item.rel,
      }))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    canonical: rawSnapshot.canonical || "",
    counts: rawSnapshot.counts || {},
    jsonLd: (rawSnapshot.jsonLd || [])
      .map((item) => ({
        digest: item.validJson ? createHash(stableStringify(item.parsedJson)) : createHash(item.rawText || ""),
        schemaTypes: uniqSorted((item.schemaTypes || []).map(normalizeSchemaTypeLabel)),
        validJson: item.validJson,
      }))
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
    meta: groupCollection(
      rawSnapshot.meta || [],
      (item) => `${item.kind}:${item.key}`,
      (item) => ({
        content: item.content,
        location: item.location,
      })
    ),
    microdata: groupCollection(
      rawSnapshot.microdata || [],
      (item) => item.itemType || "anonymous",
      (item) => ({
        itemProp: item.itemProp || "",
        tag: item.tag,
      })
    ),
    productDescription: rawSnapshot.productDescription || "",
    rdfa: groupCollection(
      rawSnapshot.rdfa || [],
      (item) => `${item.typeOf || ""}|${item.property || ""}|${item.vocab || ""}`,
      (item) => ({
        tag: item.tag,
      })
    ),
    structuredDataTypes: uniqSorted(rawSnapshot.structuredDataTypes || []),
    title: rawSnapshot.title || "",
    url: rawSnapshot.url,
    visibilityChecks: rawSnapshot.visibilityChecks || {},
    warnings: uniqSorted(rawSnapshot.warnings || []),
  };
}

function summarizeSnapshot(normalizedSnapshot) {
  return {
    alternateCount: normalizedSnapshot.alternates.length,
    alternates: normalizedSnapshot.alternates,
    canonical: normalizedSnapshot.canonical,
    hasWarnings: normalizedSnapshot.warnings.length > 0,
    jsonLdCount: normalizedSnapshot.jsonLd.length,
    metaCount: normalizedSnapshot.meta.length,
    microdataCount: normalizedSnapshot.microdata.length,
    productDescription: normalizedSnapshot.productDescription,
    rdfaCount: normalizedSnapshot.rdfa.length,
    structuredDataTypes: normalizedSnapshot.structuredDataTypes,
    title: normalizedSnapshot.title,
  };
}

function mapByKey(entries) {
  return new Map(entries.map((entry) => [entry.key, entry.values]));
}

function compareGroupedEntries(label, baselineEntries, currentEntries) {
  const changes = [];
  const baselineMap = mapByKey(baselineEntries);
  const currentMap = mapByKey(currentEntries);
  const allKeys = Array.from(new Set([...baselineMap.keys(), ...currentMap.keys()])).sort();

  for (const key of allKeys) {
    const before = JSON.stringify(baselineMap.get(key) || []);
    const after = JSON.stringify(currentMap.get(key) || []);

    if (before !== after) {
      changes.push(`${label} "${key}" changed.`);
    }
  }

  return changes;
}

function compareArrayAsSet(label, baselineItems, currentItems) {
  const before = uniqSorted((baselineItems || []).map((item) => stableStringify(item)));
  const after = uniqSorted((currentItems || []).map((item) => stableStringify(item)));

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return [`${label} changed.`];
  }

  return [];
}

function compareVisibilityChecks(baselineChecks, currentChecks) {
  const changes = [];
  const keys = Array.from(
    new Set([...Object.keys(baselineChecks || {}), ...Object.keys(currentChecks || {})])
  ).sort();

  for (const key of keys) {
    const before = Boolean(baselineChecks?.[key]);
    const after = Boolean(currentChecks?.[key]);

    if (before !== after) {
      changes.push(`Visibility check "${key}" changed from ${before} to ${after}.`);
    }
  }

  return changes;
}

function diffSnapshots(baselineSnapshot, currentSnapshot) {
  const changes = [];

  if ((baselineSnapshot.title || "") !== (currentSnapshot.title || "")) {
    changes.push("Title changed.");
  }

  if ((baselineSnapshot.canonical || "") !== (currentSnapshot.canonical || "")) {
    changes.push("Canonical changed.");
  }

  changes.push(...compareGroupedEntries("Meta", baselineSnapshot.meta || [], currentSnapshot.meta || []));
  changes.push(
    ...compareGroupedEntries("Microdata", baselineSnapshot.microdata || [], currentSnapshot.microdata || [])
  );
  changes.push(...compareGroupedEntries("RDFa", baselineSnapshot.rdfa || [], currentSnapshot.rdfa || []));
  changes.push(...compareArrayAsSet("Alternate tags", baselineSnapshot.alternates || [], currentSnapshot.alternates || []));
  changes.push(...compareArrayAsSet("JSON-LD blocks", baselineSnapshot.jsonLd || [], currentSnapshot.jsonLd || []));
  changes.push(
    ...compareVisibilityChecks(
      baselineSnapshot.visibilityChecks || {},
      currentSnapshot.visibilityChecks || {}
    )
  );

  if (JSON.stringify(baselineSnapshot.warnings || []) !== JSON.stringify(currentSnapshot.warnings || [])) {
    changes.push("Technical warnings changed.");
  }

  return {
    changed: changes.length > 0,
    changes,
    summary: changes[0] || "No changes compared with the baseline.",
  };
}

function parseAttributes(source) {
  const attributes = {};
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const [, rawName, doubleQuoted, singleQuoted, unquoted] = match;
    const name = rawName.toLowerCase();
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    attributes[name] = decodeHtmlEntities(value);
  }

  return attributes;
}

function extractSnapshotFromHtml(html, url) {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const headStart = headMatch?.index ?? -1;
  const headEnd = headMatch ? headMatch.index + headMatch[0].length : -1;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(headMatch?.[1] || html);
  const meta = [];
  const alternates = [];
  const jsonLd = [];
  const microdata = [];
  const rdfa = [];
  const warnings = [];

  const metaRegex = /<meta\b[^>]*>/gi;
  let tagMatch;
  while ((tagMatch = metaRegex.exec(html)) !== null) {
    const attributes = parseAttributes(tagMatch[0]);
    const key =
      attributes.name ||
      attributes.property ||
      attributes["http-equiv"] ||
      (Object.hasOwn(attributes, "charset") ? "charset" : "");

    const kind = attributes.name
      ? "name"
      : attributes.property
        ? "property"
        : attributes["http-equiv"]
          ? "http-equiv"
          : Object.hasOwn(attributes, "charset")
            ? "charset"
            : "other";

    if (key || attributes.content || attributes.charset) {
      meta.push({
        content: attributes.content || attributes.charset || "",
        key,
        kind,
        location: headStart !== -1 && tagMatch.index >= headStart && tagMatch.index < headEnd ? "head" : "body",
      });
    }
  }

  const linkRegex = /<link\b[^>]*>/gi;
  while ((tagMatch = linkRegex.exec(html)) !== null) {
    const attributes = parseAttributes(tagMatch[0]);
    const relValue = (attributes.rel || "").toLowerCase();
    const tokens = relValue.split(/\s+/).filter(Boolean);

    if (tokens.includes("canonical") || tokens.includes("alternate")) {
      alternates.push({
        href: attributes.href || "",
        hreflang: attributes.hreflang || "",
        rel: tokens.includes("canonical") ? "canonical" : "alternate",
      });
    }
  }

  const scriptRegex = /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi;
  while ((tagMatch = scriptRegex.exec(html)) !== null) {
    const rawText = decodeHtmlEntities(tagMatch[1].trim());

    try {
      const parsedJson = JSON.parse(rawText);
      const schemaTypes = [];

      visitJsonTree(parsedJson, (node) => {
        const type = node["@type"];
        const types = Array.isArray(type) ? type : type ? [type] : [];
        schemaTypes.push(...types.filter(Boolean));
      });

      jsonLd.push({
        parsedJson,
        rawText,
        schemaTypes,
        validJson: true,
      });
    } catch {
      jsonLd.push({
        parsedJson: null,
        rawText,
        schemaTypes: [],
        validJson: false,
      });
    }
  }

  const microdataRegex = /<([a-zA-Z][\w:-]*)([^>]*\bitemscope\b[^>]*)>/gi;
  while ((tagMatch = microdataRegex.exec(html)) !== null) {
    const attributes = parseAttributes(tagMatch[2]);
    microdata.push({
      itemProp: attributes.itemprop || "",
      itemType: attributes.itemtype || "",
      tag: tagMatch[1].toLowerCase(),
    });
  }

  const rdfaRegex = /<([a-zA-Z][\w:-]*)([^>]*(?:\btypeof\b|\bproperty\b|\bvocab\b)[^>]*)>/gi;
  while ((tagMatch = rdfaRegex.exec(html)) !== null) {
    const attributes = parseAttributes(tagMatch[2]);
    rdfa.push({
      property: attributes.property || "",
      tag: tagMatch[1].toLowerCase(),
      typeOf: attributes.typeof || "",
      vocab: attributes.vocab || "",
    });
  }

  const descriptionMeta =
    meta.find((item) => item.kind === "name" && item.key.toLowerCase() === "description")?.content ||
    meta.find((item) => item.kind === "property" && item.key.toLowerCase() === "og:description")?.content ||
    "";

  let productDescriptionFromJsonLd = "";
  const structuredDataTypes = [];

  for (const item of jsonLd.filter((entry) => entry.validJson)) {
    visitJsonTree(item.parsedJson, (node) => {
      const type = node["@type"];
      const types = Array.isArray(type) ? type : type ? [type] : [];
      structuredDataTypes.push(...types.filter(Boolean).map(normalizeSchemaTypeLabel));

      if (!productDescriptionFromJsonLd) {
        const hasProductType = types.some(
          (candidate) => normalizeSchemaTypeLabel(candidate).toLowerCase() === "product"
        );

        if (hasProductType && typeof node.description === "string" && node.description.trim()) {
          productDescriptionFromJsonLd = node.description.trim();
        }
      }
    });
  }

  const normalizedStructuredDataTypes = uniqSorted([
    ...structuredDataTypes,
    ...microdata.map((item) => normalizeSchemaTypeLabel(item.itemType)),
    ...rdfa
      .flatMap((item) => (item.typeOf || "").split(/\s+/))
      .filter(Boolean)
      .map(normalizeSchemaTypeLabel),
  ]);

  if (meta.some((item) => item.location !== "head")) {
    warnings.push("Meta tags were found outside the <head>.");
  }

  if (jsonLd.some((item) => !item.validJson)) {
    warnings.push("One or more JSON-LD blocks could not be parsed.");
  }

  const rawSnapshot = {
    alternates,
    canonical: alternates.find((item) => item.rel === "canonical")?.href || "",
    counts: {
      jsonLd: jsonLd.length,
      meta: meta.length,
      microdata: microdata.length,
      rdfa: rdfa.length,
    },
    jsonLd: jsonLd.map((item) => ({
      ...item,
      parsedJson: item.parsedJson ? sortObject(item.parsedJson) : null,
    })),
    meta,
    microdata,
    productDescription: productDescriptionFromJsonLd || descriptionMeta,
    rdfa,
    structuredDataTypes: normalizedStructuredDataTypes,
    title: decodeHtmlEntities((titleMatch?.[1] || "").replace(/\s+/g, " ").trim()),
    url,
    visibilityChecks: {
      domReady: true,
      hasHead: Boolean(headMatch),
      hasStructuredData: jsonLd.length > 0 || microdata.length > 0 || rdfa.length > 0,
      jsonLdParseable: jsonLd.every((item) => item.validJson),
      metadataInHead: meta.every((item) => item.location === "head"),
    },
    warnings,
  };

  const normalized = normalizeSnapshot(rawSnapshot);

  return {
    fingerprint: createHash(stableStringify(normalized)),
    normalized,
    summary: summarizeSnapshot(normalized),
  };
}

async function fetchRenderedHtml(env, url) {
  const safeUrl = validateMonitorUrl(url);
  const token = readEnvString(env.BROWSER_RUN_API_TOKEN);
  const accountId = readEnvString(env.CLOUDFLARE_ACCOUNT_ID);
  const apiBase = readEnvString(env.BROWSER_RUN_API_BASE) || "https://api.cloudflare.com/client/v4";

  if (!token || !accountId) {
    throw new Error("Configura CLOUDFLARE_ACCOUNT_ID e BROWSER_RUN_API_TOKEN.");
  }

  const response = await fetch(`${apiBase}/accounts/${accountId}/browser-rendering/content`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      gotoOptions: {
        timeout: Number(readEnvString(env.MONITOR_CHECK_TIMEOUT_MS) || 45000),
        waitUntil: "networkidle2",
      },
      url: safeUrl,
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload.success === false) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.messages?.[0]?.message ||
      `Browser Run request fallita con status ${response.status}.`;
    throw new Error(message);
  }

  return String(payload.result || "");
}

function buildAlert({ details, runId, signature, summary, target, type }) {
  return {
    createdAt: getNowIso(),
    details,
    id: crypto.randomUUID(),
    repeatCount: 1,
    runId,
    signature,
    status: "open",
    summary,
    targetId: target.id,
    targetLabel: target.label,
    targetUrl: target.url,
    type,
  };
}

async function storeAlert(env, alert) {
  const existing = await findOpenAlert(env, {
    signature: alert.signature,
    targetId: alert.targetId,
    type: alert.type,
  });

  if (existing) {
    await updateAlert(env, existing.id, {
      lastSeenAt: getNowIso(),
      repeatCount: (existing.repeatCount || 1) + 1,
    });
    return existing.id;
  }

  await insertAlert(env, alert);

  const extraAlerts = await env.DB.prepare(
    "SELECT id FROM alerts WHERE status = 'open' ORDER BY created_at DESC LIMIT -1 OFFSET ?"
  )
    .bind(MAX_ALERT_HISTORY)
    .all();

  for (const row of extraAlerts.results || []) {
    await env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(row.id).run();
  }

  return alert.id;
}

export function getDefaultLabel(urlString) {
  const parsed = new URL(urlString);
  const suffix = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  return `${parsed.host}${suffix}`;
}

export async function addTargetAndQueueCheck(env, { label, url }, ctx) {
  const target = await createTarget(env, {
    defaultLabel: getDefaultLabel,
    label,
    url,
  });

  ctx.waitUntil(
    runTargetCheck(env, target.id).catch((error) => {
      console.error("Initial check error:", error.message);
    })
  );

  return target;
}

export async function runTargetCheck(env, targetId) {
  const target = await getTargetById(env, targetId);

  if (!target) {
    throw new Error("Target not found.");
  }

  const runId = crypto.randomUUID();
  const startedAt = getNowIso();

  await setTargetFields(env, target.id, {
    lastError: null,
    status: "running",
    updatedAt: startedAt,
  });

  await insertRun(env, {
    id: runId,
    startedAt,
    status: "running",
    summary: "Check started.",
    targetId: target.id,
    targetLabel: target.label,
    targetUrl: target.url,
  });

  try {
    const html = await fetchRenderedHtml(env, target.url);
    const snapshot = extractSnapshotFromHtml(html, target.url);
    const snapshotRecord = {
      capturedAt: getNowIso(),
      fingerprint: snapshot.fingerprint,
      normalized: snapshot.normalized,
      summary: snapshot.summary,
    };
    const latestTarget = await getTargetById(env, target.id);

    if (!latestTarget?.baselineSnapshot) {
      await setTargetFields(env, target.id, {
        baselineSnapshot: snapshotRecord,
        lastCheckAt: snapshotRecord.capturedAt,
        lastSnapshot: snapshotRecord,
        status: "baseline",
        updatedAt: snapshotRecord.capturedAt,
      });

      await updateRun(env, runId, {
        finishedAt: snapshotRecord.capturedAt,
        snapshotFingerprint: snapshot.fingerprint,
        status: "baseline",
        summary: "Baseline created from the first valid snapshot.",
      });

      return { queued: true, snapshot: snapshotRecord };
    }

    const diff = diffSnapshots(latestTarget.baselineSnapshot.normalized, snapshot.normalized);
    const changed = diff.changed;

    await setTargetFields(env, target.id, {
      lastChangeAt: changed ? snapshotRecord.capturedAt : latestTarget.lastChangeAt,
      lastCheckAt: snapshotRecord.capturedAt,
      lastError: null,
      lastSnapshot: snapshotRecord,
      status: changed ? "changed" : "ok",
      updatedAt: snapshotRecord.capturedAt,
    });

    await updateRun(env, runId, {
      diff,
      finishedAt: snapshotRecord.capturedAt,
      snapshotFingerprint: snapshot.fingerprint,
      status: changed ? "changed" : "ok",
      summary: changed ? diff.summary : "No differences compared with the baseline.",
    });

    if (changed) {
      await storeAlert(
        env,
        buildAlert({
          details: diff.changes.concat(snapshot.normalized.warnings),
          runId,
          signature: `${snapshot.fingerprint}:${diff.summary}:${snapshot.normalized.warnings.join("|")}`,
          summary: diff.summary,
          target,
          type: "diff",
        })
      );
    }

    return { queued: true, snapshot: snapshotRecord };
  } catch (error) {
    const finishedAt = getNowIso();

    await setTargetFields(env, target.id, {
      lastCheckAt: finishedAt,
      lastError: error.message,
      status: "error",
      updatedAt: finishedAt,
    });

    await updateRun(env, runId, {
      error: error.message,
      finishedAt,
      status: "error",
      summary: "The check finished with an error.",
    });

    await storeAlert(
      env,
      buildAlert({
        details: [error.message],
        runId,
        signature: `error:${error.message}`,
        summary: "Error while checking the page.",
        target,
        type: "error",
      })
    );

    return {
      error: error.message,
      queued: false,
    };
  }
}

export async function runDueChecks(env) {
  const startedAt = getNowIso();
  let lastError = null;

  try {
    const dueTargets = await listDueTargets(env);
    const batchLimit = Number(env.MONITOR_BATCH_LIMIT || 25);

    for (const target of dueTargets.slice(0, batchLimit)) {
      const result = await runTargetCheck(env, target.id);

      if (result.error) {
        lastError = result.error;
      }
    }
  } catch (error) {
    lastError = error.message;
  }

  await setAppStateValues(env, {
    last_sweep_at: startedAt,
    last_sweep_error: lastError,
    last_sweep_source: "cloudflare-cron",
  });
}
