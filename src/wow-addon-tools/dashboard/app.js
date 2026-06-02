const TAB_IDS = new Set(["search", "lfg", "live", "reader"]);
const VIEW_STATE_STORAGE_KEY = "lnnrank-dashboard-view";
const RESULTS_PAGE_SIZE = 20;
const LIVE_LOG_PAGE_SIZE = 12;
const SOURCE_LABELS = {
  manual: "Manual search",
  unit: "Ctrl-click unit frame",
  world: "Ctrl-click world unit",
  "chat-link": "Ctrl-click chat link",
  chatlink: "Ctrl-click chat link",
  applicant: "LFG applicant",
  self: "Daily self refresh",
  "passive-live": "Passive live feed",
  savedvariables: "WoW request",
  wow: "WoW request",
  raid: "Raid snapshot",
  party: "Party snapshot",
};
const WOW_CLASS_COLORS = {
  DEATHKNIGHT: "#C41F3B",
  DEMONHUNTER: "#A330C9",
  DRUID: "#FF7D0A",
  EVOKER: "#33937F",
  HUNTER: "#ABD473",
  MAGE: "#40C7EB",
  MONK: "#00FF98",
  PALADIN: "#F58CBA",
  PRIEST: "#FFFFFF",
  ROGUE: "#FFF569",
  SHAMAN: "#0070DE",
  WARLOCK: "#8787ED",
  WARRIOR: "#C79C6E",
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
  resultSort: "updatedAt",
  resultSortDirection: "desc",
  liveLogPage: 1,
  liveLogHiddenIds: [],
};

let confirmModalAction = null;
let confirmModalReturnFocus = null;

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

function normalizeWowClassToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/gu, "");
}

function resolveWowClassColor(value) {
  const token = normalizeWowClassToken(value);
  return token ? WOW_CLASS_COLORS[token] || null : null;
}

function resolveLfgClassColor(entry, record) {
  return resolveWowClassColor(entry && entry.class) || resolveWowClassColor(record && record.className);
}

function formatShortDate(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return isSameDay
    ? date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : date.toLocaleDateString();
}

function formatDelayMs(value) {
  const numeric = toNumber(value);
  if (numeric == null) {
    return "Unknown";
  }
  if (numeric < 1000) {
    return `${Math.round(numeric)} ms`;
  }
  return `${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)} s`;
}

function formatLookupName(lookup) {
  if (!lookup) {
    return null;
  }
  const name = lookup.characterName || lookup.name;
  if (!name) {
    return null;
  }
  return `${name}${lookup.realm ? `-${lookup.realm}` : ""}`;
}

function formatWorkerCount(sync) {
  const workerCount = Math.max(1, toNumber(sync && sync.workerCount) || 1);
  return `${workerCount} worker${workerCount === 1 ? "" : "s"}`;
}

function formatStatusTiming(status) {
  if (!status) {
    return "";
  }

  if (status.state === "searching" && status.startedAt) {
    const startedAtMs = Date.parse(status.startedAt);
    if (Number.isFinite(startedAtMs)) {
      return `running ${formatDelayMs(Date.now() - startedAtMs)}`;
    }
  }

  const parts = [];
  if (status.lookupDurationMs != null) {
    parts.push(`lookup ${formatDelayMs(status.lookupDurationMs)}`);
  }
  if (status.queueWaitMs != null && status.queueWaitMs >= 1000) {
    parts.push(`wait ${formatDelayMs(status.queueWaitMs)}`);
  }
  if (parts.length === 0 && status.totalDurationMs != null) {
    parts.push(`total ${formatDelayMs(status.totalDurationMs)}`);
  }
  if (status.workerIndex != null) {
    parts.push(`w${Number(status.workerIndex) + 1}`);
  }

  return parts.join(" / ");
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
  const blendedPercent = getRecordBlendedPercent(record, averageParse);

  if (blendedPercent == null) {
    return toneClassForWclScore(record && record.score);
  }
  return toneClassForParsePercent(blendedPercent);
}

function getRecordAverageParse(record) {
  if (record && record.presentation && toNumber(record.presentation.averageParsePercent) != null) {
    return toNumber(record.presentation.averageParsePercent);
  }
  return averageDungeonParse(record);
}

