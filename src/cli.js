#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { mirrorSite } from "./mirror.js";

function usage() {
  return `Usage: node src/cli.js <url> [options]

Options:
  --output <path>       Output parent directory (default: mirror)
  --concurrency <n>     Maximum simultaneous downloads (default: 8)
  --allow-private       Allow loopback and private-network targets
  --help                Show this help
`;
}

export function parseArgs(argv) {
  const options = {
    output: "mirror",
    concurrency: 8,
    allowPrivate: false
  };
  let entryUrl;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    if (arg === "--allow-private") {
      options.allowPrivate = true;
      continue;
    }
    if (arg === "--output") {
      const value = argv[++i];
      if (!value) throw new Error("--output requires a path");
      options.output = value;
      continue;
    }
    if (arg === "--concurrency") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--concurrency must be an integer from 1 to 100");
      }
      options.concurrency = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (entryUrl) throw new Error("Only one entry URL may be supplied");
    entryUrl = arg;
  }

  if (!entryUrl) throw new Error("An entry URL is required");
  const parsed = new URL(entryUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Entry URL must use http:// or https://");
  }

  options.output = path.resolve(options.output);
  return { entryUrl: parsed.href, options, help: false };
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await mirrorSite(parsed.entryUrl, {
      ...parsed.options,
      logger: (message) => process.stdout.write(`${message}\n`)
    });

    process.stdout.write(
      `Done: ${result.summary.downloaded} downloaded, ` +
      `${result.summary.skipped} skipped, ${result.summary.failed} failed\n` +
      `Mirror: ${result.rootDir}\n` +
      `Manifest: ${result.manifestPath}\n`
    );
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
