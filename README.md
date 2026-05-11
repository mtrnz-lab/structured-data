# DOM Metadata Monitor

Applicazione web per monitorare ogni giorno delle URL inserite manualmente, confrontare la baseline dei metadati e dei dati strutturati nel DOM renderizzato e mostrare eventuali anomalie dentro una dashboard web.

## Cosa fa

- acquisisce HTML renderizzato lato browser
- estrae `title`, `meta`, `canonical`, `alternate`, JSON-LD, microdata e RDFa
- crea una baseline al primo check valido
- esegue controlli successivi e confronta lo snapshot corrente con la baseline
- genera alert quando il codice cambia
- espone una dashboard web per URL, stato, storico breve e notifiche

## Architettura attuale

Il repository contiene due modalita:

- locale Node:
  - `src/server.js`
  - `src/monitor.js`
  - `src/storage.js`
- Cloudflare:
  - `public/`: asset statici della dashboard
  - `public/_worker.js`: entrypoint Pages in advanced mode
  - `cloudflare/pages-worker.mjs`: API HTTP per Cloudflare Pages
  - `cloudflare/shared/`: logica condivisa di storage, parsing e diff
  - `workers/scheduler.mjs`: Worker separato con cron trigger giornaliero
  - `migrations/001_init.sql`: schema D1
- `wrangler.jsonc`: configurazione Pages
  - `wrangler.scheduler.jsonc`: configurazione Worker scheduler

## Avvio locale con Node

Da PowerShell:

```powershell
cd C:\Users\frebeschini\Documents\Codex\2026-04-17-puoi-svilupparmi-una-soluzione-che-monitori
.\scripts\start-local.ps1
```

La dashboard sara disponibile su [http://localhost:4010](http://localhost:4010).

## Stack Cloudflare

La versione Cloudflare usa:

- Cloudflare Pages per dashboard e API
- Pages Functions in advanced mode tramite `public/_worker.js`
- D1 come storage persistente
- Browser Run REST API per ottenere HTML renderizzato
- un Worker separato con Cron Trigger per il check giornaliero

## Prerequisiti Cloudflare

Ti servono:

- un account Cloudflare
- un progetto Pages
- un database D1
- un API token Cloudflare con permesso `Browser Rendering - Edit`
- l'`account_id` Cloudflare

## 1. Installa dipendenze

```bash
npm install
```

## 2. Configura i secret locali

Crea un file `.dev.vars` partendo da `.dev.vars.example`:

```env
CLOUDFLARE_ACCOUNT_ID=your_account_id
BROWSER_RUN_API_TOKEN=your_browser_run_api_token
```

## 3. Crea il database D1

Nel dashboard o via CLI crea un database chiamato `structured-data-monitor`.

Poi sostituisci `REPLACE_WITH_D1_DATABASE_ID` in:

- `wrangler.jsonc`
- `wrangler.scheduler.jsonc`

Se vuoi usare un nome diverso, aggiorna anche gli script `cf:db:apply-local` e `cf:db:apply-remote` in `package.json`.

## 4. Applica la migration D1

In locale:

```bash
npm run cf:db:apply-local
```

In remoto:

```bash
npm run cf:db:apply-remote
```

## 5. Testa Pages in locale

```bash
npm run cf:pages:dev
```

Questo serve gli asset da `public/` e attiva la API Cloudflare tramite `_worker.js`.

## 6. Deploy della dashboard su Pages

Opzione consigliata:

1. Vai in Cloudflare `Workers & Pages`
2. Crea un progetto Pages collegando il repo GitHub
3. Imposta come output directory `public`
4. Aggiungi il binding D1 `DB`
5. Aggiungi i secret:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `BROWSER_RUN_API_TOKEN`
6. Deploya il progetto

In alternativa via CLI:

```bash
npm run cf:pages:deploy
```

## 7. Deploy del worker scheduler giornaliero

Il check periodico non gira dentro Pages: usa il Worker separato in `workers/scheduler.mjs`.

Deploy:

```bash
npm run cf:cron:deploy
```

Poi configura nel dashboard del Worker:

- secret `CLOUDFLARE_ACCOUNT_ID`
- secret `BROWSER_RUN_API_TOKEN`
- binding D1 `DB`

Il cron di default e:

```text
0 6 * * *
```

cioe un'esecuzione al giorno alle `06:00 UTC`.

Se vuoi cambiare l'orario, modifica `wrangler.scheduler.jsonc`.

## Come funziona su Cloudflare

- la dashboard continua a chiamare `/api/status`, `/api/targets`, `/api/alerts`
- il backend Cloudflare salva target, snapshot, run e alert dentro D1
- quando aggiungi una URL o lanci un check manuale, Pages chiama Browser Run e aggiorna D1
- una volta al giorno il Worker scheduler esegue i controlli sulle URL attive e aggiorna lo stato

## Note importanti

- la versione Cloudflare usa HTML renderizzato via Browser Run, non Playwright locale
- lo storage runtime non e piu su file JSON ma su D1
- `data/db.json` resta escluso dal repo e serve solo alla modalita locale Node
- il backend locale Node non e stato rimosso: puoi continuare a usare `localhost:4010`

## File principali per Cloudflare

- `public/_worker.js`
- `cloudflare/pages-worker.mjs`
- `cloudflare/shared/repository.mjs`
- `cloudflare/shared/monitoring.mjs`
- `workers/scheduler.mjs`
- `migrations/001_init.sql`
- `wrangler.pages.jsonc`
- `wrangler.jsonc`
- `wrangler.scheduler.jsonc`