function getRecordBlendedPercent(record, averageParse = getRecordAverageParse(record)) {
  if (record && record.presentation && toNumber(record.presentation.blendedPercent) != null) {
    return toNumber(record.presentation.blendedPercent);
  }

  const values = [toNumber(averageParse), getWclPerformancePercent(record && record.score)].filter(
    (value) => value != null
  );
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercentMetric(value) {
  const numeric = toNumber(value);
  return numeric == null ? "-" : `${formatCompactNumber(numeric, 1)}%`;
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

function normalizeTabId(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("en-US");
  if (normalized === "queue" || normalized === "results" || normalized === "stats") {
    return "search";
  }
  if (normalized === "passive") {
    return "live";
  }
  return TAB_IDS.has(normalized) ? normalized : null;
}

function normalizeSortColumn(value) {
  return ["character", "blendedPercent", "averageParse", "score", "updatedAt"].includes(value)
    ? value
    : "updatedAt";
}

function normalizeSortDirection(value) {
  return value === "asc" ? "asc" : "desc";
}

function latestTimestamp(left, right) {
  const leftMs = Date.parse(left || "");
  const rightMs = Date.parse(right || "");
  if (!Number.isFinite(leftMs)) {
    return right || null;
  }
  if (!Number.isFinite(rightMs)) {
    return left || null;
  }
  return rightMs >= leftMs ? right : left;
}

function loadPersistedViewState() {
  let saved = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(VIEW_STATE_STORAGE_KEY) || "{}");
  } catch {}

  const params = new URLSearchParams(window.location.search);
  const tabFromParams = normalizeTabId(params.get("tab"));
  const activeTab = tabFromParams || normalizeTabId(saved.activeTab) || "lfg";
  const useExplicitSearchParams = tabFromParams === "search";
  const resultSearch = params.get("q") != null ? params.get("q") : saved.resultSearch || "";
  const resultsPage = parsePositiveInt(params.get("rp") || saved.resultsPage, 1);
  const resultSort =
    useExplicitSearchParams && params.has("sort") ? normalizeSortColumn(params.get("sort")) : "updatedAt";
  const resultSortDirection =
    useExplicitSearchParams && params.has("dir") ? normalizeSortDirection(params.get("dir")) : "desc";
  const liveLogPage = parsePositiveInt(saved.liveLogPage, 1);

  state.activeTab = activeTab;
  state.resultSearch = resultSearch;
  state.resultsPage = resultsPage;
  state.resultSort = resultSort;
  state.resultSortDirection = resultSortDirection;
  state.liveLogPage = liveLogPage;
  state.liveLogHiddenIds = [];
}

