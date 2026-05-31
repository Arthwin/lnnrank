"use strict";

require("dotenv").config();

const path = require("node:path");

const { parseCommandLine } = require("../mplus-matrix/config");
const { normalizeText } = require("../mplus-matrix/normalization");
const { formatIsoTimestamp } = require("../mplus-matrix/utils");
const {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_WOW_ADDONS_DIR,
  buildCharacterRecord,
  buildCompanionPayload,
  installStagedAddons,
  stageAddonBundle,
} = require("./lnnrank-bridge");
const {
  DEFAULT_WOW_WTF_ACCOUNT_DIR,
  createMockCharacterInput,
  findLatestWowCharacter,
} = require("./mock-data");

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node src/wow-addon-tools/generate-addon-mock.js --region us --realm Stormrage --name Urmomgargles",
      "  node src/wow-addon-tools/generate-addon-mock.js us Stormrage Urmomgargles",
      "  node src/wow-addon-tools/generate-addon-mock.js --install-wow",
      "",
      "Optional flags:",
      "  --region <slug>",
      "  --realm <name>",
      "  --name <character>",
      "  --score <number>",
      "  --output-dir <path>",
      "  --addons-dir <path>",
      "  --wow-wtf-account-dir <path>",
      "  --install-wow",
      "",
      "If --realm/--name are omitted, the script uses the most recently modified character",
      "directory in the local WoW WTF account folder.",
      "",
    ].join("\n")
  );
}

function resolveCharacterInput(options) {
  const explicitRealm = normalizeText(options.realm);
  const explicitName = normalizeText(options.name);

  if (explicitRealm && explicitName) {
    return {
      region: normalizeText(options.region || "us").toLocaleLowerCase("en-US"),
      realm: explicitRealm,
      name: explicitName,
      source: "explicit",
      detectedPath: null,
    };
  }

  const accountRootDir = options["wow-wtf-account-dir"]
    ? path.resolve(String(options["wow-wtf-account-dir"]))
    : DEFAULT_WOW_WTF_ACCOUNT_DIR;
  const latestCharacter = findLatestWowCharacter(accountRootDir);
  if (!latestCharacter) {
    throw new Error(
      `Could not auto-detect a WoW character under ${accountRootDir}. Pass --realm and --name explicitly.`
    );
  }

  return {
    region: normalizeText(options.region || "us").toLocaleLowerCase("en-US"),
    realm: latestCharacter.realm,
    name: latestCharacter.name,
    source: "auto-detected",
    detectedPath: latestCharacter.path,
  };
}

async function main() {
  const { positionals, options } = parseCommandLine(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.region && positionals[0]) {
    options.region = positionals[0];
  }
  if (!options.realm && positionals[1]) {
    options.realm = positionals[1];
  }
  if (!options.name && positionals[2]) {
    options.name = positionals[2];
  }

  const character = resolveCharacterInput(options);
  const parsedScore =
    options.score == null || options.score === ""
      ? null
      : Number.parseFloat(String(options.score));

  const record = buildCharacterRecord(
    createMockCharacterInput({
      region: character.region,
      realm: character.realm,
      name: character.name,
      score: Number.isFinite(parsedScore) ? parsedScore : undefined,
      updatedAt: formatIsoTimestamp(),
    })
  );

  const outputDir = options["output-dir"]
    ? path.resolve(String(options["output-dir"]))
    : DEFAULT_OUTPUT_DIR;
  const addonsDir = options["addons-dir"]
    ? path.resolve(String(options["addons-dir"]))
    : DEFAULT_WOW_ADDONS_DIR;

  const payload = buildCompanionPayload([record], {
    builtAt: formatIsoTimestamp(),
    source: "mock",
    rateLimit: null,
  });
  const staged = stageAddonBundle(outputDir, payload);

  let installed = null;
  if (options["install-wow"]) {
    installed = installStagedAddons(staged, addonsDir);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        source: character.source,
        detectedPath: character.detectedPath,
        region: record.region,
        realm: record.realm,
        name: record.name,
        score: record.score,
        dungeons: record.dungeons,
        staged,
        installed,
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
