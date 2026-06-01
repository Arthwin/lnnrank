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
const DEFAULT_MAX_MATCHES = 4;
const DEFAULT_CONTEXT_BYTES = 192;
const LIVE_ENTRY_LIMIT = 40;

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
    /LNNRANK\|ch=[A-Za-z0-9_:=.]{1,30}\|ss=[A-Za-z0-9_:=.]{1,20}\|n=\d{1,10}\|rg=[A-Za-z0-9_:=.]{1,8}\|re=[A-Za-z0-9_:=.]{1,32}\|nm=[A-Za-z0-9_:=.]{1,32}\|sr=[A-Za-z0-9_]{1,16}(?:\|ai=\d{1,10})?(?:\|mi=\d{1,3})?(?:\|ar=[A-Za-z0-9_:=.]{1,16})?(?:\|cl=[A-Za-z0-9_:=.]{1,16})?(?:\|il=\d{1,4}(?:\.\d{1,2})?)?(?:\|lv=\d{1,3})?/u
  );
  if (!match) {
    return null;
  }
  return match[0];
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
    .slice(0, 3)
    .map((entry) => `0x${entry.numericAddress.toString(16).toUpperCase("en-US")}`);
}

function createPassiveLiveFeedMonitor(options = {}) {
  const scanIntervalMs = Math.max(
    1500,
    Number.parseInt(String(options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS), 10) || DEFAULT_SCAN_INTERVAL_MS
  );
  const state = {
    supported: process.platform === "win32",
    status: "idle",
    channelName: null,
    wowProcessId: null,
    lastScannedAt: null,
    lastError: null,
    scanDurationMs: null,
    discoveryAddresses: [],
    entries: [],
    currentPromise: null,
  };

  function resetForChannel(channelName) {
    state.channelName = channelName || null;
    state.wowProcessId = null;
    state.lastScannedAt = null;
    state.lastError = null;
    state.scanDurationMs = null;
    state.discoveryAddresses = [];
    state.entries = [];
    state.status = channelName ? "idle" : "waiting";
  }

  function mergeEntries(nextEntries, observedAtIso) {
    const merged = new Map(state.entries.map((entry) => [entry.key, entry]));
    for (const entry of nextEntries) {
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
        existing.address = entry.address;
        existing.encoding = entry.encoding;
        existing.kind = entry.kind;
        continue;
      }

      merged.set(entry.key, {
        ...entry,
        firstSeenAt: observedAtIso,
        lastSeenAt: observedAtIso,
      });
    }

    state.entries = [...merged.values()]
      .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""), "en-US"))
      .slice(0, LIVE_ENTRY_LIMIT);
  }

  function snapshot() {
    return {
      supported: state.supported,
      status: state.status,
      channelName: state.channelName,
      wowProcessId: state.wowProcessId,
      lastScannedAt: state.lastScannedAt,
      lastError: state.lastError,
      scanDurationMs: state.scanDurationMs,
      discoveryAddresses: state.discoveryAddresses,
      entries: state.entries,
      entryCount: state.entries.length,
    };
  }

  async function refresh(passiveBridge) {
    const channelName =
      passiveBridge && passiveBridge.enabled && passiveBridge.channelName
        ? String(passiveBridge.channelName).trim()
        : "";

    if (!state.supported) {
      state.status = "unsupported";
      return;
    }

    if (!channelName) {
      resetForChannel(null);
      return;
    }

    if (state.channelName !== channelName) {
      resetForChannel(channelName);
    }

    if (state.currentPromise) {
      return state.currentPromise;
    }

    const lastScanMs = Date.parse(state.lastScannedAt || "");
    if (Number.isFinite(lastScanMs) && Date.now() - lastScanMs < scanIntervalMs) {
      return null;
    }

    state.status = "scanning";
    state.lastError = null;
    const scanStartedAt = Date.now();

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
      const result =
        Array.isArray(state.discoveryAddresses) && state.discoveryAddresses.length > 0
          ? await readPassiveMemoryAddresses({
              processId: wowProcess.processId,
              addresses: state.discoveryAddresses,
            })
          : await discoverPassiveChannelMemory({
              processId: wowProcess.processId,
              channelName,
            });
      const observedAtIso = new Date().toISOString();
      mergeEntries(extractPassiveLiveFeedEntries(result), observedAtIso);
      if (!state.discoveryAddresses.length) {
        state.discoveryAddresses = selectPassiveAddressCandidates(result);
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
  createPassiveLiveFeedMonitor,
  extractCanonicalPayload,
  extractPassiveLiveFeedEntries,
  normalizePassivePreview,
  selectPassiveAddressCandidates,
};
