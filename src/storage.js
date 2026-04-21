const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const EMPTY_STATE = {
  updatedAt: null,
  targets: [],
  alerts: [],
  runs: [],
};

let writeQueue = Promise.resolve();

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, JSON.stringify(EMPTY_STATE, null, 2), "utf8");
  }
}

async function readState() {
  await ensureStorage();
  const raw = await fs.readFile(DB_PATH, "utf8");
  const parsed = JSON.parse(raw);

  return {
    updatedAt: parsed.updatedAt ?? null,
    targets: Array.isArray(parsed.targets) ? parsed.targets : [],
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  };
}

async function writeState(state) {
  await ensureStorage();
  const tempPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, DB_PATH);
}

async function withState(mutator) {
  const operation = writeQueue.then(async () => {
    const state = await readState();
    const result = await mutator(state);
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    return result;
  });

  writeQueue = operation.catch(() => {});
  return operation;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DB_PATH,
  clone,
  ensureStorage,
  readState,
  withState,
};
