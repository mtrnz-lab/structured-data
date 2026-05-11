const MAX_RECENT_RUNS = 5;

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toBoolean(value) {
  return value === 1 || value === true || value === "1";
}

function mapTargetRow(row) {
  return {
    active: toBoolean(row.active),
    baselineSnapshot: safeJsonParse(row.baseline_snapshot_json, null),
    checkEveryHours: Number(row.check_every_hours || 24),
    createdAt: row.created_at,
    id: row.id,
    label: row.label,
    lastChangeAt: row.last_change_at,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    lastSnapshot: safeJsonParse(row.last_snapshot_json, null),
    pausedFromStatus: row.paused_from_status,
    status: row.status,
    updatedAt: row.updated_at,
    url: row.url,
  };
}

function mapAlertRow(row) {
  return {
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    details: safeJsonParse(row.details_json, []),
    id: row.id,
    lastSeenAt: row.last_seen_at,
    repeatCount: Number(row.repeat_count || 1),
    runId: row.run_id,
    signature: row.signature,
    status: row.status,
    summary: row.summary,
    targetId: row.target_id,
    targetLabel: row.target_label,
    targetUrl: row.target_url,
    type: row.type,
  };
}

function mapRunRow(row) {
  return {
    diff: safeJsonParse(row.diff_json, null),
    error: row.error,
    finishedAt: row.finished_at,
    id: row.id,
    snapshotFingerprint: row.snapshot_fingerprint,
    startedAt: row.started_at,
    status: row.status,
    summary: row.summary,
    targetId: row.target_id,
    targetLabel: row.target_label,
    targetUrl: row.target_url,
  };
}

function serializeValue(key, value) {
  if (value === undefined) {
    return value;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (key.endsWith("Snapshot") || key === "diff" || key === "details") {
    return JSON.stringify(value);
  }

  return value;
}

function buildUpdateParts(patch, mapping) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  const setClauses = [];
  const bindings = [];

  for (const [key, value] of entries) {
    const column = mapping[key];

    if (!column) {
      continue;
    }

    setClauses.push(`${column} = ?`);
    bindings.push(serializeValue(key, value));
  }

  return { bindings, setClauses };
}

export async function queryAll(env, sql, bindings = []) {
  const statement = env.DB.prepare(sql);
  const result = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
  return result.results || [];
}

export async function queryFirst(env, sql, bindings = []) {
  const rows = await queryAll(env, sql, bindings);
  return rows[0] || null;
}

export async function execute(env, sql, bindings = []) {
  const statement = env.DB.prepare(sql);
  return bindings.length ? statement.bind(...bindings).run() : statement.run();
}

export function getNowIso() {
  return new Date().toISOString();
}

