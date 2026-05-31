const TAB_IDS = new Set(["stats", "results", "queue", "lfg", "passive"]);
const VIEW_STATE_STORAGE_KEY = "lnnrank-dashboard-view";
const RESULTS_PAGE_SIZE = 20;
const STATUS_PAGE_SIZE = 10;
const SOURCE_LABELS = {
  manual: "Manual search",
  unit: "Ctrl-click unit frame",
  world: "Ctrl-click world unit",
  "chat-link": "Ctrl-click chat link",
  applicant: "LFG applicant",
  self: "Daily self refresh",
  savedvariables: "WoW request",
  wow: "WoW request",
  raid: "Raid snapshot",
  party: "Party snapshot",
};

const SPEC_ROLE_MAP = {
  "Affliction": "dps",
  "Arcane": "dps",
  "Arms": "dps",
  "Assassination": "dps",
  "Augmentation": "dps",
  "Balance": "dps",
  "Beast Mastery": "dps",
  "Blood": "tank",
  "Brewmaster": "tank",
  "Demonology": "dps",
  "Destruction": "dps",
  "Devastation": "dps",
  "Discipline": "healer",
  "Elemental": "dps",
  "Enhancement": "dps",
  "Feral": "dps",
  "Fire": "dps",
  "Frost": "dps",
  "Fury": "dps",
  "Guardian": "tank",
  "Havoc": "dps",
  "Holy": "healer",
  "Marksmanship": "dps",
  "Mistweaver": "healer",
  "Outlaw": "dps",
  "Preservation": "healer",
  "Protection": "tank",
  "Restoration": "healer",
  "Retribution": "dps",
  "Shadow": "dps",
  "Subtlety": "dps",
  "Survival": "dps",
  "Unholy": "dps",
  "Vengeance": "tank",
  "Windwalker": "dps",
};

const state = {
  activeTab: "lfg",
  data: null,
  dashboardVersion: null,
  resultSearch: "",
  resultsPage: 1,
  statusPage: 1,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatCompactNumber(value, maximumFractionDigits = 2) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return "-";
  }
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function toRoleLabel(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return null;
  }
  if (normalized === "damager" || normalized === "damage" || normalized === "dps") {
    return "DPS";
  }
  if (normalized === "healer" || normalized === "heal" || normalized === "heals") {
    return "Healer";
  }
  if (normalized === "tank") {
    return "Tank";
  }
  return normalized.replace(/(^\w|[\s-]\w)/g, (match) => match.toUpperCase());
}

function createRoleIconMarkup(roleValue, extraClass = "") {
  const normalizedRole = normalizeRoleValue(roleValue);
  if (!normalizedRole) {
    return "";
  }

  const label = toRoleLabel(normalizedRole) || normalizedRole;
  const iconName =
    normalizedRole === "tank"
      ? "role_tank.png"
      : normalizedRole === "healer"
        ? "role_healer.png"
        : "role_dps.png";
  const classes = ["role-icon"];
  if (extraClass) {
    classes.push(extraClass);
  }

  return `<img class="${classes.join(" ")}" src="/assets/${iconName}" alt="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" />`;
}

function createRoleLabelMarkup(roleValue, extraClass = "") {
  const label = toRoleLabel(roleValue);
  if (!label) {
    return "";
  }

  const icon = createRoleIconMarkup(roleValue, extraClass);
  return `<span class="role-label"><span>${escapeHtml(label)}</span>${icon}</span>`;
}

function toneClassForParsePercent(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return "tone-muted";
  }
  if (numeric >= 100) {
    return "tone-gold";
  }
  if (numeric >= 99) {
    return "tone-legendary";
  }
  if (numeric >= 95) {
    return "tone-orange";
  }
  if (numeric >= 75) {
    return "tone-epic";
  }
  if (numeric >= 50) {
    return "tone-rare";
  }
  if (numeric >= 25) {
    return "tone-uncommon";
  }
  return "tone-muted";
}

function toneRankForParsePercent(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  if (numeric >= 100) {
    return 6;
  }
  if (numeric >= 99) {
    return 5;
  }
  if (numeric >= 95) {
    return 4;
  }
  if (numeric >= 75) {
    return 3;
  }
  if (numeric >= 50) {
    return 2;
  }
  if (numeric >= 25) {
    return 1;
  }
  return 0;
}

