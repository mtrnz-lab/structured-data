const state = {
  alerts: [],
  expandedTargetId: null,
  status: null,
  targets: [],
};

const statusCards = document.querySelector("#status-cards");
const targetsList = document.querySelector("#targets-list");
const alertsList = document.querySelector("#alerts-list");
const form = document.querySelector("#target-form");
const feedback = document.querySelector("#form-feedback");
const emptyStateTemplate = document.querySelector("#empty-state-template");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateText(value, maxLength = 180) {
  if (!value) {
    return "";
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function escapeHtmlList(values) {
  return (values || []).map((value) => escapeHtml(value));
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function safeExternalHref(value) {
  return isSafeHttpUrl(value) ? value : "#";
}

function fullscreenIcon(expanded) {
  if (expanded) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 14H5v5h5v-2H7v-3zm0-4h2V7h3V5H5v5zm10 7h-3v2h5v-5h-2v3zm-3-12v2h3v3h2V5h-5z"></path>
    </svg>
  `;
}

function normalizeSchemaTypeLabel(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).trim().replace(/[#/]$/, "");
  const pieces = normalized.split(/[\/#]/).filter(Boolean);
  return pieces[pieces.length - 1] || normalized;
}

function parseGroupedValues(entry) {
  return (entry?.values || [])
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getSnapshotView(target) {
  return target.lastSnapshot || target.baselineSnapshot || null;
}

function getDerivedProductDescription(snapshotView, summary) {
  if (summary?.productDescription) {
    return summary.productDescription;
  }

  if (snapshotView?.normalized?.productDescription) {
    return snapshotView.normalized.productDescription;
  }

  const metaEntries = snapshotView?.normalized?.meta || [];
  const descriptionEntry = metaEntries.find((entry) => entry.key === "name:description");
  const ogDescriptionEntry = metaEntries.find((entry) => entry.key === "property:og:description");

  return (
    parseGroupedValues(descriptionEntry)[0]?.content ||
    parseGroupedValues(ogDescriptionEntry)[0]?.content ||
    ""
  );
}

function getDerivedAlternates(snapshotView, summary) {
  if (Array.isArray(summary?.alternates) && summary.alternates.length > 0) {
    return summary.alternates;
  }

  return snapshotView?.normalized?.alternates || [];
}

function getDerivedStructuredDataTypes(snapshotView, summary) {
  if (Array.isArray(summary?.structuredDataTypes) && summary.structuredDataTypes.length > 0) {
    return summary.structuredDataTypes;
  }

  if (Array.isArray(snapshotView?.normalized?.structuredDataTypes) && snapshotView.normalized.structuredDataTypes.length > 0) {
    return snapshotView.normalized.structuredDataTypes;
  }

  const jsonLdTypes = (snapshotView?.normalized?.jsonLd || []).flatMap((item) =>
    (item.schemaTypes || []).map(normalizeSchemaTypeLabel)
  );
  const microdataTypes = (snapshotView?.normalized?.microdata || []).map((item) =>
    normalizeSchemaTypeLabel(item.key || "")
  );
  const rdfaTypes = (snapshotView?.normalized?.rdfa || []).map((item) =>
    normalizeSchemaTypeLabel((item.key || "").split("|")[0] || "")
  );

  return Array.from(new Set([...jsonLdTypes, ...microdataTypes, ...rdfaTypes].filter(Boolean))).sort();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Richiesta fallita.");
  }

  return payload;
}

function formatDate(value) {
  if (!value) {
    return "mai";
  }

  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function chipClass(status) {
  return {
    baseline: "chip chip-blue",
    changed: "chip chip-amber",
    error: "chip chip-red",
    ok: "chip chip-green",
    paused: "chip chip-slate",
    queued: "chip chip-blue",
    running: "chip chip-blue",
  }[status] || "chip chip-slate";
}

function createEmptyState() {
  return emptyStateTemplate.content.firstElementChild.cloneNode(true);
}

function renderStatus() {
  if (!state.status) {
    return;
  }

  const runtime = state.status.runtime;

  statusCards.innerHTML = `
    <article>
      <span>URL monitorate</span>
      <strong>${state.status.totalTargets}</strong>
    </article>
    <article>
      <span>Alert aperti</span>
      <strong>${state.status.openAlerts}</strong>
    </article>
    <article>
      <span>Target changed</span>
      <strong>${state.status.changedTargets}</strong>
    </article>
    <article>
      <span>Ultimo sweep</span>
      <strong>${runtime.lastSweepAt ? formatDate(runtime.lastSweepAt) : "in attesa"}</strong>
    </article>
  `;
}

function renderAlerts() {
  alertsList.innerHTML = "";

  const openAlerts = state.alerts.filter((alert) => alert.status === "open");

  if (openAlerts.length === 0) {
    alertsList.appendChild(createEmptyState());
    return;
  }

  for (const alert of openAlerts) {
    const article = document.createElement("article");
    article.className = "alert-card";
    const detailMarkup = escapeHtmlList((alert.details || []).slice(0, 5))
      .map((detail) => `<li>${detail}</li>`)
      .join("");
    article.innerHTML = `
      <div class="alert-top">
        <div>
          <p class="eyebrow">${alert.type === "error" ? "Errore" : "Variazione rilevata"}</p>
          <h3>${escapeHtml(alert.targetLabel)}</h3>
        </div>
        <span class="${chipClass("changed")}">${escapeHtml(alert.type)}</span>
      </div>
      <p>${escapeHtml(alert.summary)}</p>
      <p class="mini">${escapeHtml(alert.targetUrl)}</p>
      <p class="mini">Creato: ${formatDate(alert.createdAt)}</p>
      <ul class="detail-list">
        ${detailMarkup}
      </ul>
      <button data-alert-ack="${escapeHtml(alert.id)}">Segna come letto</button>
    `;
    alertsList.appendChild(article);
  }
}

function renderTargets() {
  targetsList.innerHTML = "";

  if (state.targets.length === 0) {
    targetsList.appendChild(createEmptyState());
    return;
  }

  for (const target of state.targets) {
    const card = document.createElement("article");
    const snapshotView = getSnapshotView(target);
    const warnings = snapshotView?.normalized?.warnings || [];
    const summary = snapshotView?.summary;
    const recentRun = target.recentRuns?.[0];
    const isExpanded = state.expandedTargetId === target.id;
    const alternateTags = getDerivedAlternates(snapshotView, summary).filter((item) =>
      (item.rel || "").includes("alternate")
    );
    const structuredDataTypes = getDerivedStructuredDataTypes(snapshotView, summary);
    const productDescription = getDerivedProductDescription(snapshotView, summary) || "n/d";
    const alternateMarkup = alternateTags.length
      ? `<ul class="detail-bullets">${alternateTags
          .map(
            (item) =>
              `<li><strong>${escapeHtml(item.hreflang || "default")}</strong>: ${escapeHtml(item.href || "n/d")}</li>`
          )
          .join("")}</ul>`
      : `<p class="mini">Nessun tag alternate rilevato.</p>`;
    const structuredMarkup = structuredDataTypes.length
      ? `<div class="tag-list">${structuredDataTypes
          .map((type) => `<span class="mini-chip">${escapeHtml(type)}</span>`)
          .join("")}</div>`
      : `<p class="mini">Nessun dato strutturato rilevato.</p>`;

    card.className = `target-card${isExpanded ? " is-expanded" : ""}`;
    card.dataset.targetCard = target.id;

    card.innerHTML = `
      <div class="target-head">
        <div class="target-title-wrap">
          <p class="eyebrow">Monitoraggio URL</p>
          <h3>${escapeHtml(target.label)}</h3>
        </div>
        <div class="target-head-actions">
          <button
            class="secondary compact-button icon-button"
            data-target-expand="${target.id}"
            aria-label="${isExpanded ? "Riduci scheda" : "Apri scheda a schermo intero"}"
            title="${isExpanded ? "Riduci" : "Schermo intero"}"
          >
            ${fullscreenIcon(isExpanded)}
          </button>
          <span class="${chipClass(target.status)}">${escapeHtml(target.status)}</span>
        </div>
      </div>

      <p class="target-url">
        <a href="${escapeHtml(safeExternalHref(target.url))}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(target.url)}
        </a>
      </p>

      <div class="stats">
        <span>Ultimo check: <strong>${formatDate(target.lastCheckAt)}</strong></span>
        <span>Alert aperti: <strong>${target.openAlerts}</strong></span>
        <span>Baseline: <strong>${target.baselineSnapshot ? "presente" : "da creare"}</strong></span>
      </div>

      <div class="snapshot-box">
        <p><strong>Title:</strong> ${escapeHtml(summary?.title || "n/d")}</p>
        <p><strong>Canonical:</strong> ${escapeHtml(summary?.canonical || "n/d")}</p>
        <p><strong>Meta key:</strong> ${summary?.metaCount ?? 0}</p>
        <p><strong>JSON-LD:</strong> ${summary?.jsonLdCount ?? 0}</p>
      </div>

      <details class="details-drawer">
        <summary>Dettagli metadata e structured data</summary>
        <div class="details-grid">
          <section class="detail-panel">
            <h4>Product description identificata</h4>
            <p>${escapeHtml(truncateText(productDescription, 260) || "n/d")}</p>
          </section>
          <section class="detail-panel">
            <h4>Alternate tag</h4>
            ${alternateMarkup}
          </section>
          <section class="detail-panel detail-panel-wide">
            <h4>Dati strutturati trovati</h4>
            ${structuredMarkup}
          </section>
        </div>
      </details>

      ${warnings.length ? `<div class="warning-box">${escapeHtmlList(warnings).join("<br />")}</div>` : ""}

      ${
        recentRun
          ? `<p class="mini">Ultimo esito: ${escapeHtml(recentRun.summary)} (${formatDate(recentRun.finishedAt || recentRun.startedAt)})</p>`
          : ""
      }

      <div class="actions">
        <button data-target-check="${target.id}">Lancia check</button>
        <button class="secondary" data-target-baseline="${target.id}">Accetta baseline corrente</button>
        <button class="secondary" data-target-toggle="${target.id}">
          ${target.active ? "Metti in pausa" : "Riattiva"}
        </button>
        <button class="ghost" data-target-delete="${target.id}">Rimuovi</button>
      </div>
    `;

    targetsList.appendChild(card);
  }
}

async function refresh() {
  const [status, targets, alerts] = await Promise.all([
    api("/api/status"),
    api("/api/targets"),
    api("/api/alerts"),
  ]);

  state.status = status;
  state.targets = targets;
  state.alerts = alerts;

  renderStatus();
  renderAlerts();
  renderTargets();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "";

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    await api("/api/targets", {
      body: JSON.stringify(payload),
      method: "POST",
    });
    form.reset();
    feedback.textContent = "URL aggiunta. Il primo check e stato messo in coda.";
    await refresh();
  } catch (error) {
    feedback.textContent = error.message;
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");

  if (!button) {
    return;
  }

  try {
    if (button.dataset.targetExpand) {
      state.expandedTargetId =
        state.expandedTargetId === button.dataset.targetExpand ? null : button.dataset.targetExpand;
      document.body.classList.toggle("has-expanded-card", Boolean(state.expandedTargetId));
      renderTargets();
      return;
    }

    if (button.dataset.targetCheck) {
      await api(`/api/targets/${button.dataset.targetCheck}/check`, { method: "POST" });
    }

    if (button.dataset.targetBaseline) {
      await api(`/api/targets/${button.dataset.targetBaseline}/reset-baseline`, { method: "POST" });
    }

    if (button.dataset.targetToggle) {
      await api(`/api/targets/${button.dataset.targetToggle}/toggle`, { method: "POST" });
    }

    if (button.dataset.targetDelete) {
      await api(`/api/targets/${button.dataset.targetDelete}`, { method: "DELETE" });
    }

    if (button.dataset.alertAck) {
      await api(`/api/alerts/${button.dataset.alertAck}/ack`, { method: "POST" });
    }

    await refresh();
  } catch (error) {
    feedback.textContent = error.message;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.expandedTargetId) {
    state.expandedTargetId = null;
    document.body.classList.remove("has-expanded-card");
    renderTargets();
  }
});

refresh().catch((error) => {
  feedback.textContent = error.message;
});

setInterval(() => {
  refresh().catch(() => {});
}, 15_000);
