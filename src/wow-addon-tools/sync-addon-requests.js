"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const { parseCommandLine } = require("../mplus-matrix/config");
const { DEFAULT_LOOKUP_PROVIDER } = require("./live-provider");
const { DEFAULT_WOW_ACCOUNT_ROOT, pickLatestSavedVariablesFile } = require("./saved-variables");
const { runAddonRequestSync } = require("./sync-service");

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node src/wow-addon-tools/sync-addon-requests.js --install-wow",
      "",
      "Optional flags:",
      "  --saved-variables-file <path>",
      "  --wow-account-root <path>",
      "  --db-path <path>",
      "  --cache-path <path> (legacy alias)",
      "  --output-dir <path>",
      "  --addons-dir <path>",
      `  --provider <auto|web|api|off> (default: ${DEFAULT_LOOKUP_PROVIDER})`,
      "  --browser-path <path>",
      "  --max-requests <number>",
      "  --workers <number>",
      "  --install-wow",
      "",
    ].join("\n")
  );
}

function pickSavedVariablesFile(options) {
  if (options["saved-variables-file"]) {
    return path.resolve(String(options["saved-variables-file"]));
  }

  const accountRoot = options["wow-account-root"]
    ? path.resolve(String(options["wow-account-root"]))
    : DEFAULT_WOW_ACCOUNT_ROOT;
  const latest = pickLatestSavedVariablesFile(accountRoot);
  return latest ? latest.path : null;
}

async function main() {
  const { options } = parseCommandLine(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const savedVariablesFile = pickSavedVariablesFile(options);
  if (savedVariablesFile && !fs.existsSync(savedVariablesFile)) {
    throw new Error(`SavedVariables file does not exist: ${savedVariablesFile}`);
  }

  const result = await runAddonRequestSync({
    savedVariablesFile,
    dbPath: options["db-path"] || options["cache-path"] || null,
    outputDir: options["output-dir"] || null,
    addonsDir: options["addons-dir"] || null,
    provider: options.provider,
    browserPath: options["browser-path"] || null,
    maxRequests: options["max-requests"] || null,
    workers: options.workers || null,
    installWow: options["install-wow"] === true,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