function toneClassForWclScore(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return "tone-muted";
  }
  if (numeric >= 3600) {
    return "tone-gold";
  }
  if (numeric >= 3400) {
    return "tone-legendary";
  }
  if (numeric >= 3200) {
    return "tone-orange";
  }
  if (numeric >= 3000) {
    return "tone-epic";
  }
  if (numeric >= 2400) {
    return "tone-rare";
  }
  if (numeric >= 1400) {
    return "tone-uncommon";
  }
  return "tone-muted";
}

function interpolateAnchoredPercent(value, anchors) {
  const numeric = toNumber(value);
  if (numeric == null || !Array.isArray(anchors) || anchors.length === 0) {
    return null;
  }
  if (numeric <= anchors[0][0]) {
    return anchors[0][1];
  }
  for (let index = 1; index < anchors.length; index += 1) {
    const [rightScore, rightPercent] = anchors[index];
    const [leftScore, leftPercent] = anchors[index - 1];
    if (numeric <= rightScore) {
      const span = rightScore - leftScore;
      if (span <= 0) {
        return rightPercent;
      }
      const ratio = (numeric - leftScore) / span;
      return leftPercent + (rightPercent - leftPercent) * ratio;
    }
  }
  return anchors[anchors.length - 1][1];
}

function getWclPerformancePercent(value) {
  return interpolateAnchoredPercent(value, [
    [0, 0],
    [900, 20],
    [1600, 35],
    [2200, 50],
    [2800, 70],
    [3200, 85],
    [3600, 100],
  ]);
}

function toneClassFromRank(value) {
  const rank = Math.max(0, Math.min(6, Math.round(Number(value) || 0)));
  return [
    "tone-muted",
    "tone-uncommon",
    "tone-rare",
    "tone-epic",
    "tone-orange",
    "tone-legendary",
    "tone-gold",
  ][rank];
}

function averageDungeonParse(record) {
  const dungeons = Array.isArray(record && record.dungeons) ? record.dungeons : [];
  const values = [];
  for (const dungeon of dungeons) {
    const value = toNumber(dungeon.bestPercent);
    if (value == null) {
      continue;
    }
    values.push(value);
  }
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toneClassForBlendedPerformance(record, averageParse) {
  const blendedPercent =
    record && record.presentation && toNumber(record.presentation.blendedPercent) != null
      ? toNumber(record.presentation.blendedPercent)
      : (() => {
          const values = [
            toNumber(averageParse),
            getWclPerformancePercent(record && record.score),
          ].filter((value) => value != null);
          if (!values.length) {
            return null;
          }
          return values.reduce((sum, value) => sum + value, 0) / values.length;
        })();

  if (blendedPercent == null) {
    return toneClassForWclScore(record && record.score);
  }
  return toneClassForParsePercent(blendedPercent);
}

function createEmpty(label) {
  return `<div class="empty">${escapeHtml(label)}</div>`;
}

function createSummaryItem(label, value) {
  return `
    <article class="summary-item">
      <span class="summary-label">${escapeHtml(label)}</span>
      <strong class="summary-value">${escapeHtml(value)}</strong>
    </article>
  `;
}

function createDetailRow(label, value, options = {}) {
  const classes = ["detail-value"];
  if (options.code) {
    classes.push("detail-value-code");
  }
  const displayValue = value == null || value === "" ? "Unknown" : value;

  return `
    <div class="detail-row">
      <span class="detail-label">${escapeHtml(label)}</span>
      <span class="${classes.join(" ")}">${escapeHtml(displayValue)}</span>
    </div>
  `;
}

function statusPill(stateValue) {
  if (["cached", "found", "idle"].includes(stateValue)) {
    return "ok";
  }
  if (["error", "not_found", "rate_limited"].includes(stateValue)) {
    return "bad";
  }
  return "warn";
}

function sortByName(records) {
  return [...records].sort((left, right) =>
    `${left.name}-${left.realm}`.localeCompare(`${right.name}-${right.realm}`, "en-US")
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampPage(page, totalPages) {
  return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}

function normalizeRealmKey(value) {
  return String(value || "")
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}]+/gu, "");
}

function normalizeRoleValue(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (!normalized) {
    return null;
  }
  if (normalized === "healer" || normalized === "heal" || normalized === "heals") {
    return "healer";
  }
  if (normalized === "damage" || normalized === "damager" || normalized === "dps") {
    return "dps";
  }
  if (normalized === "tank") {
    return "tank";
  }
  return null;
}

