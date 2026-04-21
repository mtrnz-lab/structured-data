# DOM Metadata Monitor

Applicazione web per monitorare una volta al giorno delle URL inserite manualmente, confrontare la baseline dei metadati e dei dati strutturati nel DOM renderizzato e mostrare eventuali anomalie dentro una dashboard web raggiungibile online.

## Cosa fa

- acquisisce il DOM renderizzato con Playwright
- estrae `title`, `meta`, `canonical`, `alternate`, JSON-LD, microdata e RDFa
- crea una baseline al primo check valido
- riesegue il controllo ogni 24 ore
- genera un alert quando il codice cambia rispetto alla baseline o quando i blocchi strutturati non risultano parseabili o correttamente posizionati
- espone una dashboard web per URL, stato, storico breve e notifiche

## Architettura

- `src/server.js`: server HTTP, API e pubblicazione della dashboard
- `src/monitor.js`: acquisizione snapshot, normalizzazione, confronto e scheduler
- `src/storage.js`: persistenza JSON locale in `data/db.json`
- `public/`: dashboard HTML, CSS e JavaScript senza framework

## Avvio locale con il runtime bundled di Codex

Da PowerShell:

```powershell
cd C:\Users\frebeschini\Documents\Codex\2026-04-17-puoi-svilupparmi-una-soluzione-che-monitori
.\scripts\start-local.ps1
```

La dashboard sara disponibile su [http://localhost:4010](http://localhost:4010).

## Avvio in un ambiente Node standard

```bash
npm install
npm start
```

## Utilizzo

1. Apri la dashboard.
2. Inserisci una URL e, se vuoi, una label leggibile.
3. Il primo check viene messo in coda e crea la baseline.
4. I check successivi confrontano la pagina corrente con la baseline.
5. Se cambia `title`, set di meta tag, canonical, hreflang, JSON-LD, microdata, RDFa o un controllo di visibilita, compare un alert in dashboard.

## Note importanti

- Il controllo viene eseguito sul DOM renderizzato, non solo sull'HTML statico.
- I metadati vengono considerati "correttamente visibili" quando sono effettivamente presenti nel DOM e i `meta` risultano nel `<head>`.
- I blocchi JSON-LD vengono considerati sani quando sono presenti e parseabili.
- In locale l'app prova prima a usare il browser Playwright installato; se non e disponibile, prova automaticamente con Microsoft Edge o Google Chrome gia presenti sulla macchina.
- Lo storage e locale su file JSON. In produzione puoi montare un volume persistente oppure sostituire `storage.js` con un database.

## Pubblicazione online

Per avere una dashboard raggiungibile via web puoi:

- deployare il progetto in Docker usando il `Dockerfile` incluso
- pubblicarlo su una VM o container app che supporti Playwright
- collegare un reverse proxy o un hostname pubblico per rendere raggiungibile la dashboard

Una volta deployata, la dashboard diventa il punto unico dove vedere gli alert di cambiamento.