export async function createTarget(env, { label, url, defaultLabel }) {
  const existing = await queryFirst(env, "SELECT id FROM targets WHERE url = ?", [url]);

  if (existing) {
    throw new Error("This URL is already being monitored.");
  }

  const createdAt = getNowIso();
  const id = crypto.randomUUID();
  const finalLabel = label || defaultLabel(url);

  await execute(
    env,
    `INSERT INTO targets (
      id, url, label, active, check_every_hours, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, url, finalLabel, 1, 24, "queued", createdAt, createdAt]
  );

  return getTargetById(env, id);
}

export async function getTargetById(env, targetId) {
  const row = await queryFirst(env, "SELECT * FROM targets WHERE id = ?", [targetId]);
  return row ? mapTargetRow(row) : null;
}

export async function listTargets(env) {
  const targetRows = await queryAll(env, "SELECT * FROM targets ORDER BY created_at ASC");
  const openAlertRows = await queryAll(
    env,
    "SELECT target_id, COUNT(*) AS open_alerts FROM alerts WHERE status = 'open' GROUP BY target_id"
  );
  const runRows = await queryAll(env, "SELECT * FROM runs ORDER BY started_at DESC LIMIT 500");

  const openAlertsMap = new Map(
    openAlertRows.map((row) => [row.target_id, Number(row.open_alerts || 0)])
  );
  const recentRunsMap = new Map();

  for (const row of runRows) {
    const list = recentRunsMap.get(row.target_id) || [];
    if (list.length < MAX_RECENT_RUNS) {
      list.push(mapRunRow(row));
      recentRunsMap.set(row.target_id, list);
    }
  }

  return targetRows.map((row) => {
    const target = mapTargetRow(row);
    return {
      ...target,
      openAlerts: openAlertsMap.get(target.id) || 0,
      recentRuns: recentRunsMap.get(target.id) || [],
    };
  });
}

export async function listAlerts(env) {
  const rows = await queryAll(env, "SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200");
  return rows.map(mapAlertRow);
}

export async function getRuntimeStatus(env) {
  const rows = await queryAll(
    env,
    "SELECT key, value FROM app_state WHERE key IN ('last_sweep_at', 'last_sweep_error', 'last_sweep_source')"
  );
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  return {
    checkIntervalMinutes: 1440,
    lastSweepAt: values.last_sweep_at || null,
    lastSweepError: values.last_sweep_error || null,
    lastSweepSource: values.last_sweep_source || "cloudflare-cron",
    nextSweepAt: null,
    runningTargetIds: [],
    sweepInProgress: false,
  };
}

export async function getDashboardStatus(env) {
  const counts = await queryFirst(
    env,
    `SELECT
      COUNT(*) AS total_targets,
      SUM(CASE WHEN status = 'changed' THEN 1 ELSE 0 END) AS changed_targets,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_targets
    FROM targets`
  );
  const alerts = await queryFirst(
    env,
    "SELECT COUNT(*) AS open_alerts FROM alerts WHERE status = 'open'"
  );
  const runtime = await getRuntimeStatus(env);

  return {
    changedTargets: Number(counts?.changed_targets || 0),
    dbPath: "Cloudflare D1",
    okTargets: Number(counts?.ok_targets || 0),
    openAlerts: Number(alerts?.open_alerts || 0),
    runtime,
    totalTargets: Number(counts?.total_targets || 0),
  };
}

export async function insertRun(env, run) {
  await execute(
    env,
    `INSERT INTO runs (
      id, started_at, status, summary, target_id, target_label, target_url, diff_json,
      snapshot_fingerprint, error, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.startedAt,
      run.status,
      run.summary,
      run.targetId,
      run.targetLabel,
      run.targetUrl,
      serializeValue("diff", run.diff ?? null),
      run.snapshotFingerprint ?? null,
      run.error ?? null,
      run.finishedAt ?? null,
    ]
  );
}

export async function updateRun(env, runId, patch) {
  const mapping = {
    diff: "diff_json",
    error: "error",
    finishedAt: "finished_at",
    snapshotFingerprint: "snapshot_fingerprint",
    status: "status",
    summary: "summary",
  };
  const { bindings, setClauses } = buildUpdateParts(patch, mapping);

  if (setClauses.length === 0) {
    return;
  }

  await execute(env, `UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`, [...bindings, runId]);
}

export async function setTargetFields(env, targetId, patch) {
  const mapping = {
    active: "active",
    baselineSnapshot: "baseline_snapshot_json",
    checkEveryHours: "check_every_hours",
    lastChangeAt: "last_change_at",
    lastCheckAt: "last_check_at",
    lastError: "last_error",
    lastSnapshot: "last_snapshot_json",
    pausedFromStatus: "paused_from_status",
    status: "status",
    updatedAt: "updated_at",
  };
  const { bindings, setClauses } = buildUpdateParts(patch, mapping);

  if (setClauses.length === 0) {
    return;
  }

  await execute(env, `UPDATE targets SET ${setClauses.join(", ")} WHERE id = ?`, [...bindings, targetId]);
}

export async function findOpenAlert(env, { signature, targetId, type }) {
  const row = await queryFirst(
    env,
    "SELECT * FROM alerts WHERE status = 'open' AND target_id = ? AND signature = ? AND type = ? LIMIT 1",
    [targetId, signature, type]
  );

  return row ? mapAlertRow(row) : null;
}

