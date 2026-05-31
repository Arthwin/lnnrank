"use strict";

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const { parseCommandLine } = require("../mplus-matrix/config");
const { createEmptyCache, saveCache } = require("./cache");
const { createDashboardServer } = require("./dashboard-server");
const { renderEmptySavedVariablesFile } = require("./saved-variables");

const DEFAULT_DEV_PORT = Number.parseInt(process.env.WCL_DASHBOARD_DEV_PORT || "47842", 10);
const DEFAULT_DEV_ROOT = path.join(process.cwd(), "output", "dev-run");
const DEFAULT_DEV_ACCOUNT = "DEVACCOUNT";

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node src/wow-addon-tools/dev-run.js",
      "",
      "Optional flags:",
      `  --port <number> (default: ${DEFAULT_DEV_PORT})`,
      `  --dev-root <path> (default: ${DEFAULT_DEV_ROOT})`,
      "  --provider <web|api|auto|off>",
      "  --copy-saved-variables <path>",
      "  --copy-db <path>",
      "  --reset-state",
      "",
      "This command keeps the dashboard sandboxed inside the repo worktree and",
      "never writes to the live WoW AddOns or WTF folders unless you explicitly",
      "point it there with custom paths.",
      "",
    ].join("\n")
  );
}

function buildDevRuntimePaths(runtimeRoot) {
  const resolvedRoot = path.resolve(String(runtimeRoot || DEFAULT_DEV_ROOT));
  return {
    runtimeRoot: resolvedRoot,
    dbPath: path.join(resolvedRoot, "db", "lnnrank-db.json"),
    outputDir: path.join(resolvedRoot, "staged-addons"),
    addonsDir: path.join(resolvedRoot, "wow", "Interface", "AddOns"),
    accountRoot: path.join(resolvedRoot, "wow", "WTF", "Account"),
    savedVariablesFile: path.join(
      resolvedRoot,
      "wow",
      "WTF",
      "Account",
      DEFAULT_DEV_ACCOUNT,
      "SavedVariables",
      "lnnrank.lua"
    ),
  };
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyFileIfRequested(sourcePath, targetPath) {
  if (!sourcePath) {
    return false;
  }

  const resolvedSource = path.resolve(String(sourcePath));
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Seed file does not exist: ${resolvedSource}`);
  }

  ensureParentDirectory(targetPath);
  fs.copyFileSync(resolvedSource, targetPath);
  return true;
}

function ensureDevRuntime(paths, options = {}) {
  if (options.resetState === true) {
    fs.rmSync(paths.runtimeRoot, { recursive: true, force: true });
  }

  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.mkdirSync(paths.addonsDir, { recursive: true });
  fs.mkdirSync(paths.accountRoot, { recursive: true });

  const copiedSavedVariables = copyFileIfRequested(options.copySavedVariables, paths.savedVariablesFile);
  if (!copiedSavedVariables && !fs.existsSync(paths.savedVariablesFile)) {
    ensureParentDirectory(paths.savedVariablesFile);
    fs.writeFileSync(paths.savedVariablesFile, renderEmptySavedVariablesFile(), "utf8");
  }

  const copiedDb = copyFileIfRequested(options.copyDb, paths.dbPath);
  if (!copiedDb && !fs.existsSync(paths.dbPath)) {
    saveCache(createEmptyCache(), paths.dbPath);
  }

  return paths;
}

async function main() {
  const { options } = parseCommandLine(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const runtimePaths = ensureDevRuntime(
    buildDevRuntimePaths(options["dev-root"] || DEFAULT_DEV_ROOT),
    {
      resetState: options["reset-state"] === true,
      copySavedVariables: options["copy-saved-variables"] || null,
      copyDb: options["copy-db"] || null,
    }
  );

  const port =
    options.port == null
      ? DEFAULT_DEV_PORT
      : Number.parseInt(String(options.port), 10);
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }

  const provider = options.provider || process.env.WCL_LOOKUP_PROVIDER || null;
  const server = await createDashboardServer({
    dbPath: runtimePaths.dbPath,
    accountRoot: runtimePaths.accountRoot,
    outputDir: runtimePaths.outputDir,
    addonsDir: runtimePaths.addonsDir,
    provider,
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const listeningPort =
      address && typeof address === "object" && address.port != null ? address.port : port;
    process.stdout.write(
      [
        `LNNRank dev dashboard listening on http://127.0.0.1:${listeningPort}`,
        `Sandbox root: ${runtimePaths.runtimeRoot}`,
        `Sandbox DB: ${runtimePaths.dbPath}`,
        `Sandbox SavedVariables: ${runtimePaths.savedVariablesFile}`,
        `Sandbox staged addons: ${runtimePaths.outputDir}`,
        `Sandbox installed addons: ${runtimePaths.addonsDir}`,
        `Lookup provider: ${provider || process.env.WCL_LOOKUP_PROVIDER || "default"}`,
        "",
      ].join("\n")
    );
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_DEV_PORT,
  buildDevRuntimePaths,
  ensureDevRuntime,
};
