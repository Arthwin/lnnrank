"use strict";

function parseCommandLine(argv) {
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const flag = token.slice(2);
    const [name, inlineValue] = flag.split("=", 2);
    if (inlineValue != null) {
      options[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[name] = true;
      continue;
    }

    options[name] = next;
    index += 1;
  }

  return { positionals, options };
}

module.exports = {
  parseCommandLine,
};