function persistViewState() {
  const payload = {
    activeTab: state.activeTab,
    resultSearch: state.resultSearch,
    resultsPage: state.resultsPage,
    resultSort: state.resultSort,
    resultSortDirection: state.resultSortDirection,
    liveLogPage: state.liveLogPage,
  };

  try {
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {}

  const params = new URLSearchParams();
  if (state.activeTab !== "lfg") {
    params.set("tab", state.activeTab);
  }
  if (state.activeTab === "search" && state.resultSearch) {
    params.set("q", state.resultSearch);
  }
  if (state.activeTab === "search" && state.resultsPage > 1) {
    params.set("rp", String(state.resultsPage));
  }
  if (state.activeTab === "search" && state.resultSort !== "updatedAt") {
    params.set("sort", state.resultSort);
  }
  if (state.activeTab === "search" && state.resultSortDirection !== "desc") {
    params.set("dir", state.resultSortDirection);
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

function renderSearchSummary(data) {
  const sync = data.autoSync || {};
  const syncLabel = sync.isRunning ? "Running" : sync.lastError ? "Attention" : "Idle";
  const target = document.getElementById("searchResultsSummary");
  target.innerHTML = [
    createSearchSummaryChip("Cached", formatCompactNumber(data.meta.recordCount, 0), "is-ok"),
    createSearchSummaryChip("Queue", formatCompactNumber(data.meta.queueCount, 0), data.meta.queueCount > 0 ? "is-warn" : ""),
    createSearchSummaryChip(
      "Snapshot",
      data.meta.savedVariablesUpdatedAt ? formatShortDate(data.meta.savedVariablesUpdatedAt) : "Not found"
    ),
    createSearchSummaryChip(
      "Sync",
      syncLabel,
      sync.lastError ? "is-bad" : sync.isRunning ? "is-warn" : "is-ok",
      { meta: formatWorkerMeta(sync) }
    ),
  ].join("");
}

function formatWorkerMeta(sync) {
  const baseParts = [sync.mode || "auto", formatWorkerCount(sync)];

  if (sync.isRunning) {
    const activeLookup = formatLookupName(sync.currentLookup) || "working";
    const workerLabel =
      sync.currentLookupWorkerIndex == null ? null : `w${Number(sync.currentLookupWorkerIndex) + 1}`;
    const durationLabel =
      sync.currentLookupDurationMs == null ? null : `running ${formatDelayMs(sync.currentLookupDurationMs)}`;
    return [...baseParts, activeLookup, workerLabel, durationLabel].filter(Boolean).join(" / ");
  }

  if (sync.lastError) {
    return [...baseParts, "last run failed"].join(" / ");
  }

  const lastTiming = [];
  if (sync.lastLookupDurationMs != null) {
    lastTiming.push(`last lookup ${formatDelayMs(sync.lastLookupDurationMs)}`);
  }
  if (sync.lastRunDurationMs != null) {
    lastTiming.push(`run ${formatDelayMs(sync.lastRunDurationMs)}`);
  }
  if (sync.lastFinishedAt) {
    return [...baseParts, ...lastTiming, formatShortDate(sync.lastFinishedAt)].join(" / ");
  }

  return [...baseParts, ...lastTiming].join(" / ");
}

function renderQueueWorker(data) {
  const sync = data.autoSync || {};
  const syncLabel = sync.isRunning ? "Running" : sync.lastError ? "Attention" : "Idle";
  const target = document.getElementById("queueWorkerStatus");
  target.innerHTML = `
    <div class="queue-worker-strip">
      <span class="queue-worker-label">Worker</span>
      <span class="pill ${statusPill(sync.isRunning ? "running" : sync.lastError ? "error" : "idle")}">${escapeHtml(syncLabel)}</span>
      <span class="queue-worker-meta">${escapeHtml(formatWorkerMeta(sync))}</span>
    </div>
  `;
}

function createResultsFooterMarkup(filteredCount, totalCount, currentPage, totalPages) {
  const countLabel = state.resultSearch
    ? `${formatCompactNumber(filteredCount, 0)} of ${formatCompactNumber(totalCount, 0)} cached`
    : `${formatCompactNumber(totalCount, 0)} cached`;
  const pagerMarkup = totalPages > 1 ? createPagerMarkup("results", currentPage, totalPages) : "";

  return `
    <span class="results-footer-count">${escapeHtml(countLabel)}</span>
    ${pagerMarkup}
  `;
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "en-US");
}

function compareNumber(left, right) {
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
  if (leftNumber === rightNumber) {
    return 0;
  }
  return leftNumber < rightNumber ? -1 : 1;
}

function compareDate(left, right) {
  return compareNumber(Date.parse(left || ""), Date.parse(right || ""));
}

function getSortedResults(data) {
  const filtered = (data.records || []).filter((record) => {
    if (!state.resultSearch) {
      return true;
    }
    return `${record.name} ${record.realm} ${record.region}`.toLowerCase().includes(state.resultSearch.toLowerCase());
  });

  return filtered.sort((left, right) => {
    const leftAverageParse = getRecordAverageParse(left);
    const rightAverageParse = getRecordAverageParse(right);
    const leftBlendedPercent = getRecordBlendedPercent(left, leftAverageParse);
    const rightBlendedPercent = getRecordBlendedPercent(right, rightAverageParse);
    let comparison = 0;

    if (state.resultSort === "character") {
      comparison = compareText(left.name, right.name);
    } else if (state.resultSort === "blendedPercent") {
      comparison = compareNumber(leftBlendedPercent, rightBlendedPercent);
    } else if (state.resultSort === "averageParse") {
      comparison = compareNumber(leftAverageParse, rightAverageParse);
    } else if (state.resultSort === "score") {
      comparison = compareNumber(toNumber(left.score), toNumber(right.score));
    } else {
      comparison = compareDate(left.updatedAt, right.updatedAt);
    }

    if (comparison === 0) {
      comparison = compareText(`${left.name}-${left.realm}`, `${right.name}-${right.realm}`);
    }

    return state.resultSortDirection === "asc" ? comparison : -comparison;
  });
}

function renderResults(data) {
  const rows = getSortedResults(data);
  const statusMap = getStatusMap(data);
  const paged = paginateItems(rows, state.resultsPage, RESULTS_PAGE_SIZE);
  state.resultsPage = paged.page;
  persistViewState();

  const resultsBody = document.getElementById("resultsBody");
  const resultsFooter = document.getElementById("resultsFooter");
  resultsFooter.innerHTML = createResultsFooterMarkup(rows.length, data.records.length, paged.page, paged.totalPages);
  document.querySelectorAll("[data-sort-column]").forEach((button) => {
    const label = button.dataset.sortLabel || button.textContent.trim();
    button.dataset.sortLabel = label;
    const isActive = button.dataset.sortColumn === state.resultSort;
    button.classList.toggle("is-active", isActive);
    button.textContent = isActive ? `${label} ${state.resultSortDirection === "asc" ? "↑" : "↓"}` : label;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  if (paged.items.length === 0) {
    resultsBody.innerHTML = `<tr><td colspan="5"><div class="empty">No cached results match this search.</div></td></tr>`;
    return;
  }

  resultsBody.innerHTML = paged.items
    .map((record) => {
      const roleLabel = createRoleLabelMarkup(resolveRoleForCharacter(record), "results-role-icon");
      const averageParse = getRecordAverageParse(record);
      const blendedPercent = getRecordBlendedPercent(record, averageParse);
      const classColor = resolveWowClassColor(record.className);
      const nameStyle = classColor ? ` style="color: ${escapeHtml(classColor)}"` : "";
      const status = statusMap.get(buildClientCacheKey(record.region, record.realm, record.name));
      const timingLabel = formatStatusTiming(status);
      const locationParts = [record.realm];
      if (record.region) {
        locationParts.push(`(${String(record.region).toUpperCase()})`);
      }
      return `
        <tr>
          <td>
            <div class="results-character-cell">
              <a class="wcl-character-link results-name-link" href="${escapeHtml(buildWclCharacterUrl(record))}" target="_blank" rel="noreferrer noopener"${nameStyle}>${escapeHtml(record.name)}</a>
              ${roleLabel ? `<div class="results-role-meta">${roleLabel}</div>` : ""}
              <div class="results-location-meta">${escapeHtml(locationParts.join(" "))}</div>
              <button
                class="secondary results-force-button"
                type="button"
                data-force-search="true"
                data-force-region="${escapeHtml(record.region || "us")}"
                data-force-realm="${escapeHtml(record.realm)}"
                data-force-name="${escapeHtml(record.name)}"
              >Force Search</button>
            </div>
          </td>
          <td><span class="tone-value ${toneClassForBlendedPerformance(record, averageParse)}">${escapeHtml(formatPercentMetric(blendedPercent))}</span></td>
          <td><span class="tone-value ${toneClassForParsePercent(averageParse)}">${escapeHtml(formatPercentMetric(averageParse))}</span></td>
          <td><span class="tone-value ${toneClassForWclScore(record.score)}">${escapeHtml(formatCompactNumber(record.score))}</span></td>
          <td>
            ${escapeHtml(formatDate(record.updatedAt))}
            ${timingLabel ? `<div class="results-location-meta">${escapeHtml(timingLabel)}</div>` : ""}
          </td>
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

  const statusMap = getStatusMap(data);
  target.innerHTML = data.queue
    .map(
      (entry) => {
        const status = statusMap.get(entry.key) || entry.status || null;
        const stateLabel = status ? status.state : entry.record ? "cached" : "queued";
        const timingLabel = formatStatusTiming(status);
        return `
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
              <span class="pill ${statusPill(stateLabel)}">${escapeHtml(stateLabel)}</span>
              <span>Score: ${entry.record && entry.record.score != null ? escapeHtml(entry.record.score) : "-"}</span>
              ${timingLabel ? `<span>${escapeHtml(timingLabel)}</span>` : ""}
              ${entry.seenCount ? `<span>seen ${escapeHtml(entry.seenCount)}x</span>` : ""}
            </div>
          </article>
        `;
      }
    )
    .join("");
}

function formatPassiveLiveStatus(liveFeed) {
  return !liveFeed || liveFeed.status === "idle"
    ? "Idle"
    : liveFeed.status === "paused"
      ? "Paused"
    : liveFeed.status === "ready"
      ? "Watching"
      : liveFeed.status === "scanning"
        ? "Scanning"
        : liveFeed.status === "waiting"
          ? "Waiting"
          : liveFeed.status === "unsupported"
            ? "Unsupported"
            : "Error";
}

function parsePassivePayloadEnvelope(payload) {
  const text = String(payload || "").trim();
  if (!text.startsWith("LNNRANK|")) {
    return null;
  }

  const fields = {};
  for (const segment of text.split("|").slice(1)) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = segment.slice(0, separatorIndex);
    const value = segment.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }
    fields[key] = value;
  }

  if (!fields.ch || !fields.n || !fields.rg || !fields.sr) {
    return null;
  }

  const timestampMs = Number.parseInt(fields.t || "", 10);
  return {
    eventType: fields.e || "search",
    channelName: fields.ch,
    sessionId: fields.ss || "",
    sequence: Number.parseInt(fields.n, 10) || 0,
    region: fields.rg,
    realm: fields.re || null,
    characterName: fields.nm || null,
    source: fields.sr,
    timestampMs: Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : null,
  };
}

function createPassiveStatChip(label, value, options = {}) {
  const displayValue = value == null || value === "" ? "Unknown" : String(value);
  return `
    <article class="passive-stat-chip${options.code ? " passive-stat-chip-code" : ""}">
      <span class="passive-stat-label">${escapeHtml(label)}</span>
      <strong class="passive-stat-value">${escapeHtml(displayValue)}</strong>
    </article>
  `;
}

function formatReaderAge(value) {
  const timestampMs = Date.parse(value || "");
  if (!Number.isFinite(timestampMs)) {
    return "Never";
  }
  return `${formatDelayMs(Date.now() - timestampMs)} ago`;
}

function formatReaderRegions(regions) {
  const count = Array.isArray(regions) ? regions.length : 0;
  return `${formatCompactNumber(count, 0)} region${count === 1 ? "" : "s"}`;
}

function renderReaderDashboard(data) {
  const target = document.getElementById("readerView");
  if (!target) {
    return;
  }

  const liveFeed = data && data.passiveLiveFeed ? data.passiveLiveFeed : null;
  const passive = data && data.passiveBridge ? data.passiveBridge : null;
  if (!liveFeed) {
    target.innerHTML = `
      <section class="card">
        <div class="card-head">
          <h2>Memory Reader</h2>
        </div>
        ${createEmpty("The memory reader is not available in this dashboard run.")}
      </section>
    `;
    return;
  }

  const isPaused = liveFeed.paused === true || liveFeed.status === "paused";
  const statusLabel = formatPassiveLiveStatus(liveFeed);
  const canToggle = liveFeed.supported !== false;
  const readerButtonLabel = isPaused ? "Resume Reader" : "Pause Reader";
  const readerButtonAction = isPaused ? "resume" : "pause";
  const discoveryPools = liveFeed.discoveryPools && typeof liveFeed.discoveryPools === "object"
    ? Object.entries(liveFeed.discoveryPools)
    : [];
  const readCursor = liveFeed.readCursor || {};
  const statsMarkup = [
    createPassiveStatChip("Status", statusLabel),
    createPassiveStatChip("Channel", liveFeed.channelName || (passive && passive.channelName) || "Unknown", { code: true }),
    createPassiveStatChip("WoW PID", liveFeed.wowProcessId != null ? String(liveFeed.wowProcessId) : "Unknown", { code: true }),
    createPassiveStatChip("Scan Interval", liveFeed.scanIntervalMs != null ? formatDelayMs(liveFeed.scanIntervalMs) : "Unknown"),
    createPassiveStatChip("Last Scan", formatReaderAge(liveFeed.lastScannedAt)),
    createPassiveStatChip("Last Discovery", formatReaderAge(liveFeed.lastDiscoveredAt)),
    createPassiveStatChip("Scan Duration", liveFeed.scanDurationMs != null ? formatDelayMs(liveFeed.scanDurationMs) : "Unknown"),
    createPassiveStatChip("Entries", formatCompactNumber(liveFeed.entryCount ?? 0, 0)),
    createPassiveStatChip("Events", formatCompactNumber(liveFeed.eventCount ?? 0, 0)),
    createPassiveStatChip("Cursor", `${formatCompactNumber(readCursor.sequence || 0, 0)} @ ${readCursor.timestampMs ? formatShortDate(new Date(readCursor.timestampMs).toISOString()) : "none"}`),
  ].join("");

  target.innerHTML = `
    <section class="card reader-overview-card">
      <div class="reader-head">
        <div>
          <h2>Memory Reader</h2>
          <p>Live RAM scanner status and controls. Pausing stops future memory scans until resumed.</p>
        </div>
        <button
          id="readerToggleButton"
          class="${isPaused ? "" : "danger"} compact-toolbar-button"
          type="button"
          data-reader-action="${escapeHtml(readerButtonAction)}"
          ${canToggle ? "" : "disabled"}
        >
          ${escapeHtml(readerButtonLabel)}
        </button>
      </div>
      <div class="passive-stat-grid reader-stat-grid">
        ${statsMarkup}
      </div>
      ${
        liveFeed.lastError
          ? `<div class="reader-error"><strong>Last error</strong><span>${escapeHtml(liveFeed.lastError)}</span></div>`
          : ""
      }
    </section>

    <section class="card reader-detail-card">
      <div class="card-head">
        <h2>Discovery Pools</h2>
      </div>
      ${
        discoveryPools.length
          ? `<div class="reader-pool-list">
              ${discoveryPools
                .map(([key, pool]) => {
                  const regions = Array.isArray(pool && pool.regions) ? pool.regions : [];
                  return `
                    <article class="reader-pool-row">
                      <div class="reader-pool-row-head">
                        <strong>${escapeHtml(key)}</strong>
                        <span>${escapeHtml(formatReaderRegions(regions))}</span>
                      </div>
                      <div class="reader-pool-meta">
                        <span>pattern <code>${escapeHtml(pool && pool.pattern ? pool.pattern : "unknown")}</code></span>
                        <span>scan ${escapeHtml(formatReaderAge(pool && pool.lastScannedAt))}</span>
                        <span>discover ${escapeHtml(formatReaderAge(pool && pool.lastDiscoveredAt))}</span>
                        <span>duration ${escapeHtml(pool && pool.scanDurationMs != null ? formatDelayMs(pool.scanDurationMs) : "Unknown")}</span>
                      </div>
                      ${
                        pool && pool.lastError
                          ? `<div class="reader-pool-error">${escapeHtml(pool.lastError)}</div>`
                          : ""
                      }
                    </article>
                  `;
                })
                .join("")}
            </div>`
          : createEmpty(isPaused ? "Reader is paused; existing pool details will stay frozen." : "No discovery pool has been initialized yet.")
      }
    </section>
  `;
}

function getHiddenLiveLogIds() {
  return new Set(state.liveLogHiddenIds);
}

function comparePassiveLogRecency(left, right) {
  const leftParsed = Date.parse((left && left.sortAt) || "");
  const rightParsed = Date.parse((right && right.sortAt) || "");
  const leftSortAtMs = Number.isFinite(leftParsed) ? leftParsed : 0;
  const rightSortAtMs = Number.isFinite(rightParsed) ? rightParsed : 0;
  if (leftSortAtMs !== rightSortAtMs) {
    return rightSortAtMs - leftSortAtMs;
  }

  const leftSequence = Number((left && left.sequence) || 0);
  const rightSequence = Number((right && right.sequence) || 0);
  return rightSequence - leftSequence;
}

function getPassiveLogSourceEntries(liveFeed) {
  if (liveFeed && Array.isArray(liveFeed.events)) {
    return liveFeed.events;
  }
  if (liveFeed && Array.isArray(liveFeed.readerEvents) && liveFeed.readerEvents.length > 0) {
    return liveFeed.readerEvents;
  }
  return [];
}

function resolvePassivePayloadSortAt(entry, parsed) {
  const timestampMs = Number(parsed && parsed.timestampMs);
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    return new Date(timestampMs).toISOString();
  }

  return (
    (entry && entry.eventAt) ||
    (entry && entry.firstSeenAt) ||
    (entry && entry.lastSeenAt) ||
    (entry && entry.publishedAtIso) ||
    null
  );
}

function resolveVisiblePassiveSession(passive, liveFeed) {
  if (liveFeed && liveFeed.activeSessionId) {
    return liveFeed.activeSessionId;
  }

  const candidates = [];
  const liveEntries = getPassiveLogSourceEntries(liveFeed);

  for (const entry of liveEntries) {
    if (!entry || entry.kind !== "payload" || !entry.preview) {
      continue;
    }

    const parsed = parsePassivePayloadEnvelope(entry.preview);
    if (!parsed || !parsed.sessionId) {
      continue;
    }

    candidates.push({
      source: parsed.source,
      sessionId: parsed.sessionId,
      sortAt: resolvePassivePayloadSortAt(entry, parsed),
      sequence: parsed.sequence,
    });
  }

  const latestCandidate = candidates.sort(comparePassiveLogRecency)[0];
  return (latestCandidate && latestCandidate.sessionId) || (passive && passive.sessionId ? passive.sessionId : null);
}

function buildPassiveLogEntries(passive, liveFeed) {
  const merged = new Map();
  const liveEntries = getPassiveLogSourceEntries(liveFeed);
  const activeChannelName = passive && passive.channelName ? passive.channelName : null;
  const activeSessionId = resolveVisiblePassiveSession(passive, liveFeed);

  function upsertEntry(id, candidate) {
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, candidate);
      return;
    }

    existing.sortAt = latestTimestamp(existing.sortAt, candidate.sortAt);
    existing.title = existing.title || candidate.title;
    existing.source = existing.source || candidate.source;
    existing.sequence = existing.sequence || candidate.sequence;
    existing.payload = existing.payload || candidate.payload;
    existing.receivedAt = latestTimestamp(existing.receivedAt, candidate.receivedAt);
    existing.delayMs =
      existing.delayMs == null
        ? candidate.delayMs
        : candidate.delayMs == null
          ? existing.delayMs
          : Math.max(existing.delayMs, candidate.delayMs);
    existing.transport =
      existing.transport === candidate.transport
        ? existing.transport
        : existing.transport === "Live + Saved" || candidate.transport === "Live + Saved"
          ? "Live + Saved"
          : "Live + Saved";
  }

  for (const entry of liveEntries) {
    if (!entry || entry.kind !== "payload" || !entry.preview) {
      continue;
    }

    const parsed = parsePassivePayloadEnvelope(entry.preview);
    if (!parsed) {
      continue;
    }
    if (activeChannelName && parsed.channelName && parsed.channelName !== activeChannelName) {
      continue;
    }
    if (activeSessionId && parsed.sessionId && parsed.sessionId !== activeSessionId) {
      continue;
    }

    upsertEntry(`payload:${entry.preview}`, {
      id: `payload:${entry.preview}`,
      sortAt: resolvePassivePayloadSortAt(entry, parsed),
      title:
        [parsed.characterName, parsed.realm].filter(Boolean).join("-") ||
        (parsed.eventType === "lfg_status" ? "LFG heartbeat" : "Unknown event"),
      source:
        parsed.eventType === "lfg_status"
          ? "LFG heartbeat"
          : formatSourceLabel(parsed.source),
      sequence: parsed.sequence,
      payload: entry.preview,
      receivedAt: entry.receivedAt || entry.firstSeenAt || entry.lastSeenAt || null,
      delayMs: typeof entry.delayMs === "number" ? entry.delayMs : null,
      transport: "Live",
    });
  }

  return [...merged.values()].sort((left, right) =>
    String(right.sortAt || "").localeCompare(String(left.sortAt || ""), "en-US")
  );
}

function createLiveLogFooterMarkup(visibleCount, totalCount, currentPage, totalPages) {
  const countLabel =
    visibleCount !== totalCount
      ? `${formatCompactNumber(visibleCount, 0)} of ${formatCompactNumber(totalCount, 0)} log entries`
      : `${formatCompactNumber(totalCount, 0)} log entries`;
  const pagerMarkup = totalPages > 1 ? createPagerMarkup("live", currentPage, totalPages) : "";

  return `
    <span class="results-footer-count">${escapeHtml(countLabel)}</span>
    ${pagerMarkup}
  `;
}

function renderPassive(data) {
  const target = document.getElementById("passiveView");
  if (!target) {
    return;
  }

  const passive = data.passiveBridge;
  const liveFeed = data.passiveLiveFeed;
  const hasLiveFeedEvents =
    Boolean(liveFeed && Array.isArray(liveFeed.events) && liveFeed.events.length > 0) ||
    Boolean(liveFeed && Array.isArray(liveFeed.entries) && liveFeed.entries.length > 0);
  if (!passive && !hasLiveFeedEvents) {
    target.innerHTML = `
      <section class="card">
        <div class="card-head">
          <h2>Live Log</h2>
        </div>
        ${createEmpty("Run /reload once after loading the addon, then open this tab again.")}
      </section>
    `;
    return;
  }

  const passiveState = passive || {};
  const playerLabel = [passiveState.playerName, passiveState.realm].filter(Boolean).join("-") || "Unknown";
  const regionLabel = passiveState.region ? String(passiveState.region).toUpperCase() : "Unknown";
  const liveStatus = formatPassiveLiveStatus(liveFeed);
  const allLogEntries = buildPassiveLogEntries(passiveState, liveFeed);
  const hiddenIds = getHiddenLiveLogIds();
  const logEntries = allLogEntries.filter((entry) => !hiddenIds.has(entry.id));
  const pagedLogEntries = paginateItems(logEntries, state.liveLogPage, LIVE_LOG_PAGE_SIZE);
  state.liveLogPage = pagedLogEntries.page;
  persistViewState();
  const liveLogStatusNote =
    liveFeed && liveFeed.lastError && logEntries.length === 0
      ? liveFeed.lastError
      : `${logEntries.length} visible log entr${logEntries.length === 1 ? "y" : "ies"}`;
  const statsMarkup = [
    createPassiveStatChip("Live", liveStatus),
    createPassiveStatChip("Channel", passiveState.channelName || "Unknown", { code: true }),
    createPassiveStatChip("Seq", formatCompactNumber(passiveState.sequence ?? 0, 0)),
    createPassiveStatChip(
      "WoW PID",
      liveFeed && liveFeed.wowProcessId != null ? String(liveFeed.wowProcessId) : "Unknown",
      { code: true }
    ),
    createPassiveStatChip(
      "Scan",
      liveFeed && liveFeed.lastScannedAt ? formatShortDate(liveFeed.lastScannedAt) : "Never"
    ),
  ].join("");

  target.innerHTML = `
    <section class="card passive-card-compact">
      <div class="passive-head-compact">
        <div>
          <h2>Live Log</h2>
          <p>${escapeHtml(playerLabel)} <span class="passive-head-sep">·</span> ${escapeHtml(regionLabel)}</p>
        </div>
        <div class="passive-inline-note">
          ${escapeHtml(liveLogStatusNote)}
        </div>
      </div>
      <div class="passive-stat-grid">
        ${statsMarkup}
      </div>
    </section>

    <section class="card passive-log-card">
      <div class="passive-log-head">
        <div>
          <h2>Relay Log</h2>
          <p>Raw payloads captured by the live channel reader.</p>
        </div>
        <button
          class="danger compact-toolbar-button"
          type="button"
          data-clear-live-log
          ${allLogEntries.length === 0 ? "disabled" : ""}
        >
          Clear Log
        </button>
      </div>
      ${
        pagedLogEntries.items.length
          ? `<div class="passive-log-list">
              ${pagedLogEntries.items
                .map(
                  (entry) => `
                    <article class="passive-log-row">
                      <div class="passive-log-row-head">
                        <strong>${escapeHtml(entry.title)}</strong>
                        <div class="passive-log-meta">
                          <span>sent ${escapeHtml(entry.sortAt ? formatDate(entry.sortAt) : "Unknown time")}</span>
                          <span>recv ${escapeHtml(entry.receivedAt ? formatDate(entry.receivedAt) : "Unknown time")}</span>
                          <span>delay ${escapeHtml(entry.delayMs != null ? formatDelayMs(entry.delayMs) : "Unknown")}</span>
                          <span>${escapeHtml(entry.source)}</span>
                          <span>seq ${escapeHtml(formatCompactNumber(entry.sequence || 0, 0))}</span>
                          <span>${escapeHtml(entry.transport)}</span>
                        </div>
                      </div>
                      <pre class="code-block passive-log-payload">${escapeHtml(entry.payload || "")}</pre>
                    </article>
                  `
                )
                .join("")}
            </div>`
          : createEmpty(
              logEntries.length === 0 && allLogEntries.length > 0
                ? "Live log cleared. New relay payloads will appear here."
                : liveFeed && liveFeed.lastError
                ? "The live scanner hit an error, so there are no clean payloads to show yet."
                : "No relay payloads have been captured yet."
            )
      }
      <div class="results-footer pager passive-log-footer">
        ${createLiveLogFooterMarkup(logEntries.length, allLogEntries.length, pagedLogEntries.page, pagedLogEntries.totalPages)}
      </div>
    </section>
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
    const groupID =
      entry.groupID ||
      entry.groupId ||
      entry.applicantID ||
      `solo:${entry.key || buildClientCacheKey(entry.region, entry.realm, entry.characterName)}`;
    if (!groups.has(groupID)) {
      groups.set(groupID, {
        applicantID: groupID,
        entries: [],
        latestSeenAt: 0,
      });
    }

    const group = groups.get(groupID);
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
  const classColor = resolveLfgClassColor(entry, record);
  const nameStyle = classColor ? ` style="color: ${escapeHtml(classColor)}"` : "";
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
            }))}" target="_blank" rel="noreferrer noopener"><strong${nameStyle}>${escapeHtml(entry.characterName)}</strong></a>
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

  renderQueueWorker(state.data);
  renderResults(state.data);
  renderQueue(state.data);
  renderPassive(state.data);
  renderReaderDashboard(state.data);
  renderRosterList("applicantList", state.data.applicants, "No live LFG applicants right now.", state.data);
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

function isConfirmModalOpen() {
  const modal = document.getElementById("confirmModal");
  return Boolean(modal && !modal.hidden);
}

function closeConfirmModal(options = {}) {
  const modal = document.getElementById("confirmModal");
  if (!modal) {
    return;
  }

  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("has-modal");
  confirmModalAction = null;

  if (options.restoreFocus !== false && confirmModalReturnFocus && typeof confirmModalReturnFocus.focus === "function") {
    confirmModalReturnFocus.focus();
  }
  confirmModalReturnFocus = null;
}

function openConfirmModal(config) {
  const modal = document.getElementById("confirmModal");
  if (!modal) {
    return;
  }

  confirmModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmModalAction = config.onConfirm || null;
  document.getElementById("confirmModalTitle").textContent = config.title;
  document.getElementById("confirmModalMessage").textContent = config.message;
  document.getElementById("confirmAcceptButton").textContent = config.confirmLabel || "Confirm";
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("has-modal");
  window.requestAnimationFrame(() => {
    document.getElementById("confirmAcceptButton").focus();
  });
}

function requestClearResultsCache() {
  openConfirmModal({
    title: "Clear cached results?",
    message: "This removes all cached character results from the local app cache. Pending queue entries stay intact.",
    confirmLabel: "Clear Cache",
    onConfirm: () => {
      closeConfirmModal({ restoreFocus: false });
      void clearResultsCache();
    },
  });
}

function requestClearLfgApplicants() {
  void clearLfgApplicants();
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
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Clear Cache";
    }
  }
}

async function clearLfgApplicants() {
  const button = document.getElementById("clearLfgButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Clearing...";
  }

  try {
    await fetch("/api/lfg/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Clear LFG";
    }
  }
}

async function forceSearchCharacter({ region, realm, name }, button = null) {
  if (!realm || !name) {
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Queued";
  }

  try {
    await fetch("/api/manual-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        region: region || "us",
        realm,
        name,
        force: true,
      }),
    });
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Force Search";
    }
  }
}

