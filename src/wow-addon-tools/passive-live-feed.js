"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  extractCanonicalPayload,
  extractPayloadTimestampMs,
  normalizeAddonTransportText,
  parseAddonEventPayload,
} = require("./addon-event-format");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HELPER_PROJECT_PATH = path.join(__dirname, "passive-live-scanner", "PassiveLiveScanner.csproj");
const HELPER_SOURCE_PATH = path.join(__dirname, "passive-live-scanner", "Program.cs");
const HELPER_OUTPUT_DIR = path.join(REPO_ROOT, "output", "passive-live-scanner");
const HELPER_DLL_PATH = path.join(HELPER_OUTPUT_DIR, "PassiveLiveScanner.dll");
const DEFAULT_SCAN_INTERVAL_MS = 500;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 60000;
const DEFAULT_REGION_SCAN_TIMEOUT_MS = 4000;
const DEFAULT_DISCOVERY_MAX_MATCHES = 24;
const DEFAULT_REGION_MAX_MATCHES = 96;
const DEFAULT_CONTEXT_BYTES = 256;
const LIVE_ENTRY_LIMIT = 40;
const LIVE_EVENT_LIMIT = 400;
const LIVE_REGION_LIMIT = 12;
const DEFAULT_DISCOVERY_REFRESH_MS = 2000;

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
    String(options.maxMatches || DEFAULT_DISCOVERY_MAX_MATCHES),
    "--contextBytes",
    String(options.contextBytes || DEFAULT_CONTEXT_BYTES),
  ];

  const { stdout } = await execFileText("dotnet", args, {
    cwd: REPO_ROOT,
    timeout: options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS,
  });
  return normalizeScanResult(JSON.parse(stdout));
}

async function scanPassiveMemoryRegions(options) {
  const helperPath = await ensureHelperBuilt();
  const args = [
    helperPath,
    "scan-regions",
    "--pid",
    String(options.processId),
    "--regions",
    options.regions.map((entry) => `${String(entry.regionBase)}:${String(entry.regionSize)}`).join(","),
    "--pattern",
    String(options.pattern || "LNNRANK"),
    "--maxMatches",
    String(options.maxMatches || DEFAULT_REGION_MAX_MATCHES),
    "--contextBytes",
    String(options.contextBytes || DEFAULT_CONTEXT_BYTES),
  ];

  const { stdout } = await execFileText("dotnet", args, {
    cwd: REPO_ROOT,
    timeout: options.timeoutMs || DEFAULT_REGION_SCAN_TIMEOUT_MS,
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
      regionSize: match.regionSize || match.RegionSize || null,
      previewUtf8: match.previewUtf8 || match.PreviewUtf8 || "",
      previewUtf16: match.previewUtf16 || match.PreviewUtf16 || "",
    })),
  };
}

