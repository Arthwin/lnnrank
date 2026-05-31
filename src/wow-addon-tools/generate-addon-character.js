"use strict";

require("dotenv").config();

const path = require("node:path");

const { parseCommandLine } = require("../mplus-matrix/config");
const { normalizeText } = require("../mplus-matrix/normalization");
const { formatIsoTimestamp } = require("../mplus-matrix/utils");
const {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_WOW_ADDONS_DIR,
  buildCompanionPayload,
  installStagedAddons,
  stageAddonBundle,
} = require("./lnnrank-bridge");
const {
  API_ATTEMPT_COOLDOWN_MS,
  DEFAULT_CACHE_PATH,
  ProviderCooldownError,
  getCachedRecord,
  getFreshCachedRecord,
  getProviderCooldown,
  loadCache,
  markProviderAttempt,
  saveCache,
  upsertCachedRecord,
} = require("./cache");
const {
  DEFAULT_LOOKUP_PROVIDER,
  WclRateLimitError,
  fetchSingleCharacterViaApi,
  fetchSingleCharacterViaWeb,
  hasApiCredentials,
  recordNeedsWebEnrichment,
  resolveLookupProvider,
} = require("./live-provider");

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node src/wow-addon-tools/generate-addon-character.js --region us --realm Stormrage --name Urmomgargles",
      "  node src/wow-addon-tools/generate-addon-character.js us Stormrage Urmomgargles",
      "",
      "Optional flags:",
      "  --output-dir <path>",
      "  --addons-dir <path>",
      "  --db-path <path>",
      "  --cache-path <path> (legacy alias)",
      `  --provider <web|api|off> (default: ${DEFAULT_LOOKUP_PROVIDER})`,
      "  --browser-path <path>",
      "  --force-refresh",
      "  --install-wow",
      "",
    ].join("\n")
  );
}

async function main() {
  const { positionals, options } = parseCommandLine(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const region = normalizeText(options.region || positionals[0] || "us").toLocaleLowerCase("en-US");
  const realm = normalizeText(options.realm || positionals[1]);
  const name = normalizeText(options.name || positionals[2]);

  if (!realm || !name) {
    printUsage();
    throw new Error("Both --realm and --name are required.");
  }

  const outputDir = options["output-dir"]
    ? path.resolve(String(options["output-dir"]))
    : DEFAULT_OUTPUT_DIR;
  const cachePath = options["db-path"]
    ? path.resolve(String(options["db-path"]))
    : options["cache-path"]
      ? path.resolve(String(options["cache-path"]))
    : DEFAULT_CACHE_PATH;
  const addonsDir = options["addons-dir"]
    ? path.resolve(String(options["addons-dir"]))
    : DEFAULT_WOW_ADDONS_DIR;
  const provider = resolveLookupProvider(options.provider);
  const browserPath = options["browser-path"] ? path.resolve(String(options["browser-path"])) : null;
  const forceRefresh = options["force-refresh"] === true;
  const cache = loadCache(cachePath);
  const freshCachedRecord = forceRefresh ? null : getFreshCachedRecord(cache, { region, realm, name });
  const cachedRecord =
    freshCachedRecord && !recordNeedsWebEnrichment(freshCachedRecord) ? freshCachedRecord : null;

  let record = cachedRecord;
  let rateLimit = null;
  let source = cachedRecord ? "cache" : provider === "web" ? "warcraftlogs-web" : "warcraftlogs-api";
  let providerCooldown = null;

  if (!record) {
    try {
      if (provider === "off") {
        throw new Error("Live lookups are disabled for this run.");
      }
      if (provider === "api") {
        providerCooldown = getProviderCooldown(cache, "api");
        if (providerCooldown.isCoolingDown) {
          throw new ProviderCooldownError("api", providerCooldown);
        }
        providerCooldown = markProviderAttempt(cache, "api", {
          cooldownMs: API_ATTEMPT_COOLDOWN_MS,
        });
        saveCache(cache, cachePath);
      }

      const result =
        provider === "web"
          ? await fetchSingleCharacterViaWeb({ region, realm, name, browserPath })
          : provider === "auto"
            ? hasApiCredentials()
              ? await (async () => {
                  const apiResult = await fetchSingleCharacterViaApi({ region, realm, name });
                  if (apiResult.found && apiResult.record && recordNeedsWebEnrichment(apiResult.record)) {
                    try {
                      return {
                        ...(await fetchSingleCharacterViaWeb({ region, realm, name, browserPath })),
                        fallbackFrom: "api",
                        fallbackReason: "API result was incomplete and was enriched from the web page.",
                      };
                    } catch {
                      return apiResult;
                    }
                  }
                  return apiResult;
                })()
              : await fetchSingleCharacterViaWeb({ region, realm, name, browserPath })
            : await fetchSingleCharacterViaApi({ region, realm, name });
      if (!result.found || !result.record) {
        throw new Error(`Warcraft Logs did not return a character for ${region}/${realm}/${name}.`);
      }
      record = result.record;
      rateLimit = result.rateLimit || null;
      upsertCachedRecord(cache, record);
      record = getCachedRecord(cache, { region, realm, name }) || record;
      saveCache(cache, cachePath);
    } catch (error) {
      const staleRecord = getCachedRecord(cache, { region, realm, name });
      if ((error instanceof WclRateLimitError || error instanceof ProviderCooldownError || provider !== "api") && staleRecord) {
        record = staleRecord;
        source = "stale-cache";
      } else if (provider === "off") {
        throw new Error("Live lookups are disabled and no fresh cache entry is available.");
      } else {
        throw error;
      }
    }
  }

  const payload = buildCompanionPayload([record], {
    builtAt: formatIsoTimestamp(),
    source,
    rateLimit,
  });
  const staged = stageAddonBundle(outputDir, payload);

  let installed = null;
  if (options["install-wow"]) {
    installed = installStagedAddons(staged, addonsDir);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        region,
        realm: record.realm,
        name: record.name,
        score: record.score,
        dungeons: record.dungeons.length,
        provider,
        source,
        dbPath: cachePath,
        cachePath,
        providerCooldown,
        staged,
        installed,
        rateLimit,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