function resolveRoleForCharacter(character) {
  const hintedRole = normalizeRoleValue(character && (character.assignedRole || character.roleHint));
  if (hintedRole) {
    return hintedRole;
  }

  const specRole = SPEC_ROLE_MAP[String(character && character.specName || "").trim()];
  if (specRole) {
    return specRole;
  }

  const explicitRole = normalizeRoleValue(character && character.role);
  if (explicitRole) {
    return explicitRole;
  }

  const metric = String(character && character.parseMetric || "").trim().toLocaleLowerCase("en-US");
  if (metric === "hps") {
    return "healer";
  }
  if (metric === "dps") {
    return "dps";
  }
  if (metric === "playerscore" || metric === "points") {
    return "tank";
  }

  return null;
}

function resolveWclMetric(character) {
  const resolvedRole = resolveRoleForCharacter(character);
  if (resolvedRole === "healer") {
    return "hps";
  }
  if (resolvedRole === "dps") {
    return "dps";
  }
  if (resolvedRole === "tank") {
    return "playerscore";
  }

  const parseMetric = String(character && character.parseMetric || "").trim().toLocaleLowerCase("en-US");
  if (parseMetric === "hps" || parseMetric === "dps" || parseMetric === "playerscore") {
    return parseMetric;
  }

  return null;
}

function buildWclCharacterUrl(character) {
  const name = character && (character.name || character.characterName);
  if (!character || !character.region || !character.realm || !name) {
    return "#";
  }

  const region = String(character.region).normalize("NFC").toLocaleLowerCase("en-US");
  const realm = normalizeRealmKey(character.realm);
  const normalizedName = encodeURIComponent(String(name).normalize("NFC").toLocaleLowerCase("en-US"));
  const metric = resolveWclMetric(character);
  const baseUrl = `https://www.warcraftlogs.com/character/${region}/${realm}/${normalizedName}?zone=47`;
  return metric ? `${baseUrl}&metric=${metric}` : baseUrl;
}

function buildClientCacheKey(region, realm, name) {
  return [
    String(region || "").normalize("NFC").toLocaleLowerCase("en-US"),
    normalizeRealmKey(realm),
    String(name || "").normalize("NFC").toLocaleLowerCase("en-US"),
  ].join(":");
}

function formatSourceLabel(source) {
  const raw = String(source || "").trim();
  if (!raw) {
    return "Unknown";
  }
  if (SOURCE_LABELS[raw]) {
    return SOURCE_LABELS[raw];
  }
  return raw.replaceAll("-", " ");
}

function loadPersistedViewState() {
  let saved = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(VIEW_STATE_STORAGE_KEY) || "{}");
  } catch {}

  const params = new URLSearchParams(window.location.search);
  const activeTab = TAB_IDS.has(params.get("tab")) ? params.get("tab") : TAB_IDS.has(saved.activeTab) ? saved.activeTab : "lfg";
  const resultSearch = params.get("q") != null ? params.get("q") : saved.resultSearch || "";
  const resultsPage = parsePositiveInt(params.get("rp") || saved.resultsPage, 1);
  const statusPage = parsePositiveInt(params.get("sp") || saved.statusPage, 1);

  state.activeTab = activeTab;
  state.resultSearch = resultSearch;
  state.resultsPage = resultsPage;
  state.statusPage = statusPage;
}

function persistViewState() {
  const payload = {
    activeTab: state.activeTab,
    resultSearch: state.resultSearch,
    resultsPage: state.resultsPage,
    statusPage: state.statusPage,
  };

  try {
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {}

  const params = new URLSearchParams();
  if (state.activeTab !== "lfg") {
    params.set("tab", state.activeTab);
  }
  if (state.resultSearch) {
    params.set("q", state.resultSearch);
  }
  if (state.resultsPage > 1) {
    params.set("rp", String(state.resultsPage));
  }
  if (state.statusPage > 1) {
    params.set("sp", String(state.statusPage));
  }

  const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

function applyActiveTab() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === state.activeTab);
  });
}

function createPagerMarkup(target, currentPage, totalPages) {
  if (totalPages <= 1) {
    return "";
  }

  return `
    <span class="pager-info">${escapeHtml(`${currentPage} / ${totalPages}`)}</span>
    <button type="button" data-page-target="${escapeHtml(target)}" data-page-action="prev" ${currentPage <= 1 ? "disabled" : ""}>Prev</button>
    <button type="button" data-page-target="${escapeHtml(target)}" data-page-action="next" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
  `;
}