export async function insertAlert(env, alert) {
  await execute(
    env,
    `INSERT INTO alerts (
      id, created_at, details_json, run_id, signature, status, summary, target_id,
      target_label, target_url, type, acknowledged_at, last_seen_at, repeat_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      alert.id,
      alert.createdAt,
      serializeValue("details", alert.details),
      alert.runId ?? null,
      alert.signature,
      alert.status,
      alert.summary,
      alert.targetId,
      alert.targetLabel,
      alert.targetUrl,
      alert.type,
      alert.acknowledgedAt ?? null,
      alert.lastSeenAt ?? null,
      alert.repeatCount ?? 1,
    ]
  );
}

export async function updateAlert(env, alertId, patch) {
  const mapping = {
    acknowledgedAt: "acknowledged_at",
    lastSeenAt: "last_seen_at",
    repeatCount: "repeat_count",
    status: "status",
  };
  const { bindings, setClauses } = buildUpdateParts(patch, mapping);

  if (setClauses.length === 0) {
    return;
  }

  await execute(env, `UPDATE alerts SET ${setClauses.join(", ")} WHERE id = ?`, [...bindings, alertId]);
}

export async function ackAlert(env, alertId) {
  const existing = await queryFirst(env, "SELECT * FROM alerts WHERE id = ?", [alertId]);

  if (!existing) {
    throw new Error("Alert not found.");
  }

  await updateAlert(env, alertId, {
    acknowledgedAt: getNowIso(),
    status: "acknowledged",
  });

  const updated = await queryFirst(env, "SELECT * FROM alerts WHERE id = ?", [alertId]);
  return mapAlertRow(updated);
}

export async function deleteTarget(env, targetId) {
  await execute(env, "DELETE FROM alerts WHERE target_id = ?", [targetId]);
  await execute(env, "DELETE FROM runs WHERE target_id = ?", [targetId]);
  await execute(env, "DELETE FROM targets WHERE id = ?", [targetId]);
}

export async function toggleTarget(env, targetId) {
  const target = await getTargetById(env, targetId);

  if (!target) {
    throw new Error("Target not found.");
  }

  const updatedAt = getNowIso();

  if (target.active) {
    await setTargetFields(env, targetId, {
      active: false,
      pausedFromStatus: target.status,
      status: "paused",
      updatedAt,
    });
  } else {
    await setTargetFields(env, targetId, {
      active: true,
      pausedFromStatus: null,
      status: target.pausedFromStatus || (target.lastError ? "error" : target.baselineSnapshot ? "ok" : "queued"),
      updatedAt,
    });
  }

  return getTargetById(env, targetId);
}

export async function resetBaseline(env, targetId) {
  const target = await getTargetById(env, targetId);

  if (!target) {
    throw new Error("Target not found.");
  }

  const updatedAt = getNowIso();

  if (target.lastSnapshot) {
    await setTargetFields(env, targetId, {
      baselineSnapshot: target.lastSnapshot,
      status: "ok",
      updatedAt,
    });
  } else {
    await setTargetFields(env, targetId, {
      baselineSnapshot: null,
      status: "queued",
      updatedAt,
    });
  }

  return getTargetById(env, targetId);
}

export async function listDueTargets(env) {
  const targets = (await queryAll(env, "SELECT * FROM targets WHERE active = 1")).map(mapTargetRow);

  return targets.filter((target) => {
    if (!target.lastCheckAt) {
      return true;
    }

    const nextRunAt = new Date(target.lastCheckAt).getTime() + target.checkEveryHours * 60 * 60 * 1000;
    return Date.now() >= nextRunAt;
  });
}

export async function setAppStateValues(env, patch) {
  const updatedAt = getNowIso();
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);

  for (const [key, value] of entries) {
    await execute(
      env,
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value ?? null, updatedAt]
    );
  }
}