function extractPassiveLiveFeedEntries(scanResult) {
  const matches = Array.isArray(scanResult && scanResult.matches) ? scanResult.matches : [];
  const entries = [];
  const seen = new Set();

  for (const match of matches) {
    for (const preview of [match.previewUtf8, match.previewUtf16]) {
      for (const normalized of extractPassivePreviewEntries(preview)) {
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
  }

  return entries;
}

function extractCanonicalPayloads(preview) {
  const raw = normalizeAddonTransportText(preview);
  const payloads = [];
  const seen = new Set();
  let offset = 0;

  while (offset < raw.length) {
    const startIndex = raw.indexOf("LNNRANK|", offset);
    if (startIndex < 0) {
      break;
    }

    const nextStartIndex = raw.indexOf("LNNRANK|", startIndex + "LNNRANK|".length);
    const payload = extractCanonicalPayload(
      nextStartIndex >= 0 ? raw.slice(startIndex, nextStartIndex) : raw.slice(startIndex)
    );
    if (payload && !seen.has(payload)) {
      seen.add(payload);
      payloads.push(payload);
    }

    offset = startIndex + "LNNRANK|".length;
  }

  return payloads;
}

function extractPassivePreviewEntries(preview) {
  const payloads = extractCanonicalPayloads(preview);
  if (payloads.length > 0) {
    return payloads.map((payload) => ({
      kind: "payload",
      preview: payload,
    }));
  }

  const normalized = normalizePassivePreview(preview);
  return normalized ? [normalized] : [];
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
  const normalizedRaw = normalizeAddonTransportText(raw);
  if (!normalizedRaw || (!normalizedRaw.includes("LNNRANK|") && !normalizedRaw.includes("lnnrank"))) {
    return null;
  }

  const payload = extractCanonicalPayload(normalizedRaw);
  if (payload) {
    return {
      kind: "payload",
      preview: payload,
    };
  }

  if (normalizedRaw.includes("LNNRANK|")) {
    return null;
  }

  const plain = normalizedRaw
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

  const channelMatch = normalizedRaw.match(/lnnrank[a-z0-9]+/iu);
  if (channelMatch) {
    return {
      kind: "channel",
      preview: channelMatch[0].toLowerCase(),
    };
  }

  const fallback = trimAtNoiseBoundary(plain || normalizedRaw);
  return fallback
    ? {
        kind: "memory-hit",
        preview: fallback,
      }
    : null;
}

function parsePassiveCandidateMetadata(preview) {
  const payloads = extractCanonicalPayloads(preview);
  const payload =
    payloads.length > 0
      ? payloads
          .map((candidate) => {
            const parsed = parseAddonEventPayload(candidate) || null;
            return {
              payload: candidate,
              parsed,
              timestampMs: parsed ? Number(parsed.capturedAtMs || 0) : extractPayloadTimestampMs(candidate) || 0,
              sequence: parsed ? Number(parsed.sequence || 0) : 0,
            };
          })
          .sort((left, right) => right.timestampMs - left.timestampMs || right.sequence - left.sequence)[0].payload
      : extractCanonicalPayload(preview);
  if (!payload) {
    return {
      payload: null,
      eventType: null,
      source: null,
      channelName: null,
      sessionId: null,
      sequence: 0,
      timestampMs: 0,
    };
  }

  const parsed = parseAddonEventPayload(payload) || null;
  return {
    payload,
    eventType: parsed ? parsed.eventType : null,
    source: parsed ? parsed.source : null,
    channelName: parsed ? parsed.channelName || null : null,
    sessionId: parsed ? parsed.sessionId || null : null,
    sequence: parsed ? Number(parsed.sequence || 0) : 0,
    timestampMs: parsed ? Number(parsed.capturedAtMs || 0) : extractPayloadTimestampMs(payload) || 0,
  };
}

function parseBestPassiveCandidateMetadata(previews) {
  let bestMetadata = null;
  for (const preview of previews) {
    for (const entry of extractPassivePreviewEntries(preview)) {
      if (entry.kind !== "payload") {
        continue;
      }
      const metadata = parsePassiveCandidateMetadata(entry.preview);
      if (
        metadata &&
        metadata.payload &&
        (!bestMetadata ||
          metadata.timestampMs > bestMetadata.timestampMs ||
          (metadata.timestampMs === bestMetadata.timestampMs && metadata.sequence > bestMetadata.sequence))
      ) {
        bestMetadata = metadata;
      }
    }
  }

  if (bestMetadata) {
    return bestMetadata;
  }

  return parsePassiveCandidateMetadata(previews.find(Boolean) || "");
}

function getPassiveCandidateSourceWeight(eventType, source) {
  if (String(eventType || "").toLowerCase() === "lfg_status") {
    return 3;
  }

  switch (String(source || "").toLowerCase()) {
    case "unit":
    case "world":
    case "chat-link":
    case "chatlink":
    case "manual":
      return 6;
    case "applicant":
      return 5;
    case "self":
      return 4;
    case "appclear":
      return 1;
    default:
      return source ? 3 : 0;
  }
}

function comparePassiveCandidates(left, right) {
  return (
    right.channelMatch - left.channelMatch ||
    right.sessionMatch - left.sessionMatch ||
    right.timestampMs - left.timestampMs ||
    right.sequence - left.sequence ||
    right.sourceWeight - left.sourceWeight ||
    right.versionWeight - left.versionWeight ||
    right.priority - left.priority ||
    right.numericAddress - left.numericAddress
  );
}

function selectPassiveRegionCandidates(scanResult, options = {}) {
  const matches = Array.isArray(scanResult && scanResult.matches) ? scanResult.matches : [];
  const preferredChannelName = normalizePassiveDiscoveryToken(options.preferredChannelName);
  const preferredSessionId = String(options.preferredSessionId || "").trim();
  const regionCandidates = new Map();

  for (const match of matches) {
    const preview = String(match.previewUtf8 || match.previewUtf16 || "");
    const normalizedPreview = normalizeAddonTransportText(preview);
    const metadata = parseBestPassiveCandidateMetadata([match.previewUtf8 || "", match.previewUtf16 || ""]);
    const numericAddress = Number.parseInt(String(match.address || "").replace(/^0x/iu, ""), 16);
    const numericRegionBase = Number.parseInt(String(match.regionBase || "").replace(/^0x/iu, ""), 16);
    const regionSize = Number.parseInt(String(match.regionSize || ""), 10);

    if (!Number.isFinite(numericAddress) || numericAddress <= 0 || !Number.isFinite(numericRegionBase) || numericRegionBase <= 0) {
      continue;
    }
    if (!Number.isFinite(regionSize) || regionSize <= 0) {
      continue;
    }

    let priority = 0;
    if (normalizedPreview.includes("]:")) {
      priority += 3;
    }
    if (normalizedPreview.includes("LNNRANK|")) {
      priority += 2;
    }
    if (normalizedPreview.includes("lnnrank")) {
      priority += 1;
    }
    if (normalizedPreview.includes("|v=2|")) {
      priority += 2;
    }

    const candidate = {
      regionBase: `0x${numericRegionBase.toString(16).toUpperCase("en-US")}`,
      regionSize,
      numericAddress,
      priority,
      sourceWeight: getPassiveCandidateSourceWeight(metadata.eventType, metadata.source),
      timestampMs: metadata.timestampMs,
      sequence: metadata.sequence,
      versionWeight: normalizedPreview.includes("|v=2|") ? 1 : 0,
      channelMatch:
        preferredChannelName &&
        normalizePassiveDiscoveryToken(metadata.channelName || "") === preferredChannelName
          ? 1
          : 0,
      sessionMatch: preferredSessionId && metadata.sessionId === preferredSessionId ? 1 : 0,
    };
    const regionKey = `${candidate.regionBase}:${candidate.regionSize}`;
    const existing = regionCandidates.get(regionKey);
    if (!existing || comparePassiveCandidates(existing, candidate) > 0) {
      regionCandidates.set(regionKey, candidate);
    }
  }

  return [...regionCandidates.values()]
    .sort(comparePassiveCandidates)
    .slice(0, LIVE_REGION_LIMIT)
    .map((entry) => ({
      regionBase: entry.regionBase,
      regionSize: entry.regionSize,
    }));
}

function selectPassiveAddressCandidates(scanResult) {
  const matches = Array.isArray(scanResult && scanResult.matches) ? scanResult.matches : [];
  return matches
    .map((match) => {
      const preview = String(match.previewUtf8 || match.previewUtf16 || "");
      const normalizedPreview = normalizeAddonTransportText(preview);
      const metadata = parseBestPassiveCandidateMetadata([match.previewUtf8 || "", match.previewUtf16 || ""]);
      let priority = 0;
      if (normalizedPreview.includes("]:")) {
        priority += 3;
      }
      if (normalizedPreview.includes("LNNRANK|")) {
        priority += 2;
      }
      if (normalizedPreview.includes("lnnrank")) {
        priority += 1;
      }

      return {
        address: match.address,
        numericAddress: Number.parseInt(String(match.address || "").replace(/^0x/iu, ""), 16),
        priority,
        sourceWeight: getPassiveCandidateSourceWeight(metadata.eventType, metadata.source),
        channelMatch: 0,
        sessionMatch: 0,
        versionWeight: normalizedPreview.includes("|v=2|") ? 1 : 0,
        timestampMs: metadata.timestampMs,
        sequence: metadata.sequence,
      };
    })
    .filter((entry) => Number.isFinite(entry.numericAddress) && entry.numericAddress > 0)
    .sort(comparePassiveCandidates)
    .slice(0, 24)
    .map((entry) => `0x${entry.numericAddress.toString(16).toUpperCase("en-US")}`);
}

function normalizePassiveDiscoveryToken(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/gu, "");
}

function createPassivePayloadCursor(timestampMs = 0, sequence = 0) {
  return {
    timestampMs: Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : 0,
    sequence: Number.isFinite(Number(sequence)) ? Number(sequence) : 0,
  };
}

function comparePassivePayloadCursor(left, right) {
  const leftTimestampMs = Number((left && left.timestampMs) || 0);
  const rightTimestampMs = Number((right && right.timestampMs) || 0);
  if (leftTimestampMs !== rightTimestampMs) {
    return leftTimestampMs - rightTimestampMs;
  }

  const leftSequence = Number((left && left.sequence) || 0);
  const rightSequence = Number((right && right.sequence) || 0);
  return leftSequence - rightSequence;
}

function maxPassivePayloadCursor(left, right) {
  return comparePassivePayloadCursor(left, right) >= 0 ? left : right;
}

function buildPassiveDiscoveryPattern(passiveBridge) {
  const channelName = normalizePassiveDiscoveryToken(passiveBridge && passiveBridge.channelName);
  const playerKey = normalizePassiveDiscoveryToken(passiveBridge && passiveBridge.playerKey);

  if (channelName) {
    return `|ch=${channelName}|`;
  }

  if (playerKey.length >= 6) {
    return `|ch=lnnrank${playerKey}|`;
  }

  return null;
}

function buildPassiveDiscoveryPools(passiveBridge, observedSessionId = null) {
  const channelName =
    passiveBridge && passiveBridge.enabled && passiveBridge.channelName
      ? String(passiveBridge.channelName).trim()
      : "";
  const sessionId = String(observedSessionId || "").trim();
  const pools = [];
  const genericPattern = passiveBridge && passiveBridge.enabled ? buildPassiveDiscoveryPattern(passiveBridge) : null;
  if (genericPattern) {
    pools.push({
      key: "generic",
      pattern: genericPattern,
      regionLimit: LIVE_REGION_LIMIT,
      preferredChannelName: channelName || null,
      preferredSessionId: sessionId || null,
    });
  }

  return pools;
}

function mergeDiscoveryRegions(existingRegions, nextRegions, limit) {
  const merged = new Map();
  for (const region of [...(nextRegions || []), ...(existingRegions || [])]) {
    if (!region || !region.regionBase || !region.regionSize) {
      continue;
    }
    merged.set(`${region.regionBase}:${region.regionSize}`, {
      regionBase: region.regionBase,
      regionSize: region.regionSize,
    });
  }
  return [...merged.values()].slice(0, Math.max(1, limit || LIVE_REGION_LIMIT));
}

function flattenDiscoveryRegions(discoveryPools) {
  const merged = new Map();
  for (const pool of Object.values(discoveryPools || {})) {
    for (const region of pool && Array.isArray(pool.regions) ? pool.regions : []) {
      if (!region || !region.regionBase || !region.regionSize) {
        continue;
      }
      merged.set(`${region.regionBase}:${region.regionSize}`, region);
    }
  }
  return [...merged.values()];
}

function createPassiveLiveFeedMonitor(options = {}) {
  const scanIntervalMs = Math.max(
    250,
    Number.parseInt(String(options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS), 10) || DEFAULT_SCAN_INTERVAL_MS
  );
  const discoveryRefreshMs = Math.max(
    scanIntervalMs * 2,
    Number.parseInt(String(options.discoveryRefreshMs || DEFAULT_DISCOVERY_REFRESH_MS), 10) ||
      DEFAULT_DISCOVERY_REFRESH_MS
  );
  const state = {
    supported: process.platform === "win32",
    status: "idle",
    channelName: null,
    sessionId: null,
    activeSessionId: null,
    discoveryPattern: null,
    wowProcessId: null,
    lastScannedAt: null,
    lastDiscoveredAt: null,
    lastError: null,
    scanDurationMs: null,
    discoveryPools: {},
    entries: [],
    events: [],
    readCursor: createPassivePayloadCursor(),
    baselineAtMs: Date.now(),
  };

  function resetForChannel(channelName) {
    state.channelName = channelName || null;
    state.sessionId = null;
    state.activeSessionId = null;
    state.discoveryPattern = null;
    state.wowProcessId = null;
    state.lastScannedAt = null;
    state.lastDiscoveredAt = null;
    state.lastError = null;
    state.scanDurationMs = null;
    state.discoveryPools = {};
    state.entries = [];
    state.events = [];
    state.readCursor = createPassivePayloadCursor();
    state.baselineAtMs = Date.now();
    state.status = channelName ? "idle" : "waiting";
  }

  function mergeEntries(nextEntries, observedAtIso) {
    const observedAtMs = Date.parse(observedAtIso) || Date.now();
    const merged = new Map(state.entries.map((entry) => [entry.key, entry]));
    const newEvents = [];
    let nextReadCursor = state.readCursor;
    const expectedChannelName = normalizePassiveDiscoveryToken(state.channelName);
    const orderedEntries = [...nextEntries]
      .map((entry) => {
        const payloadMetadata =
          entry.kind === "payload" && typeof entry.preview === "string"
            ? parsePassiveCandidateMetadata(entry.preview)
            : null;
        const payloadCursor = payloadMetadata
          ? createPassivePayloadCursor(payloadMetadata.timestampMs, payloadMetadata.sequence)
          : null;
        return {
          entry,
          payloadMetadata,
          payloadCursor,
        };
      })
      .filter(({ entry, payloadMetadata }) => {
        if (entry.kind !== "payload") {
          return true;
        }
        if (!payloadMetadata || !payloadMetadata.payload) {
          return false;
        }
        return (
          !expectedChannelName ||
          normalizePassiveDiscoveryToken(payloadMetadata.channelName || "") === expectedChannelName
        );
      })
      .sort((left, right) => {
        if (left.payloadCursor && right.payloadCursor) {
          return comparePassivePayloadCursor(left.payloadCursor, right.payloadCursor);
        }
        if (left.payloadCursor) {
          return -1;
        }
        if (right.payloadCursor) {
          return 1;
        }
        return String(left.entry.key || "").localeCompare(String(right.entry.key || ""), "en-US");
      });

    for (const { entry, payloadMetadata, payloadCursor } of orderedEntries) {
      const payloadTimestampMs =
        entry.kind === "payload" && typeof entry.preview === "string" ? extractPayloadTimestampMs(entry.preview) : null;

      const eventAtIso =
        payloadTimestampMs != null && payloadTimestampMs > 0 ? new Date(payloadTimestampMs).toISOString() : observedAtIso;
      const isPreBaselinePayload =
        payloadCursor &&
        Number(payloadCursor.timestampMs || 0) > 0 &&
        Number(payloadCursor.timestampMs || 0) < state.baselineAtMs - scanIntervalMs;
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
      if (
        payloadCursor &&
        !isPreBaselinePayload &&
        comparePassivePayloadCursor(payloadCursor, nextReadCursor) > 0
      ) {
        const delayMs =
          payloadTimestampMs != null && payloadTimestampMs > 0 ? Math.max(0, observedAtMs - payloadTimestampMs) : null;
        newEvents.push({
          ...entry,
          eventAt: eventAtIso,
          receivedAt: observedAtIso,
          receivedAtMs: observedAtMs,
          delayMs,
        });
      }
      if (payloadCursor) {
        nextReadCursor = maxPassivePayloadCursor(nextReadCursor, payloadCursor);
      }
    }

    state.entries = [...merged.values()]
      .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""), "en-US"))
      .slice(0, LIVE_ENTRY_LIMIT);
    if (newEvents.length > 0) {
      state.events = [...state.events, ...newEvents]
        .sort((left, right) => String(left.eventAt || "").localeCompare(String(right.eventAt || ""), "en-US"))
        .slice(-LIVE_EVENT_LIMIT);
    }
    state.readCursor = nextReadCursor;

    const latestSession = [...state.entries]
      .map((entry) => parsePassiveCandidateMetadata(entry.preview))
      .filter((metadata) => metadata && metadata.sessionId)
      .sort((left, right) => right.timestampMs - left.timestampMs || right.sequence - left.sequence)[0];
    if (latestSession && latestSession.sessionId) {
      state.activeSessionId = latestSession.sessionId;
    }
  }

  function snapshot() {
    return {
      supported: state.supported,
      status: state.status,
      channelName: state.channelName,
      sessionId: state.activeSessionId || state.sessionId,
      discoveryPattern: state.discoveryPattern,
      wowProcessId: state.wowProcessId,
      lastScannedAt: state.lastScannedAt,
      lastError: state.lastError,
      scanDurationMs: state.scanDurationMs,
      discoveryRegions: flattenDiscoveryRegions(state.discoveryPools),
      discoveryPools: Object.fromEntries(
        Object.entries(state.discoveryPools).map(([key, pool]) => [
          key,
          {
            pattern: pool.pattern,
            regions: pool.regions,
            lastScannedAt: pool.lastScannedAt,
            lastDiscoveredAt: pool.lastDiscoveredAt,
            lastError: pool.lastError,
            scanDurationMs: pool.scanDurationMs,
          },
        ])
      ),
      entries: state.entries,
      entryCount: state.entries.length,
      events: state.events,
      eventCount: state.events.length,
      readCursor: {
        timestampMs: Number(state.readCursor && state.readCursor.timestampMs || 0),
        sequence: Number(state.readCursor && state.readCursor.sequence || 0),
      },
    };
  }

  function clearLog(cursor = null) {
    if (cursor && typeof cursor === "object") {
      state.readCursor = maxPassivePayloadCursor(
        state.readCursor,
        createPassivePayloadCursor(cursor.timestampMs, cursor.sequence)
      );
    }
    state.events = [];
  }

  function recomputeDerivedState() {
    const discoveryPools = Object.values(state.discoveryPools || {});
    const scannedAtValues = discoveryPools
      .map((pool) => Date.parse(pool.lastScannedAt || ""))
      .filter((value) => Number.isFinite(value));
    const discoveredAtValues = discoveryPools
      .map((pool) => Date.parse(pool.lastDiscoveredAt || ""))
      .filter((value) => Number.isFinite(value));
    const scanDurationValues = discoveryPools
      .map((pool) => Number(pool.scanDurationMs || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    const lastError = discoveryPools.map((pool) => pool.lastError).find(Boolean) || null;
    const hasActiveScan = discoveryPools.some((pool) => pool.currentPromise);
    const hasEntries = state.entries.length > 0;

    state.lastScannedAt =
      scannedAtValues.length > 0 ? new Date(Math.max(...scannedAtValues)).toISOString() : state.lastScannedAt;
    state.lastDiscoveredAt =
      discoveredAtValues.length > 0 ? new Date(Math.max(...discoveredAtValues)).toISOString() : state.lastDiscoveredAt;
    state.scanDurationMs = scanDurationValues.length > 0 ? Math.max(...scanDurationValues) : state.scanDurationMs;
    state.lastError = lastError;

    if (!state.channelName || !(state.discoveryPattern || "").trim()) {
      state.status = "waiting";
    } else if (hasActiveScan) {
      state.status = "scanning";
    } else if (lastError && !hasEntries) {
      state.status = "error";
    } else {
      state.status = "ready";
    }
  }

  function ensurePoolState(spec) {
    const existing = state.discoveryPools[spec.key];
    if (
      existing &&
      existing.pattern === spec.pattern &&
      existing.regionLimit === spec.regionLimit &&
      existing.preferredChannelName === spec.preferredChannelName &&
      existing.preferredSessionId === spec.preferredSessionId
    ) {
      return existing;
    }

    const nextPool = {
      key: spec.key,
      pattern: spec.pattern,
      regionLimit: spec.regionLimit,
      preferredChannelName: spec.preferredChannelName,
      preferredSessionId: spec.preferredSessionId,
      regions: [],
      lastScannedAt: null,
      lastDiscoveredAt: null,
      lastError: null,
      scanDurationMs: null,
      consecutiveMisses: 0,
      currentPromise: null,
      discoveryPromise: null,
    };
    state.discoveryPools[spec.key] = nextPool;
    return nextPool;
  }

  function applyDiscoveryResult(pool, result, observedAtIso) {
    const nextEntries = extractPassiveLiveFeedEntries(result);
    mergeEntries(nextEntries, observedAtIso);
    const selectedRegions = selectPassiveRegionCandidates(result, {
      preferredChannelName: pool.preferredChannelName,
      preferredSessionId: pool.preferredSessionId,
    });
    pool.regions = mergeDiscoveryRegions(pool.regions, selectedRegions, pool.regionLimit);
    pool.lastDiscoveredAt = observedAtIso;
    pool.consecutiveMisses = 0;
  }

  function startBackgroundDiscovery(pool, wowProcessId, discoveryMaxMatches) {
    if (pool.discoveryPromise) {
      return;
    }

    pool.discoveryPromise = (async () => {
      const result = await discoverPassiveChannelMemory({
        processId: wowProcessId,
        channelName: pool.pattern,
        maxMatches: discoveryMaxMatches,
        contextBytes: options.contextBytes || DEFAULT_CONTEXT_BYTES,
      });
      const observedAtIso = new Date().toISOString();
      applyDiscoveryResult(pool, result, observedAtIso);
      pool.scanDurationMs = Math.max(Number(pool.scanDurationMs || 0), Number(result && result.durationMs) || 0);
      pool.lastScannedAt = observedAtIso;
      recomputeDerivedState();
    })()
      .catch((error) => {
        pool.lastError = error.message || "Passive live feed discovery failed.";
      })
      .finally(() => {
        pool.discoveryPromise = null;
        recomputeDerivedState();
      });
  }

  async function refreshPool(pool, wowProcessId) {
    const scanStartedAt = Date.now();
    pool.lastError = null;
    const discoveryMaxMatches = Math.max(
      1,
      Number.parseInt(
        String(options.discoveryMaxMatches || options.maxMatches || DEFAULT_DISCOVERY_MAX_MATCHES),
        10
      ) || DEFAULT_DISCOVERY_MAX_MATCHES
    );
    const regionMaxMatches = Math.max(
      discoveryMaxMatches,
      Number.parseInt(String(options.regionMaxMatches || DEFAULT_REGION_MAX_MATCHES), 10) || DEFAULT_REGION_MAX_MATCHES
    );
    const lastDiscoveryMs = Date.parse(pool.lastDiscoveredAt || "");
    const shouldRediscover =
      !Array.isArray(pool.regions) ||
      pool.regions.length === 0 ||
      !Number.isFinite(lastDiscoveryMs) ||
      Date.now() - lastDiscoveryMs >= discoveryRefreshMs;

    if (!Array.isArray(pool.regions) || pool.regions.length === 0) {
      const result = await discoverPassiveChannelMemory({
        processId: wowProcessId,
        channelName: pool.pattern,
        maxMatches: discoveryMaxMatches,
        contextBytes: options.contextBytes || DEFAULT_CONTEXT_BYTES,
      });
      const observedAtIso = new Date().toISOString();
      applyDiscoveryResult(pool, result, observedAtIso);
      pool.lastScannedAt = observedAtIso;
      pool.scanDurationMs = Number(result && result.durationMs) || Date.now() - scanStartedAt;
      recomputeDerivedState();
      return;
    }

    const result = await scanPassiveMemoryRegions({
      processId: wowProcessId,
      regions: pool.regions,
      pattern: "LNNRANK",
      maxMatches: regionMaxMatches,
      contextBytes: options.contextBytes || DEFAULT_CONTEXT_BYTES,
    });
    const observedAtIso = new Date().toISOString();
    const nextEntries = extractPassiveLiveFeedEntries(result);
    mergeEntries(nextEntries, observedAtIso);
    if (nextEntries.some((entry) => entry.kind === "payload")) {
      pool.consecutiveMisses = 0;
    } else {
      pool.consecutiveMisses += 1;
    }
    pool.lastScannedAt = observedAtIso;
    pool.scanDurationMs = Number(result && result.durationMs) || Date.now() - scanStartedAt;
    if (shouldRediscover) {
      startBackgroundDiscovery(pool, wowProcessId, discoveryMaxMatches);
    }
    recomputeDerivedState();
  }

  async function refresh(passiveBridge) {
    const channelName =
      passiveBridge && passiveBridge.enabled && passiveBridge.channelName
        ? String(passiveBridge.channelName).trim()
        : "";
    const sessionId =
      passiveBridge && passiveBridge.enabled && passiveBridge.sessionId ? String(passiveBridge.sessionId).trim() : "";
    const poolSpecs =
      passiveBridge && passiveBridge.enabled
        ? buildPassiveDiscoveryPools(passiveBridge, state.activeSessionId || null)
        : [];
    const discoveryPattern = poolSpecs.map((spec) => `${spec.key}:${spec.pattern}`).join(" || ") || null;

    if (!state.supported) {
      state.status = "unsupported";
      return;
    }

    if (!channelName || !discoveryPattern) {
      resetForChannel(null);
      return;
    }

    if (state.channelName !== channelName) {
      resetForChannel(channelName);
      state.sessionId = sessionId || null;
      state.discoveryPattern = discoveryPattern;
    } else {
      state.sessionId = sessionId || null;
      state.discoveryPattern = discoveryPattern;
    }

    const expectedKeys = new Set(poolSpecs.map((spec) => spec.key));
    for (const key of Object.keys(state.discoveryPools)) {
      if (!expectedKeys.has(key) && !state.discoveryPools[key].currentPromise) {
        delete state.discoveryPools[key];
      }
    }

    const duePools = [];
    for (const spec of poolSpecs) {
      const pool = ensurePoolState(spec);
      if (pool.currentPromise) {
        continue;
      }

      const lastScanMs = Date.parse(pool.lastScannedAt || "");
      const activeIntervalMs = scanIntervalMs;
      if (Number.isFinite(lastScanMs) && Date.now() - lastScanMs < activeIntervalMs) {
        continue;
      }
      duePools.push(pool);
    }

    if (duePools.length <= 0) {
      recomputeDerivedState();
      return null;
    }

    state.status = "scanning";
    state.lastError = null;
    const run = (async () => {
      const wowProcess = await detectWowProcess();
      if (!wowProcess) {
        state.wowProcessId = null;
        for (const pool of duePools) {
          pool.lastError = "WoW process not found.";
          pool.lastScannedAt = new Date().toISOString();
          pool.scanDurationMs = 0;
        }
        recomputeDerivedState();
        return;
      }

      state.wowProcessId = wowProcess.processId;
      await Promise.all(
        duePools.map((pool) => {
          const task = refreshPool(pool, wowProcess.processId)
            .catch((error) => {
              pool.lastError = error.message || "Passive live feed scan failed.";
              pool.lastScannedAt = new Date().toISOString();
              pool.scanDurationMs = 0;
            })
            .finally(() => {
              pool.currentPromise = null;
              recomputeDerivedState();
            });
          pool.currentPromise = task;
          return task;
        })
      );
    })();

    return run;
  }

  return {
    clearLog,
    refresh,
    snapshot,
  };
}

module.exports = {
  buildPassiveDiscoveryPattern,
  buildPassiveDiscoveryPools,
  createPassiveLiveFeedMonitor,
  extractCanonicalPayload,
  extractPassiveLiveFeedEntries,
  normalizePassivePreview,
  selectPassiveRegionCandidates,
  selectPassiveAddressCandidates,
};