function paginateItems(items, currentPage, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = clampPage(currentPage, totalPages);
  const start = (page - 1) * pageSize;

  return {
    page,
    totalPages,
    items: items.slice(start, start + pageSize),
  };
}

function getStatusMap(data) {
  const entries = new Map();
  for (const status of data.requestStatuses || []) {
    const key = status.key || buildClientCacheKey(status.region, status.realm, status.name || status.characterName);
    if (!entries.has(key)) {
      entries.set(key, status);
    }
  }
  return entries;
}

function getRecordStatus(statusMap, record) {
  const key = record.key || buildClientCacheKey(record.region, record.realm, record.name);
  return statusMap.get(key) || {
    state: "stored",
    source: null,
    updatedAt: record.updatedAt,
    message: "Known locally, but not from a recent successful lookup status.",
  };
}

function renderStats(data) {
  const sync = data.autoSync || {};
  const syncLabel = sync.isRunning ? "Running" : sync.lastError ? "Needs attention" : "Idle";

  document.getElementById("statsGrid").innerHTML = [
    createSummaryItem("Cached Records", data.meta.recordCount),
    createSummaryItem("Queued Lookups", data.meta.queueCount),
    createSummaryItem(
      "Last WoW Snapshot",
      data.meta.savedVariablesUpdatedAt ? formatDate(data.meta.savedVariablesUpdatedAt) : "Not found"
    ),
    createSummaryItem("Auto Sync", syncLabel),
  ].join("");

  const autoSyncStatus = document.getElementById("autoSyncStatus");
  autoSyncStatus.innerHTML = `
    <article class="list-item">
      <header>
        <div>
          <strong>Background Worker</strong>
          <div class="list-meta">
            <span class="pill ${statusPill(sync.isRunning ? "running" : sync.lastError ? "error" : "idle")}">
              ${escapeHtml(syncLabel)}
            </span>
            <span>mode ${escapeHtml(sync.mode || "auto")}</span>
            <span>started ${escapeHtml(formatDate(sync.lastStartedAt))}</span>
            <span>finished ${escapeHtml(formatDate(sync.lastFinishedAt))}</span>
          </div>
        </div>
      </header>
      <div class="list-meta">
        <span>Last run requests: ${escapeHtml(sync.lastResult && sync.lastResult.requests != null ? sync.lastResult.requests : 0)}</span>
        <span>Statuses written: ${escapeHtml(sync.lastResult && sync.lastResult.statuses != null ? sync.lastResult.statuses : 0)}</span>
        <span>Cached records: ${escapeHtml(sync.lastResult && sync.lastResult.cachedRecords != null ? sync.lastResult.cachedRecords : data.meta.recordCount)}</span>
        <span>Current queue size: ${escapeHtml(sync.queueLength != null ? sync.queueLength : data.meta.queueCount)}</span>
        <span>Saved statuses: ${escapeHtml(sync.statusCount != null ? sync.statusCount : 0)}</span>
      </div>
      ${
        sync.lastError
          ? `<div>${escapeHtml(sync.lastError)}</div>`
          : `<div>${
              sync.currentLookup && (sync.currentLookup.characterName || sync.currentLookup.name)
                ? `Working on ${escapeHtml(sync.currentLookup.characterName || sync.currentLookup.name)}-${escapeHtml(sync.currentLookup.realm || "")}. `
                : ""
            }Provider selection is automatic. The app prefers API when allowed and falls back to web lookups when needed.</div>`
      }
    </article>
  `;
}

