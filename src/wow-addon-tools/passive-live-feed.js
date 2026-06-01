"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HELPER_PROJECT_PATH = path.join(__dirname, "passive-live-scanner", "PassiveLiveScanner.csproj");
const HELPER_SOURCE_PATH = path.join(__dirname, "passive-live-scanner", "Program.cs");
const HELPER_OUTPUT_DIR = path.join(REPO_ROOT, "output", "passive-live-scanner");
const HELPER_DLL_PATH = path.join(HELPER_OUTPUT_DIR, "PassiveLiveScanner.dll");
const DEFAULT_SCAN_INTERVAL_MS = 1500;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 25000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_MAX_MATCHES = 24;
const DEFAULT_CONTEXT_BYTES = 192;
const LIVE_ENTRY_LIMIT = 40;
const LIVE_EVENT_LIMIT = 400;
const DEFAULT_DISCOVERY_REFRESH_MS = 5000;

let helperBuildPromise = null;

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = [stderr, stdout, error.message].filter(Boolean).join("\n").trim();
          reject(new Error(details || `Command failed: ${file}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function helperNeedsBuild() {
  if (!fs.existsSync(HELPER_DLL_PATH)) {
    return true;
  }

  const helperMtimeMs = fs.statSync(HELPER_DLL_PATH).mtimeMs;
  const sourceMtimeMs = Math.max(
    fs.existsSync(HELPER_PROJECT_PATH) ? fs.statSync(HELPER_PROJECT_PATH).mtimeMs : 0,
    fs.existsSync(HELPER_SOURCE_PATH) ? fs.statSync(HELPER_SOURCE_PATH).mtimeMs : 0
  );
  return sourceMtimeMs > helperMtimeMs;
}

async function ensureHelperBuilt() {
  if (process.platform !== "win32") {
    throw new Error("Passive live feed is currently only supported on Windows.");
  }

  if (!helperNeedsBuild()) {
    return HELPER_DLL_PATH;
  }

  if (!helperBuildPromise) {
    helperBuildPromise = (async () => {
      fs.mkdirSync(HELPER_OUTPUT_DIR, { recursive: true });
      await execFileText(
        "dotnet",
        ["build", HELPER_PROJECT_PATH, "-c", "Release", "-o", HELPER_OUTPUT_DIR],
        { cwd: REPO_ROOT }
      );
      return HELPER_DLL_PATH;
    })().finally(() => {
      helperBuildPromise = null;
    });
  }

  return helperBuildPromise;
}

async function detectWowProcess() {
  if (process.platform !== "win32") {
    return null;
  }

  const { stdout } = await execFileText("tasklist", ["/FI", "IMAGENAME eq Wow.exe", "/FO", "CSV", "/NH"]);
  const line = String(stdout || "")
    .trim()
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("INFO:"));

  if (!line) {
    return null;
  }

  const fields = line
    .replace(/^"|"$/gu, "")
    .split('","')
    .map((entry) => entry.trim());
  const processId = Number.parseInt(fields[1] || "", 10);
  if (!Number.isFinite(processId) || processId <= 0) {
    return null;
  }

  return {
    processId,
    imageName: fields[0] || "Wow.exe",
  };
}

async function discoverPassiveChannelMemory(options) {
  const helperPath = await ensureHelperBuilt();
  const args = [
    helperPath,
    "discover",
    "--pid",
    String(options.processId),
    "--pattern",
    String(options.channelName),
    "--maxMatches",
    String(options.maxMatches || DEFAULT_MAX_MATCHES),
    "--contextBytes",
    String(options.contextBytes || DEFAULT_CONTEXT_BYTES),
  ];

  const { stdout } = await execFileText("dotnet", args, {
    cwd: REPO_ROOT,
    timeout: options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS,
  });
  return normalizeScanResult(JSON.parse(stdout));
}

async function readPassiveMemoryAddresses(options) {
  const helperPath = await ensureHelperBuilt();
  const args = [
    helperPath,
    "read",
    "--pid",
    String(options.processId),
    "--addresses",
    options.addresses.map((entry) => String(entry)).join(","),
    "--contextBytes",
    String(options.contextBytes || DEFAULT_CONTEXT_BYTES),
  ];

  const { stdout } = await execFileText("dotnet", args, {
    cwd: REPO_ROOT,
    timeout: options.timeoutMs || DEFAULT_READ_TIMEOUT_MS,
  });
  return normalizeScanResult(JSON.parse(stdout));
}

function normalizeScanResult(result) {
  const matches = Array.isArray(result && result.matches) ? result.matches : [];
  return {
    ...result,
    matches: matches.map((match) => ({
      address: match.address || match.Address || null,
      encoding: match.encoding || match.Encoding || null,
      regionBase: match.regionBase || match.RegionBase || null,
      previewUtf8: match.previewUtf8 || match.PreviewUtf8 || "",
      previewUtf16: match.previewUtf16 || match.PreviewUtf16 || "",
    })),
  };
}

function extractCanonicalPayload(text) {
  const match = String(text || "").match(
    /LNNRANK\|ch=[A-Za-z0-9_:=.]{1,30}\|ss=[A-Za-z0-9_:=.]{0,20}\|n=\d{1,10}\|rg=[A-Za-z0-9_:=.]{1,8}\|re=[A-Za-z0-9_:=.]{1,32}\|nm=[A-Za-z0-9_:=.]{1,32}\|sr=[A-Za-z0-9_]{1,16}(?:\|ai=\d{1,10})?(?:\|gi=\d{1,10})?(?:\|mi=\d{1,3})?(?:\|ar=[A-Za-z0-9_:=.]{1,16})?(?:\|cl=[A-Za-z0-9_:=.]{1,16})?(?:\|il=\d{1,4}(?:\.\d{1,2})?)?(?:\|lv=\d{1,3})?(?:\|t=\d{10,13})?/u
  );
  if (!match) {
    return null;
  }
  return match[0];
}

function extractPayloadTimestampMs(payload) {
  const match = String(payload || "").match(/\|t=(\d{10,13})(?:\||$)/u);
  if (!match) {
    return null;
  }

  const rawValue = match[1];
  const numericValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return rawValue.length <= 10 ? numericValue * 1000 : numericValue;
}

function extractPassiveLiveFeedEntries(scanResult) {
  const matches = Array.isArray(scanResult && scanResult.matches) ? scanResult.matches : [];
  const entries = [];
  const seen = new Set();

  for (const match of matches) {
    for (const preview of [match.previewUtf8, match.previewUtf16]) {
      const normalized = normalizePassivePreview(preview);
      if (!normalized) {
        continue;
      }

      const key = normalized.preview;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      entries.push({
        key,
        address: match.address,
        encoding: match.encoding,
        kind: normalized.kind,
        preview: normalized.preview,
      });
    }
  }

  return entries;
}

function trimAtNoiseBoundary(text) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }

  const match = value.match(/^(.*?)(?:\.{4,}| {3,}|$)/u);
  return (match ? match[1] : value).trim();
}

function normalizePassivePreview(preview) {
  const raw = String(preview || "").trim();
  if (!raw || (!raw.includes("LNNRANK|") && !raw.includes("lnnrank"))) {
    return null;
  }

  const payload = extractCanonicalPayload(raw);
  if (payload) {
    return {
      kind: "payload",
      preview: payload,
    };
  }

  const plain = raw
    .replace(/\|c[0-9A-Fa-f]{8}/gu, "")
    .replace(/\|r/gu, "")
    .replace(/\|Hchannel:channel:\d+\|h(\[[^\]]*lnnrank[^\]]+\])\|h/gu, "$1")
    .replace(/\|Hplayer:([^:|]+):[^|]*\|h\[[^\]]+\]\|h/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();

  const chatMatch = plain.match(/(?:\d{2}:\d{2}\s+)?(\[[^\]]*lnnrank[^\]]+\]\s+[^:]+:\s*.+)/u);
  if (chatMatch) {
    const message = trimAtNoiseBoundary(chatMatch[1]);
    if (message) {
      return {
        kind: "chat",
        preview: message,
      };
    }
  }

  const channelMatch = raw.match(/lnnrank[a-z0-9]+/iu);
  if (channelMatch) {
    return {
      kind: "channel",
      preview: channelMatch[0].toLowerCase(),
    };
  }

  const fallback = trimAtNoiseBoundary(plain || raw);
  return fallback
    ? {
        kind: "memory-hit",
        preview: fallback,
      }
    : null;
}

function selectPassiveAddressCandidates(scanResult) {
  const matches = Array.isArray(scanResult && scanResult.matches) ? scanResult.matches : [];
  return matches
    .map((match) => {
      const preview = String(match.previewUtf8 || match.previewUtf16 || "");
      let priority = 0;
      if (preview.includes("]:")) {
        priority += 3;
      }
      if (preview.includes("LNNRANK|")) {
        priority += 2;
      }
      if (preview.includes("lnnrank")) {
        priority += 1;
      }

      return {
        address: match.address,
        numericAddress: Number.parseInt(String(match.address || "").replace(/^0x/iu, ""), 16),
        priority,
      };
    })
    .filter((entry) => Number.isFinite(entry.numericAddress) && entry.numericAddress > 0)
    .sort((left, right) => right.priority - left.priority || left.numericAddress - right.numericAddress)
    .slice(0, 12)
    .map((entry) => `0x${entry.numericAddress.toString(16).toUpperCase("en-US")}`);
}

function normalizePassiveDiscoveryToken(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/gu, "");
}

function buildPassiveDiscoveryPattern(passiveBridge) {
  const channelName = normalizePassiveDiscoveryToken(passiveBridge && passiveBridge.channelName);
  const playerKey = normalizePassiveDiscoveryToken(passiveBridge && passiveBridge.playerKey);
  const sessionId = normalizePassiveDiscoveryToken(passiveBridge && passiveBridge.sessionId);

  if (channelName && sessionId) {
    return `LNNRANK|ch=${channelName}|ss=${sessionId}`;
  }

  if (channelName && playerKey && channelName.includes(playerKey)) {
    return `LNNRANK|ch=${channelName}`;
  }

  if (playerKey.length >= 6) {
    return `LNNRANK|ch=lnnrank${playerKey}`;
  }

  if (channelName.startsWith("lnnrank") && channelName.length > "lnnrank".length + 4) {
    return `LNNRANK|ch=${channelName}`;
  }

  return channelName ? `LNNRANK|ch=${channelName}` : null;
}

function createPassiveLiveFeedMonitor(options = {}) {
  const scanIntervalMs = Math.max(
    1500,
    Number.parseInt(String(options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS), 10) || DEFAULT_SCAN_INTERVAL_MS
  );
  const discoveryRefreshMs = Math.max(
    scanIntervalMs * 2,
    Number.parseInt(String(options.discoveryRefreshMs || DEFAULT_DISCOVERY_REFRESH_MS), 10) ||
      DEFAULT_DISCOVERY_REFRESH_MS
  );
  const discoveryRetryIntervalMs = Math.max(scanIntervalMs, 12000);
  const state = {
    supported: process.platform === "win32",
    status: "idle",
    channelName: null,
    sessionId: null,
    discoveryPattern: null,
    wowProcessId: null,
    lastScannedAt: null,
    lastDiscoveredAt: null,
    lastError: null,
    scanDurationMs: null,
    discoveryAddresses: [],
    entries: [],
    events: [],
    lastSearchStartedAtMs: 0,
    currentPromise: null,
  };

  function resetForChannel(channelName) {
    state.channelName = channelName || null;
    state.sessionId = null;
    state.discoveryPattern = null;
    state.wowProcessId = null;
    state.lastScannedAt = null;
    state.lastDiscoveredAt = null;
    state.lastError = null;
    state.scanDurationMs = null;
    state.discoveryAddresses = [];
    state.entries = [];
    state.events = [];
    state.lastSearchStartedAtMs = 0;
    state.status = channelName ? "idle" : "waiting";
  }

  function mergeEntries(nextEntries, observedAtIso, previousSearchStartedAtMs) {
    const merged = new Map(state.entries.map((entry) => [entry.key, entry]));
    const newEvents = [];
    for (const entry of nextEntries) {
      const payloadTimestampMs =
        entry.kind === "payload" && typeof entry.preview === "string" ? extractPayloadTimestampMs(entry.preview) : null;
      if (
        payloadTimestampMs != null &&
        Number.isFinite(previousSearchStartedAtMs) &&
        previousSearchStartedAtMs > 0 &&
        payloadTimestampMs < previousSearchStartedAtMs
      ) {
        continue;
      }

      const eventAtIso =
        payloadTimestampMs != null && payloadTimestampMs > 0 ? new Date(payloadTimestampMs).toISOString() : observedAtIso;
      if (entry.encoding === "window" && entry.address) {
        for (const [existingKey, existingEntry] of merged.entries()) {
          if (existingEntry.address === entry.address && existingEntry.encoding !== "window") {
            merged.delete(existingKey);
          }
        }
      }

      const existing = merged.get(entry.key);
      if (existing) {
        existing.lastSeenAt = observedAtIso;
        existing.seenCount = Number(existing.seenCount || 0) + 1;
        existing.address = entry.address;
        existing.encoding = entry.encoding;
        existing.kind = entry.kind;
        continue;
      }

      merged.set(entry.key, {
        ...entry,
        eventAt: eventAtIso,
        firstSeenAt: observedAtIso,
        lastSeenAt: observedAtIso,
        seenCount: 1,
      });
      newEvents.push({
        ...entry,
        eventAt: eventAtIso,
      });
    }

    state.entries = [...merged.values()]
      .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""), "en-US"))
      .slice(0, LIVE_ENTRY_LIMIT);
    if (newEvents.length > 0) {
      state.events = [...state.events, ...newEvents]
        .sort((left, right) => String(left.eventAt || "").localeCompare(String(right.eventAt || ""), "en-US"))
        .slice(-LIVE_EVENT_LIMIT);
    }
  }

  function snapshot() {
    return {
      supported: state.supported,
      status: state.status,
      channelName: state.channelName,
      sessionId: state.sessionId,
      discoveryPattern: state.discoveryPattern,
      wowProcessId: state.wowProcessId,
      lastScannedAt: state.lastScannedAt,
      lastError: state.lastError,
      scanDurationMs: state.scanDurationMs,
      discoveryAddresses: state.discoveryAddresses,
      entries: state.entries,
      entryCount: state.entries.length,
      events: state.events,
      eventCount: state.events.length,
    };
  }

  async function refresh(passiveBridge) {
    const channelName =
      passiveBridge && passiveBridge.enabled && passiveBridge.channelName
        ? String(passiveBridge.channelName).trim()
        : "";
    const sessionId =
      passiveBridge && passiveBridge.enabled && passiveBridge.sessionId ? String(passiveBridge.sessionId).trim() : "";
    const discoveryPattern =
      passiveBridge && passiveBridge.enabled ? buildPassiveDiscoveryPattern(passiveBridge) : null;

    if (!state.supported) {
      state.status = "unsupported";
      return;
    }

    if (!channelName || !discoveryPattern) {
      resetForChannel(null);
      return;
    }

    if (state.channelName !== channelName || state.discoveryPattern !== discoveryPattern) {
      resetForChannel(channelName);
      state.sessionId = sessionId || null;
      state.discoveryPattern = discoveryPattern;
    } else if ((state.sessionId || "") !== sessionId) {
      resetForChannel(channelName);
      state.sessionId = sessionId || null;
      state.discoveryPattern = discoveryPattern;
    }

    if (state.currentPromise) {
      return state.currentPromise;
    }

    const lastScanMs = Date.parse(state.lastScannedAt || "");
    const lastDiscoveryMs = Date.parse(state.lastDiscoveredAt || "");
    const activeIntervalMs =
      Array.isArray(state.discoveryAddresses) && state.discoveryAddresses.length > 0
        ? scanIntervalMs
        : discoveryRetryIntervalMs;
    if (Number.isFinite(lastScanMs) && Date.now() - lastScanMs < activeIntervalMs) {
      return null;
    }

    state.status = "scanning";
    state.lastError = null;
    const scanStartedAt = Date.now();
    const previousSearchStartedAtMs = state.lastSearchStartedAtMs;
    state.lastSearchStartedAtMs = scanStartedAt;

    const run = (async () => {
      const wowProcess = await detectWowProcess();
      if (!wowProcess) {
        state.status = "waiting";
        state.wowProcessId = null;
        state.lastError = "WoW process not found.";
        state.lastScannedAt = new Date().toISOString();
        state.scanDurationMs = Date.now() - scanStartedAt;
        return;
      }

      state.wowProcessId = wowProcess.processId;
      const shouldRediscover =
        !Array.isArray(state.discoveryAddresses) ||
        state.discoveryAddresses.length === 0 ||
        !Number.isFinite(lastDiscoveryMs) ||
        Date.now() - lastDiscoveryMs >= discoveryRefreshMs;
      const result = shouldRediscover
        ? await discoverPassiveChannelMemory({
            processId: wowProcess.processId,
            channelName: discoveryPattern,
            maxMatches: options.maxMatches || DEFAULT_MAX_MATCHES,
          })
        : await readPassiveMemoryAddresses({
            processId: wowProcess.processId,
            addresses: state.discoveryAddresses,
          });
      const observedAtIso = new Date().toISOString();
      const nextEntries = extractPassiveLiveFeedEntries(result);
      mergeEntries(nextEntries, observedAtIso, previousSearchStartedAtMs);
      if (shouldRediscover || !state.discoveryAddresses.length) {
        state.discoveryAddresses = selectPassiveAddressCandidates(result);
        state.lastDiscoveredAt = observedAtIso;
      }
      if (!nextEntries.some((entry) => entry.kind === "payload")) {
        state.discoveryAddresses = [];
      }
      state.lastScannedAt = observedAtIso;
      state.scanDurationMs = Number(result && result.durationMs) || Date.now() - scanStartedAt;
      state.status = "ready";
    })()
      .catch((error) => {
        state.status = "error";
        state.lastError = error.message || "Passive live feed scan failed.";
        if (state.discoveryAddresses.length > 0) {
          state.discoveryAddresses = [];
        }
        state.lastScannedAt = new Date().toISOString();
        state.scanDurationMs = Date.now() - scanStartedAt;
      })
      .finally(() => {
        state.currentPromise = null;
      });

    state.currentPromise = run;
    return run;
  }

  return {
    refresh,
    snapshot,
  };
}

module.exports = {
  buildPassiveDiscoveryPattern,
  createPassiveLiveFeedMonitor,
  extractCanonicalPayload,
  extractPassiveLiveFeedEntries,
  normalizePassivePreview,
  selectPassiveAddressCandidates,
};
