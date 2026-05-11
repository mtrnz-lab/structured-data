# DOM Metadata Monitor

Web application that monitors manually entered URLs once per day, compares a metadata and structured data baseline against the rendered DOM, and surfaces anomalies in an online dashboard.

## What it does

- captures browser-rendered HTML
- extracts `title`, `meta`, `canonical`, `alternate`, JSON-LD, microdata, and RDFa
- creates a baseline from the first valid check
- runs later checks and compares the current snapshot with the baseline
- generates alerts when code changes
- exposes a web dashboard for URLs, status, recent history, and notifications

## Current architecture

The repository includes two modes:

- local Node mode:
  - `src/server.js`
  - `src/monitor.js`
  - `src/storage.js`
- Cloudflare mode:
  - `public/`: dashboard static assets
  - `public/_worker.js`: Pages advanced mode entrypoint
  - `cloudflare/pages-worker.mjs`: HTTP API for Cloudflare Pages
  - `cloudflare/shared/`: shared storage, parsing, diff, and security logic
  - `workers/scheduler.mjs`: separate worker with a daily cron trigger
  - `migrations/001_init.sql`: D1 schema
  - `wrangler.jsonc`: Pages configuration
  - `wrangler.scheduler.jsonc`: scheduler worker configuration

## Run locally with Node

From PowerShell:

```powershell
cd C:\Users\frebeschini\Documents\Codex\2026-04-17-puoi-svilupparmi-una-soluzione-che-monitori
.\scripts\start-local.ps1
```

The dashboard will be available at [http://localhost:4010](http://localhost:4010).

## Cloudflare stack

The Cloudflare version uses:

- Cloudflare Pages for the dashboard and API
- Pages Functions in advanced mode through `public/_worker.js`
- D1 for persistent storage
- Browser Run REST API to fetch rendered HTML
- a separate Worker with a daily cron trigger

## Cloudflare prerequisites

You need:

- a Cloudflare account
- a Pages project
- a D1 database
- a Cloudflare API token with `Browser Rendering - Edit`
- your Cloudflare `account_id`
- dashboard credentials: `MONITOR_USERNAME` and `MONITOR_PASSWORD`

## 1. Install dependencies

```bash
npm install
```

## 2. Configure local secrets

Create a `.dev.vars` file from `.dev.vars.example`:

```env
CLOUDFLARE_ACCOUNT_ID=your_account_id
BROWSER_RUN_API_TOKEN=your_browser_run_api_token
MONITOR_USERNAME=admin
MONITOR_PASSWORD=choose_a_long_random_password
```

The dashboard and all APIs are protected with `Basic Auth`. Without `MONITOR_USERNAME` and `MONITOR_PASSWORD`, the service rejects requests.

For local Node mode, you can also create `.local.env` from `.local.env.example`.

## 3. Create the D1 database

Create a database named `structured-data-monitor` from the Cloudflare dashboard or CLI.

Then replace `REPLACE_WITH_D1_DATABASE_ID` in:

- `wrangler.jsonc`
- `wrangler.scheduler.jsonc`

If you want to use a different database name, also update the `cf:db:apply-local` and `cf:db:apply-remote` scripts in `package.json`.

## 4. Apply the D1 migration

Local:

```bash
npm run cf:db:apply-local
```

Remote:

```bash
npm run cf:db:apply-remote
```

## 5. Test Pages locally

```bash
npm run cf:pages:dev
```

This serves assets from `public/` and activates the Cloudflare API through `_worker.js`.

## 6. Deploy the dashboard to Pages

Recommended option:

1. Go to Cloudflare `Workers & Pages`
2. Create a Pages project connected to your GitHub repository
3. Set the output directory to `public`
4. Add the D1 binding `DB`
5. Add these secrets:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `BROWSER_RUN_API_TOKEN`
   - `MONITOR_USERNAME`
   - `MONITOR_PASSWORD`
6. Deploy the project

Or via CLI:

```bash
npm run cf:pages:deploy
```

## 7. Deploy the daily scheduler worker

The periodic check does not run inside Pages. It uses the separate worker in `workers/scheduler.mjs`.

Deploy:

```bash
npm run cf:cron:deploy
```

Then configure the following on the worker:

- secret `CLOUDFLARE_ACCOUNT_ID`
- secret `BROWSER_RUN_API_TOKEN`
- secret `MONITOR_USERNAME`
- secret `MONITOR_PASSWORD`
- D1 binding `DB`

The default cron is:

```text
0 6 * * *
```

That means one run per day at `06:00 UTC`.

If you want to change the schedule, edit `wrangler.scheduler.jsonc`.

## How it works on Cloudflare

- the dashboard keeps calling `/api/status`, `/api/targets`, and `/api/alerts`
- the Cloudflare backend stores targets, snapshots, runs, and alerts in D1
- when you add a URL or trigger a manual check, Pages calls Browser Run and updates D1
- once per day, the scheduler worker checks active URLs and updates the state

## Important notes

- the Cloudflare version uses Browser Run rendered HTML, not local Playwright
- runtime storage is no longer file-based JSON; it uses D1
- `data/db.json` stays excluded from the repository and is only used by local Node mode
- the local Node backend was not removed, so you can still use `localhost:4010`
- endpoints accept only `http/https` URLs and block local or private hosts
- both the online and local dashboards require HTTP Basic authentication

## Main Cloudflare files

- `public/_worker.js`
- `cloudflare/pages-worker.mjs`
- `cloudflare/shared/repository.mjs`
- `cloudflare/shared/monitoring.mjs`
- `cloudflare/shared/security.mjs`
- `workers/scheduler.mjs`
- `migrations/001_init.sql`
- `wrangler.jsonc`
- `wrangler.scheduler.jsonc`