function renderResults(data) {
  const statusMap = getStatusMap(data);
  const rows = sortByName(data.records).filter((record) => {
    if (!state.resultSearch) {
      return true;
    }
    return `${record.name} ${record.realm} ${record.region}`.toLowerCase().includes(state.resultSearch.toLowerCase());
  });
  const paged = paginateItems(rows, state.resultsPage, RESULTS_PAGE_SIZE);
  state.resultsPage = paged.page;
  persistViewState();

  const resultsBody = document.getElementById("resultsBody");
  const pagerMarkup = createPagerMarkup("results", paged.page, paged.totalPages);
  document.getElementById("resultsPaginationTop").innerHTML = pagerMarkup;
  document.getElementById("resultsPaginationBottom").innerHTML = pagerMarkup;

  if (paged.items.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="7"><div class="empty">No cached results match this search.</div></td></tr>`;
    return;
  }

  resultsBody.innerHTML = paged.items
    .map((record) => {
      const status = getRecordStatus(statusMap, record);
      const roleLabel = createRoleLabelMarkup(resolveRoleForCharacter(record), "results-role-icon");
      return `
        <tr>
          <td>
            <div class="results-character-cell">
              <a class="wcl-character-link results-name-link" href="${escapeHtml(buildWclCharacterUrl(record))}" target="_blank" rel="noreferrer noopener">${escapeHtml(record.name)}</a>
              ${roleLabel ? `<div class="results-role-meta">${roleLabel}</div>` : ""}
            </div>
          </td>
          <td>${escapeHtml(record.realm)} <span class="summary-label">(${escapeHtml(record.region)})</span></td>
          <td><span class="pill status-pill ${statusPill(status.state)}">${escapeHtml(status.state)}</span></td>
          <td>${escapeHtml(formatSourceLabel(status.source))}</td>
          <td><span class="tone-value ${toneClassForWclScore(record.score)}">${escapeHtml(formatCompactNumber(record.score))}</span></td>
          <td>${escapeHtml(formatDate(record.updatedAt))}</td>
          <td>${Array.isArray(record.dungeons) ? record.dungeons.length : 0}</td>
        </tr>
      `;
    })
    .join("");
}

function renderQueue(data) {
  const target = document.getElementById("queueList");
  if (!data.queue.length) {
    target.innerHTML = createEmpty("No pending queue entries.");
    return;
  }

  target.innerHTML = data.queue
    .map(
      (entry) => `
        <article class="list-item">
          <header>
            <div>
              <strong>${escapeHtml(entry.characterName)}</strong>
              <div class="list-meta">
                <span>${escapeHtml(entry.realm)}</span>
                <span>${escapeHtml(entry.region)}</span>
                <span>${escapeHtml(entry.sources.map(formatSourceLabel).join(" + "))}</span>
                <span>${escapeHtml(formatDate(entry.requestTimestamp))}</span>
              </div>
            </div>
            <button class="danger" data-remove-queue="${escapeHtml(entry.key)}">Remove</button>
          </header>
          <div class="list-meta">
            <span class="pill ${entry.record ? "ok" : "warn"}">${entry.record ? "Cached" : "Lookup needed"}</span>
            <span>Score: ${entry.record && entry.record.score != null ? escapeHtml(entry.record.score) : "-"}</span>
            ${entry.seenCount ? `<span>seen ${escapeHtml(entry.seenCount)}x</span>` : ""}
          </div>
        </article>
      `
    )
    .join("");
}

function renderStatuses(data) {
  const target = document.getElementById("statusList");
  const paged = paginateItems(data.requestStatuses || [], state.statusPage, STATUS_PAGE_SIZE);
  state.statusPage = paged.page;
  persistViewState();
  document.getElementById("statusPagination").innerHTML = createPagerMarkup("statuses", paged.page, paged.totalPages);

  if (!paged.items.length) {
    target.innerHTML = createEmpty("No sync statuses yet.");
    return;
  }

  target.innerHTML = paged.items
    .map(
      (entry) => `
        <article class="list-item">
          <header>
            <div>
              <strong>${escapeHtml(entry.name)}</strong>
              <div class="list-meta">
                <span>${escapeHtml(entry.realm)}</span>
                <span>${escapeHtml(formatSourceLabel(entry.source))}</span>
                <span class="pill ${statusPill(entry.state)}">${escapeHtml(entry.state)}</span>
                <span>${escapeHtml(formatDate(entry.updatedAt))}</span>
              </div>
            </div>
          </header>
          <div>${escapeHtml(entry.message || "")}</div>
        </article>
      `
    )
    .join("");
}

function renderPassive(data) {
  const target = document.getElementById("passiveView");
  if (!target) {
    return;
  }

  const passive = data.passiveBridge;
  if (!passive) {
    target.innerHTML = `
      <section class="card">
        <div class="card-head">
          <h2>Passive Self-Channel</h2>
          <p>The addon has not written passive channel state into SavedVariables yet.</p>
        </div>
        ${createEmpty("Run /reload once after loading the addon, then open this tab again.")}
      </section>
    `;
    return;
  }

  const statusLabel = !passive.enabled ? "Disabled" : passive.joined ? "Joined" : "Enabled";
  const lastSavedVariablesFlush =
    data.meta && data.meta.savedVariablesUpdatedAt
      ? formatDate(data.meta.savedVariablesUpdatedAt)
      : "Waiting for the next /reload or logout.";
  const lastPayload =
    typeof passive.lastPublishedPayload === "string" && passive.lastPublishedPayload.trim() !== ""
      ? passive.lastPublishedPayload
      : null;
  const playerLabel = [passive.playerName, passive.realm].filter(Boolean).join("-") || "Unknown";
  const regionLabel = passive.region ? String(passive.region).toUpperCase() : "Unknown";

  target.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>Passive Self-Channel</h2>
        <p>This tab reflects the addon's persisted bridge state. Channel changes and payload snapshots appear here after WoW flushes SavedVariables.</p>
      </div>
      <div class="summary-grid passive-summary-grid">
        ${createSummaryItem("Status", statusLabel)}
        ${createSummaryItem("Sequence", formatCompactNumber(passive.sequence ?? 0, 0))}
        ${createSummaryItem(
          "Last Publish",
          passive.lastPublishedAtIso ? formatDate(passive.lastPublishedAtIso) : "None yet"
        )}
        ${createSummaryItem("SavedVariables", lastSavedVariablesFlush)}
      </div>
    </section>

    <div class="queue-layout passive-layout">
      <section class="card">
        <div class="card-head">
          <h2>Channel Identity</h2>
          <p>The app can use this player-specific marker to watch outbound payloads.</p>
        </div>
        <div class="detail-list">
          ${createDetailRow("Channel", passive.channelName || "Unknown", { code: true })}
          ${createDetailRow("Player Key", passive.playerKey || "Unknown", { code: true })}
          ${createDetailRow("Session", passive.sessionId || "Unknown", { code: true })}
          ${createDetailRow("Player", playerLabel)}
          ${createDetailRow("Region", regionLabel)}
          ${createDetailRow("GUID", passive.playerGuid || "Unknown", { code: true })}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Latest Relay Snapshot</h2>
          <p>The last outbound payload captured in the addon's SavedVariables snapshot.</p>
        </div>
        <div class="detail-list">
          ${createDetailRow("Bridge Updated", passive.updatedAtIso ? formatDate(passive.updatedAtIso) : "Unknown")}
          ${createDetailRow("Last Publish", passive.lastPublishedAtIso ? formatDate(passive.lastPublishedAtIso) : "None yet")}
          ${createDetailRow("Joined Channel", passive.joined ? "Yes" : "No")}
          ${createDetailRow("Enabled", passive.enabled ? "Yes" : "No")}
        </div>
        ${
          lastPayload
            ? `<pre class="code-block passive-payload">${escapeHtml(lastPayload)}</pre>`
            : createEmpty("No passive payload has been persisted yet.")
        }
      </section>
    </div>
  `;
}


function getLfgEntryStatus(data, entry) {
  const statusMap = getStatusMap(data);
  const key = entry.key || buildClientCacheKey(entry.region, entry.realm, entry.characterName);
  const status = statusMap.get(key);
  const isQueued = (data.queue || []).some((queueEntry) => queueEntry.key === key);

  if (entry.record) {
    return status || {
      state: "cached",
      source: entry.source || "applicant",
      updatedAt: entry.record.updatedAt,
      message: "Cached locally.",
    };
  }

  if (isQueued) {
    return {
      state: "queued",
      source: entry.source || "applicant",
      updatedAt: entry.lastSeenAt ? new Date(entry.lastSeenAt * 1000).toISOString() : null,
      message: "Queued for lookup.",
    };
  }

  return (
    status || {
      state: "waiting",
      source: entry.source || "applicant",
      updatedAt: entry.lastSeenAt ? new Date(entry.lastSeenAt * 1000).toISOString() : null,
      message: "Awaiting the next lookup pass.",
    }
  );
}

function renderDungeonStrip(record) {
  const dungeons = Array.isArray(record && record.dungeons) ? record.dungeons : [];
  if (!dungeons.length) {
    return '<span class="tone-muted">No dungeon parses cached yet.</span>';
  }

  return dungeons
    .map((dungeon) => {
      const label = dungeon.label || dungeon.name || dungeon.slug;
      const percent =
        typeof dungeon.bestPercent === "number"
          ? `${Math.round(dungeon.bestPercent)}%`
          : "-";
      return `
        <span class="dungeon-inline">
          <span class="dungeon-inline-label">${escapeHtml(label)}</span>
          <span class="tone-value ${toneClassForParsePercent(dungeon.bestPercent)}">${escapeHtml(percent)}</span>
        </span>
      `;
    })
    .join("");
}

function groupApplicants(entries) {
  const groups = new Map();

  for (const entry of entries || []) {
    const applicantID =
      entry.applicantID || `solo:${entry.key || buildClientCacheKey(entry.region, entry.realm, entry.characterName)}`;
    if (!groups.has(applicantID)) {
      groups.set(applicantID, {
        applicantID,
        entries: [],
        latestSeenAt: 0,
      });
    }

    const group = groups.get(applicantID);
    group.entries.push(entry);
    group.latestSeenAt = Math.max(group.latestSeenAt || 0, entry.lastSeenAt || 0);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort((left, right) => {
        const leftIndex = Number.isFinite(left.memberIndex) ? left.memberIndex : Number.MAX_SAFE_INTEGER;
        const rightIndex = Number.isFinite(right.memberIndex) ? right.memberIndex : Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) {
          return leftIndex - rightIndex;
        }
        return `${left.characterName}-${left.realm}`.localeCompare(`${right.characterName}-${right.realm}`, "en-US");
      }),
    }))
    .sort((left, right) => (right.latestSeenAt || 0) - (left.latestSeenAt || 0));
}

