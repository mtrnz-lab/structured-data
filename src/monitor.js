const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateMonitorUrl } = require("./security");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (defaultError) {
    const candidates = [];

    if (process.env.CODEX_BUNDLED_NODE_MODULES) {
      candidates.push(process.env.CODEX_BUNDLED_NODE_MODULES);
    }

    if (process.env.NODE_PATH) {
      candidates.push(...process.env.NODE_PATH.split(path.delimiter));
    }

    candidates.push(
      path.join(
        os.homedir(),
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "dependencies",
        "node",
        "node_modules"
      )
    );

    for (const candidate of candidates.filter(Boolean)) {
      try {
        return require(path.join(candidate, "playwright"));
      } catch {
        continue;
      }
    }

    throw defaultError;
  }
}

const { chromium } = loadPlaywright();

const CHECK_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5 * 60 * 1000);
const DEFAULT_LOOKBACK_HOURS = Number(process.env.DEFAULT_LOOKBACK_HOURS || 24);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 45_000);
const MAX_RUN_HISTORY = Number(process.env.MAX_RUN_HISTORY || 200);
const MAX_ALERT_HISTORY = Number(process.env.MAX_ALERT_HISTORY || 200);
const BROWSER_EXECUTABLE_CANDIDATES = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function toIsoNow() {
  return new Date().toISOString();
}

function createHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getLaunchOptions() {
  const executablePath = BROWSER_EXECUTABLE_CANDIDATES.find(
    (candidate) => candidate && fs.existsSync(candidate)
  );

  return {
    executablePath,
    headless: true,
  };
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

  const normalized = String(value).trim();
  if (!normalized) {
    return "";
  }

  const trimmed = normalized.replace(/[#/]$/, "");
  const pieces = trimmed.split(/[\/#]/).filter(Boolean);
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
    const existing = bucket.get(key) || [];
    existing.push(makeValue(item));
    bucket.set(key, existing);
  }

  return Array.from(bucket.entries())
    .map(([key, values]) => ({
      key,
      values: uniqSorted(values.map((entry) => stableStringify(entry))),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeSnapshot(rawSnapshot) {
  const meta = groupCollection(
    rawSnapshot.meta || [],
    (item) => `${item.kind}:${item.key}`,
    (item) => ({
      content: item.content,
      location: item.location,
    })
  );

  const alternates = (rawSnapshot.alternates || [])
    .map((item) => ({
      href: item.href,
      hreflang: item.hreflang || "default",
      rel: item.rel,
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

  const jsonLd = (rawSnapshot.jsonLd || [])
    .map((item) => ({
      digest: item.validJson ? createHash(stableStringify(item.parsedJson)) : createHash(item.rawText || ""),
      schemaTypes: uniqSorted((item.schemaTypes || []).map(normalizeSchemaTypeLabel)),
      validJson: item.validJson,
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

  const microdata = groupCollection(
    rawSnapshot.microdata || [],
    (item) => item.itemType || "anonymous",
    (item) => ({
      itemProp: item.itemProp || "",
      tag: item.tag,
    })
  );

  const rdfa = groupCollection(
    rawSnapshot.rdfa || [],
    (item) => `${item.typeOf || ""}|${item.property || ""}|${item.vocab || ""}`,
    (item) => ({
      tag: item.tag,
    })
  );

  return {
    canonical: rawSnapshot.canonical || "",
    counts: rawSnapshot.counts || {},
    jsonLd,
    meta,
    microdata,
    productDescription: rawSnapshot.productDescription || "",
    rdfa,
    structuredDataTypes: uniqSorted(rawSnapshot.structuredDataTypes || []),
    title: rawSnapshot.title || "",
    url: rawSnapshot.url,
    visibilityChecks: rawSnapshot.visibilityChecks || {},
    warnings: uniqSorted(rawSnapshot.warnings || []),
    alternates,
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
      changes.push(`${label} "${key}" cambiato.`);
    }
  }

  return changes;
}

function compareArrayAsSet(label, baselineItems, currentItems) {
  const before = uniqSorted((baselineItems || []).map((item) => stableStringify(item)));
  const after = uniqSorted((currentItems || []).map((item) => stableStringify(item)));

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return [`${label} cambiato.`];
  }

  return [];
}

function compareVisibilityChecks(baselineChecks, currentChecks) {
  const changes = [];
  const allKeys = Array.from(
    new Set([...Object.keys(baselineChecks || {}), ...Object.keys(currentChecks || {})])
  ).sort();

  for (const key of allKeys) {
    const before = Boolean(baselineChecks?.[key]);
    const after = Boolean(currentChecks?.[key]);

    if (before !== after) {
      changes.push(`Controllo di visibilita "${key}" cambiato da ${before} a ${after}.`);
    }
  }

  return changes;
}

function diffSnapshots(baselineSnapshot, currentSnapshot) {
  const changes = [];

  if ((baselineSnapshot.title || "") !== (currentSnapshot.title || "")) {
    changes.push("Title cambiato.");
  }

  if ((baselineSnapshot.canonical || "") !== (currentSnapshot.canonical || "")) {
    changes.push("Canonical cambiata.");
  }

  changes.push(...compareGroupedEntries("Meta", baselineSnapshot.meta || [], currentSnapshot.meta || []));
  changes.push(
    ...compareGroupedEntries("Microdata", baselineSnapshot.microdata || [], currentSnapshot.microdata || [])
  );
  changes.push(...compareGroupedEntries("RDFa", baselineSnapshot.rdfa || [], currentSnapshot.rdfa || []));
  changes.push(...compareArrayAsSet("Tag alternate", baselineSnapshot.alternates || [], currentSnapshot.alternates || []));
  changes.push(...compareArrayAsSet("Blocchi JSON-LD", baselineSnapshot.jsonLd || [], currentSnapshot.jsonLd || []));
  changes.push(
    ...compareVisibilityChecks(
      baselineSnapshot.visibilityChecks || {},
      currentSnapshot.visibilityChecks || {}
    )
  );

  if (JSON.stringify(baselineSnapshot.warnings || []) !== JSON.stringify(currentSnapshot.warnings || [])) {
    changes.push("Warnings tecnici cambiati.");
  }

  const changed = changes.length > 0;

  return {
    changed,
    changes,
    summary: changed ? changes[0] : "Nessuna variazione rispetto alla baseline.",
  };
}

function getDefaultLabel(urlString) {
  const parsed = new URL(urlString);
  const suffix = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  return `${parsed.host}${suffix}`;
}

async function extractSnapshot(page, target) {
  const safeUrl = validateMonitorUrl(target.url);

  await page.goto(safeUrl, {
    timeout: NAVIGATION_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });

  try {
    await page.waitForLoadState("networkidle", { timeout: 7_500 });
  } catch {
    // Alcune pagine non raggiungono mai networkidle: in quel caso lavoriamo comunque sul DOM corrente.
  }

  const rawSnapshot = await page.evaluate(() => {
    const toAbsoluteUrl = (value) => {
      if (!value) {
        return "";
      }

      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    };

    const meta = Array.from(document.querySelectorAll("meta"))
      .map((element) => {
        const key =
          element.getAttribute("name") ||
          element.getAttribute("property") ||
          element.getAttribute("http-equiv") ||
          (element.hasAttribute("charset") ? "charset" : "");

        const kind = element.getAttribute("name")
          ? "name"
          : element.getAttribute("property")
            ? "property"
            : element.getAttribute("http-equiv")
              ? "http-equiv"
              : element.hasAttribute("charset")
                ? "charset"
                : "other";

        return {
          content: element.getAttribute("content") || element.getAttribute("charset") || "",
          key,
          kind,
          location: document.head?.contains(element) ? "head" : "body",
        };
      })
      .filter((item) => item.key || item.content);

    const alternates = Array.from(document.querySelectorAll("link[rel]"))
      .map((element) => ({
        href: toAbsoluteUrl(element.getAttribute("href")),
        hreflang: element.getAttribute("hreflang") || "",
        rel: (element.getAttribute("rel") || "").toLowerCase(),
      }))
      .filter((item) => item.rel.split(/\s+/).some((token) => ["canonical", "alternate"].includes(token)));

    const canonical =
      alternates.find((item) => item.rel.split(/\s+/).includes("canonical"))?.href || "";

    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
      (element) => {
        const rawText = element.textContent || "";

        try {
          const parsedJson = JSON.parse(rawText);
          const schemaTypes = [];

          const visitJsonTree = (node) => {
            if (Array.isArray(node)) {
              for (const entry of node) {
                visitJsonTree(entry);
              }

              return;
            }

            if (!node || typeof node !== "object") {
              return;
            }

            const type = node["@type"];
            const types = Array.isArray(type) ? type : type ? [type] : [];
            schemaTypes.push(...types.filter(Boolean));

            for (const value of Object.values(node)) {
              visitJsonTree(value);
            }
          };

          visitJsonTree(parsedJson);

          return {
            parsedJson,
            rawText,
            schemaTypes,
            validJson: true,
          };
        } catch (error) {
          return {
            parsedJson: null,
            rawText,
            schemaTypes: [],
            validJson: false,
          };
        }
      }
    );

    const microdata = Array.from(document.querySelectorAll("[itemscope]")).map((element) => ({
      itemProp: element.getAttribute("itemprop") || "",
      itemType: element.getAttribute("itemtype") || "",
      tag: element.tagName.toLowerCase(),
    }));

    const rdfa = Array.from(document.querySelectorAll("[typeof],[property],[vocab]")).map((element) => ({
      property: element.getAttribute("property") || "",
      tag: element.tagName.toLowerCase(),
      typeOf: element.getAttribute("typeof") || "",
      vocab: element.getAttribute("vocab") || "",
    }));

    const warnings = [];
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

        if (productDescriptionFromJsonLd) {
          return;
        }

        const hasProductType = types.some(
          (candidate) => normalizeSchemaTypeLabel(candidate).toLowerCase() === "product"
        );

        if (hasProductType && typeof node.description === "string" && node.description.trim()) {
          productDescriptionFromJsonLd = node.description.trim();
        }
      });
    }

    const normalizedStructuredDataTypes = uniqSorted([
      ...structuredDataTypes,
      ...microdata
        .map((item) => item.itemType)
        .filter(Boolean)
        .map(normalizeSchemaTypeLabel),
      ...rdfa
        .map((item) => item.typeOf)
        .filter(Boolean)
        .flatMap((value) => value.split(/\s+/).filter(Boolean).map(normalizeSchemaTypeLabel)),
    ]);

    if (meta.some((item) => item.location !== "head")) {
      warnings.push("Sono presenti meta tag fuori dal <head>.");
    }

    if (jsonLd.some((item) => !item.validJson)) {
      warnings.push("Uno o piu blocchi JSON-LD non sono parseabili.");
    }

    return {
      alternates,
      canonical,
      counts: {
        jsonLd: jsonLd.length,
        meta: meta.length,
        microdata: microdata.length,
        rdfa: rdfa.length,
      },
      jsonLd,
      meta,
      microdata,
      productDescription: productDescriptionFromJsonLd || descriptionMeta,
      rdfa,
      structuredDataTypes: normalizedStructuredDataTypes,
      title: document.title || "",
      url: window.location.href,
      visibilityChecks: {
        domReady: document.readyState === "interactive" || document.readyState === "complete",
        hasHead: Boolean(document.head),
        hasStructuredData: jsonLd.length > 0 || microdata.length > 0 || rdfa.length > 0,
        jsonLdParseable: jsonLd.every((item) => item.validJson),
        metadataInHead: meta.every((item) => item.location === "head"),
      },
      warnings,
    };
  });

  const normalized = normalizeSnapshot({
    ...rawSnapshot,
    jsonLd: (rawSnapshot.jsonLd || []).map((entry) => ({
      ...entry,
      parsedJson: entry.parsedJson ? sortObject(entry.parsedJson) : null,
    })),
  });

  return {
    fingerprint: createHash(stableStringify(normalized)),
    normalized,
    summary: summarizeSnapshot(normalized),
  };
}

function buildAlert({ target, type, summary, details, signature, runId, status }) {
  return {
    id: crypto.randomUUID(),
    createdAt: toIsoNow(),
    details,
    runId,
    signature,
    status: status || "open",
    summary,
    targetId: target.id,
    targetLabel: target.label,
    targetUrl: target.url,
    type,
  };
}

function dedupeAlert(state, nextAlert) {
  const existing = state.alerts.find(
    (alert) =>
      alert.status === "open" &&
      alert.targetId === nextAlert.targetId &&
      alert.signature === nextAlert.signature &&
      alert.type === nextAlert.type
  );

  if (existing) {
    existing.lastSeenAt = toIsoNow();
    existing.repeatCount = (existing.repeatCount || 1) + 1;
    return existing;
  }

  state.alerts.unshift(nextAlert);
  state.alerts = state.alerts.slice(0, MAX_ALERT_HISTORY);
  return nextAlert;
}

function createMonitor(storage) {
  let browserPromise;
  let schedulerTimer;
  let sweepInProgress = false;
  const runningTargets = new Set();
  const runtimeState = {
    lastSweepAt: null,
    lastSweepError: null,
    nextSweepAt: null,
  };

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = chromium.launch(getLaunchOptions());
    }

    return browserPromise;
  }

  function markRun(state, runId, patch) {
    const run = state.runs.find((entry) => entry.id === runId);
    if (run) {
      Object.assign(run, patch);
    }
  }

  function isDue(target) {
    if (!target.active || runningTargets.has(target.id)) {
      return false;
    }

    if (!target.lastCheckAt) {
      return true;
    }

    const hours = Number(target.checkEveryHours || DEFAULT_LOOKBACK_HOURS);
    const nextRunAt = new Date(target.lastCheckAt).getTime() + hours * 60 * 60 * 1000;
    return Date.now() >= nextRunAt;
  }

  async function runTargetCheck(targetId) {
    if (runningTargets.has(targetId)) {
      return { queued: false, reason: "already-running" };
    }

    runningTargets.add(targetId);

    const runId = crypto.randomUUID();
    let targetSnapshot = null;

    try {
      await storage.withState((state) => {
        const target = state.targets.find((entry) => entry.id === targetId);

        if (!target) {
          throw new Error("Target non trovato.");
        }

        target.status = "running";
        target.lastError = null;
        target.updatedAt = toIsoNow();

        state.runs.unshift({
          id: runId,
          startedAt: toIsoNow(),
          status: "running",
          summary: "Controllo avviato.",
          targetId: target.id,
          targetLabel: target.label,
          targetUrl: target.url,
        });

        state.runs = state.runs.slice(0, MAX_RUN_HISTORY);
      });

      const browser = await getBrowser();
      const page = await browser.newPage();

      try {
        const state = await storage.readState();
        const target = state.targets.find((entry) => entry.id === targetId);

        if (!target) {
          throw new Error("Target rimosso prima del controllo.");
        }

        targetSnapshot = await extractSnapshot(page, target);

        await storage.withState((draft) => {
          const targetInState = draft.targets.find((entry) => entry.id === targetId);

          if (!targetInState) {
            throw new Error("Target non trovato durante il salvataggio.");
          }

          const baseline = targetInState.baselineSnapshot;
          const now = toIsoNow();
          targetInState.lastCheckAt = now;
          targetInState.lastSnapshot = {
            capturedAt: now,
            fingerprint: targetSnapshot.fingerprint,
            normalized: targetSnapshot.normalized,
            summary: targetSnapshot.summary,
          };
          targetInState.updatedAt = now;

          if (!baseline) {
            targetInState.baselineSnapshot = {
              capturedAt: now,
              fingerprint: targetSnapshot.fingerprint,
              normalized: targetSnapshot.normalized,
              summary: targetSnapshot.summary,
            };
            targetInState.status = "baseline";

            markRun(draft, runId, {
              finishedAt: now,
              status: "baseline",
              summary: "Baseline creata con il primo snapshot valido.",
            });

            return;
          }

          const diff = diffSnapshots(baseline.normalized, targetSnapshot.normalized);
          const changed = diff.changed;

          targetInState.status = changed ? "changed" : "ok";
          targetInState.lastChangeAt = changed ? now : targetInState.lastChangeAt || null;

          markRun(draft, runId, {
            diff,
            finishedAt: now,
            snapshotFingerprint: targetSnapshot.fingerprint,
            status: changed ? "changed" : "ok",
            summary: changed ? diff.summary : "Nessuna differenza rispetto alla baseline.",
          });

          if (changed) {
            dedupeAlert(
              draft,
              buildAlert({
                details: diff.changes.concat(targetSnapshot.normalized.warnings),
                runId,
                signature: `${targetSnapshot.fingerprint}:${diff.summary}:${targetSnapshot.normalized.warnings.join("|")}`,
                status: "open",
                summary:
                  diff.summary ||
                  targetSnapshot.normalized.warnings[0] ||
                  "Sono state rilevate differenze rispetto alla baseline.",
                target: targetInState,
                type: "diff",
              })
            );
          }
        });
      } finally {
        await page.close();
      }

      return {
        queued: true,
        snapshot: targetSnapshot,
      };
    } catch (error) {
      await storage.withState((state) => {
        const target = state.targets.find((entry) => entry.id === targetId);

        if (target) {
          target.status = "error";
          target.lastCheckAt = toIsoNow();
          target.lastError = error.message;
          target.updatedAt = toIsoNow();

          dedupeAlert(
            state,
            buildAlert({
              details: [error.message],
              runId,
              signature: `error:${error.message}`,
              summary: "Errore durante il controllo della pagina.",
              target,
              type: "error",
            })
          );
        }

        markRun(state, runId, {
          error: error.message,
          finishedAt: toIsoNow(),
          status: "error",
          summary: "Il controllo e terminato con errore.",
        });
      });

      return {
        error: error.message,
        queued: false,
      };
    } finally {
      runningTargets.delete(targetId);
    }
  }

  async function queueTargetCheck(targetId) {
    void runTargetCheck(targetId).catch((error) => {
      console.error(`Errore nel check del target ${targetId}:`, error.message);
    });
    return { queued: true };
  }

  async function scanDueTargets() {
    if (sweepInProgress) {
      return;
    }

    sweepInProgress = true;
    runtimeState.lastSweepError = null;

    try {
      const state = await storage.readState();
      const dueTargets = state.targets.filter(isDue);

      for (const target of dueTargets) {
        await runTargetCheck(target.id);
      }

      runtimeState.lastSweepAt = toIsoNow();
      runtimeState.nextSweepAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
    } catch (error) {
      runtimeState.lastSweepError = error.message;
      runtimeState.lastSweepAt = toIsoNow();
      runtimeState.nextSweepAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
    } finally {
      sweepInProgress = false;
    }
  }

  function startScheduler() {
    if (schedulerTimer) {
      return;
    }

    runtimeState.nextSweepAt = new Date(Date.now() + CHECK_INTERVAL_MS).toISOString();
    schedulerTimer = setInterval(() => {
      void scanDueTargets();
    }, CHECK_INTERVAL_MS);

    setTimeout(() => {
      void scanDueTargets();
    }, 1_250);
  }

  async function stopScheduler() {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }

    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  }

  function getRuntimeStatus() {
    return {
      checkIntervalMinutes: Math.round(CHECK_INTERVAL_MS / 60_000),
      lastSweepAt: runtimeState.lastSweepAt,
      lastSweepError: runtimeState.lastSweepError,
      nextSweepAt: runtimeState.nextSweepAt,
      runningTargetIds: Array.from(runningTargets),
      sweepInProgress,
    };
  }

  return {
    getDefaultLabel,
    getRuntimeStatus,
    queueTargetCheck,
    runTargetCheck,
    scanDueTargets,
    startScheduler,
    stopScheduler,
  };
}

module.exports = {
  createMonitor,
};