async function clearLiveLog() {
  const button = document.querySelector("[data-clear-live-log]");
  if (button) {
    button.disabled = true;
    button.textContent = "Clearing...";
  }

  try {
    await fetch("/api/live-log/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    state.liveLogHiddenIds = [];
    state.liveLogPage = 1;
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Clear Log";
    }
  }
}

async function toggleReader(action, button = null) {
  const endpoint = action === "resume" ? "/api/passive-live/resume" : "/api/passive-live/pause";
  if (button) {
    button.disabled = true;
    button.textContent = action === "resume" ? "Resuming..." : "Pausing...";
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`Reader ${action} failed.`);
    }
    await loadState();
  } finally {
    if (button) {
      button.disabled = false;
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
    } else if (target === "live") {
      state.liveLogPage = Math.max(1, state.liveLogPage + (action === "next" ? 1 : -1));
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
      requestClearResultsCache();
    });
  }

  const clearLfgButton = document.getElementById("clearLfgButton");
  if (clearLfgButton) {
    clearLfgButton.addEventListener("click", () => {
      requestClearLfgApplicants();
    });
  }

  const confirmCancelButton = document.getElementById("confirmCancelButton");
  if (confirmCancelButton) {
    confirmCancelButton.addEventListener("click", () => {
      closeConfirmModal();
    });
  }

  const confirmAcceptButton = document.getElementById("confirmAcceptButton");
  if (confirmAcceptButton) {
    confirmAcceptButton.addEventListener("click", () => {
      if (typeof confirmModalAction === "function") {
        confirmModalAction();
      } else {
        closeConfirmModal();
      }
    });
  }

  document.body.addEventListener("click", (event) => {
    const clickTarget =
      event.target instanceof Element ? event.target : event.target && event.target.parentElement ? event.target.parentElement : null;
    if (!clickTarget) {
      return;
    }

    const confirmDismissTarget = clickTarget.closest("[data-confirm-dismiss]");
    if (confirmDismissTarget) {
      closeConfirmModal();
      return;
    }

    const clearLiveLogButton = clickTarget.closest("[data-clear-live-log]");
    if (clearLiveLogButton) {
      void clearLiveLog();
      return;
    }

    const readerToggleButton = clickTarget.closest("[data-reader-action]");
    if (readerToggleButton) {
      void toggleReader(readerToggleButton.dataset.readerAction, readerToggleButton);
      return;
    }

    const sortButton = clickTarget.closest("[data-sort-column]");
    if (sortButton) {
      const nextColumn = normalizeSortColumn(sortButton.dataset.sortColumn);
      if (state.resultSort === nextColumn) {
        state.resultSortDirection = state.resultSortDirection === "asc" ? "desc" : "asc";
      } else {
        state.resultSort = nextColumn;
        state.resultSortDirection = nextColumn === "updatedAt" ? "desc" : "asc";
      }
      state.resultsPage = 1;
      persistViewState();
      if (state.data) {
        renderResults(state.data);
      }
      return;
    }

    const forceButton = clickTarget.closest("[data-force-search]");
    if (forceButton) {
      void forceSearchCharacter(
        {
          region: forceButton.dataset.forceRegion || "us",
          realm: forceButton.dataset.forceRealm,
          name: forceButton.dataset.forceName,
        },
        forceButton
      );
      return;
    }

    const removeButton = clickTarget.closest("[data-remove-queue]");
    if (removeButton) {
      void removeQueue(removeButton.dataset.removeQueue);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isConfirmModalOpen()) {
      closeConfirmModal();
    }
  });
}

loadPersistedViewState();
bindEvents();
applyActiveTab();
void loadState();
setInterval(() => {
  void loadState();
}, 1000);