function renderLfgMemberRow(entry, data) {
  const status = getLfgEntryStatus(data, entry);
  const record = entry.record || null;
  const averageParse =
    record && record.presentation && toNumber(record.presentation.averageParsePercent) != null
      ? toNumber(record.presentation.averageParsePercent)
      : averageDungeonParse(record);
  const roleLabel = toRoleLabel(entry.assignedRole || (record && record.role));
  const roleLabelMarkup = createRoleLabelMarkup(
    entry.assignedRole || (record && record.role),
    "lfg-role-icon"
  );
  const primaryScore = record && record.score != null ? record.score : null;
  const primaryScoreClass = toneClassForWclScore(primaryScore);
  const primaryScoreText = primaryScore == null ? "" : formatCompactNumber(primaryScore, 2);
  const averageParseText =
    averageParse == null ? "" : `${formatCompactNumber(Math.round(averageParse), 0)}%`;
  const averageParseClass = toneClassForParsePercent(averageParse);
  const nameToneClass = toneClassForBlendedPerformance(record, averageParse);
  const regionInfo = entry.region ? String(entry.region).toUpperCase() : "";
  const summaryParts = [];

  if (primaryScoreText) {
    summaryParts.push(`<span class="tone-value ${primaryScoreClass}">${escapeHtml(primaryScoreText)}</span>`);
  }
  if (averageParseText) {
    summaryParts.push(`<span class="tone-value ${averageParseClass}">${escapeHtml(averageParseText)}</span>`);
  }
  if (entry.itemLevel != null) {
    summaryParts.push(`<span>${escapeHtml(formatCompactNumber(entry.itemLevel, 1))} iLvl</span>`);
  }
  if (roleLabel) {
    summaryParts.push(roleLabelMarkup);
  }

  return `
    <article class="lfg-member-row">
      <header class="lfg-member-head">
        <div>
          <div class="lfg-member-title">
            <a class="wcl-character-link" href="${escapeHtml(buildWclCharacterUrl({
              region: entry.region,
              realm: entry.realm,
              characterName: entry.characterName,
              parseMetric: record && record.parseMetric,
              specName: record && record.specName,
              assignedRole: entry.assignedRole,
              role: record && record.role,
            }))}" target="_blank" rel="noreferrer noopener"><strong class="${escapeHtml(nameToneClass)}">${escapeHtml(entry.characterName)}</strong></a>
            <span class="lfg-member-server">- ${escapeHtml(entry.realm)}</span>
            ${regionInfo ? `<span class="lfg-member-region">${escapeHtml(regionInfo)}</span>` : ""}
          </div>
        </div>
        <div class="lfg-head-right">
          <div class="lfg-summary-line">
            ${summaryParts.join('<span class="lfg-summary-sep">·</span>')}
          </div>
          <span class="pill ${statusPill(status.state)}">${escapeHtml(status.state)}</span>
        </div>
      </header>
      <div class="lfg-parse-strip ${record ? "" : "is-muted"}">${
        record ? renderDungeonStrip(record) : escapeHtml(status.message || "Queued for lookup.")
      }</div>
    </article>
  `;
}

function renderRosterList(targetId, entries, emptyLabel, data) {
  const target = document.getElementById(targetId);
  if (!entries.length) {
    target.innerHTML = createEmpty(emptyLabel);
    return;
  }

  target.innerHTML = groupApplicants(entries)
    .map((group) => `
      <section class="lfg-group-card">
        <div class="lfg-group-members">
          ${group.entries.map((entry) => renderLfgMemberRow(entry, data)).join("")}
        </div>
      </section>
    `)
    .join("");
}

function renderAll() {
  if (!state.data) {
    return;
  }

  renderStats(state.data);
  renderResults(state.data);
  renderQueue(state.data);
  renderStatuses(state.data);
  renderPassive(state.data);
  renderRosterList("applicantList", state.data.applicants, "No LFG applicants in the last WoW snapshot.", state.data);
  applyActiveTab();
}

async function loadState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const nextData = await response.json();
  const nextVersion = nextData && nextData.meta ? nextData.meta.dashboardVersion || null : null;
  if (state.dashboardVersion && nextVersion && state.dashboardVersion !== nextVersion) {
    window.location.reload();
    return;
  }
  state.dashboardVersion = nextVersion || state.dashboardVersion || null;
  state.data = nextData;
  renderAll();
}

async function removeQueue(key) {
  await fetch(`/api/queue/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  await loadState();
}

async function clearQueue() {
  const button = document.getElementById("clearQueueButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Clearing...";
  }

  try {
    await fetch("/api/queue/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Clear Queue";
    }
  }
}

async function clearResultsCache() {
  const button = document.getElementById("clearResultsButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Clearing...";
  }

  try {
    await fetch("/api/results/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    state.resultsPage = 1;
    state.statusPage = 1;
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Clear Cache";
    }
  }
}

function bindTabs() {
  document.getElementById("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) {
      return;
    }

    state.activeTab = tab.dataset.tab;
    persistViewState();
    applyActiveTab();
  });
}

function bindScrollAwareTabs() {
  const tabs = document.getElementById("tabs");
  if (!tabs) {
    return;
  }

  let lastScrollY = window.scrollY;
  let ticking = false;

  function updateTabsVisibility() {
    const currentScrollY = window.scrollY;

    if (currentScrollY <= 8 || currentScrollY < lastScrollY - 8) {
      tabs.classList.remove("is-hidden");
    } else if (currentScrollY > 48 && currentScrollY > lastScrollY + 8) {
      tabs.classList.add("is-hidden");
    }

    lastScrollY = currentScrollY;
    ticking = false;
  }

  window.addEventListener(
    "scroll",
    () => {
      if (ticking) {
        return;
      }

      ticking = true;
      window.requestAnimationFrame(updateTabsVisibility);
    },
    { passive: true }
  );
}

function bindPagination() {
  document.body.addEventListener("click", (event) => {
    const pagerButton = event.target.closest("[data-page-target]");
    if (!pagerButton) {
      return;
    }

    const target = pagerButton.dataset.pageTarget;
    const action = pagerButton.dataset.pageAction;
    if (target === "results") {
      state.resultsPage = Math.max(1, state.resultsPage + (action === "next" ? 1 : -1));
    } else if (target === "statuses") {
      state.statusPage = Math.max(1, state.statusPage + (action === "next" ? 1 : -1));
    }
    persistViewState();
    renderAll();
  });
}

function bindEvents() {
  bindTabs();
  bindScrollAwareTabs();
  bindPagination();

  const resultSearch = document.getElementById("resultSearch");
  resultSearch.value = state.resultSearch;

  resultSearch.addEventListener("input", () => {
    state.resultSearch = resultSearch.value.trim();
    state.resultsPage = 1;
    persistViewState();
    if (state.data) {
      renderResults(state.data);
    }
  });

  const clearQueueButton = document.getElementById("clearQueueButton");
  if (clearQueueButton) {
    clearQueueButton.addEventListener("click", () => {
      void clearQueue();
    });
  }

  const clearResultsButton = document.getElementById("clearResultsButton");
  if (clearResultsButton) {
    clearResultsButton.addEventListener("click", () => {
      void clearResultsCache();
    });
  }

  document.body.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-queue]");
    if (removeButton) {
      void removeQueue(removeButton.dataset.removeQueue);
    }
  });
}

loadPersistedViewState();
bindEvents();
applyActiveTab();
void loadState();
setInterval(() => {
  void loadState();
}, 4000);
