#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { mirrorSite } from "./mirror.js";

function usage() {
  return `Usage: node src/cli.js <url> [url...] [options]

Options:
  --output <path>       Output parent directory (default: mirror)
  --concurrency <n>     Maximum simultaneous downloads (default: 8)
  --header <name:value> Add a request header; may be repeated
  --exclude <url>       Do not visit this URL; may be repeated
  --allow-private       Allow loopback and private-network targets
  --help                Show this help
`;
}

export function parseArgs(argv) {
  const options = {
    output: "mirror",
    concurrency: 8,
    allowPrivate: false,
    headers: [],
    excludeUrls: [],
  };
  const entryUrls = [];

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
    if (arg === "--header") {
      const value = argv[++i];
      const separator = value?.indexOf(":") ?? -1;
      if (separator < 1) throw new Error("--header requires a name:value pair");
      const name = value.slice(0, separator).trim();
      const headerValue = value.slice(separator + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new Error(`Invalid header name: ${name}`);
      }
      options.headers.push([name, headerValue]);
      continue;
    }
    if (arg === "--exclude") {
      const value = argv[++i];
      if (!value) throw new Error("--exclude requires a URL");
      options.excludeUrls.push(value);
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
    entryUrls.push(arg);
  }

  if (entryUrls.length === 0)
    throw new Error("At least one entry URL is required");
  const parsedEntries = entryUrls.map((entryUrl) => new URL(entryUrl));
  for (const parsed of parsedEntries) {
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Entry URLs must use http:// or https://");
    }
  }

  options.output = path.resolve(options.output);
  return {
    entryUrl: parsedEntries[0].href,
    entryUrls: parsedEntries.map((entry) => entry.href),
    options,
    help: false,
  };
}

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }

    const result = await mirrorSite(parsed.entryUrls, {
      ...parsed.options,
      logger: (message) => process.stdout.write(`${message}\n`),
    });

    process.stdout.write(
      `Done: ${result.summary.downloaded} downloaded, ` +
        `${result.summary.skipped} URL duplicates skipped, ` +
        `${result.summary.deduplicated} content duplicates, ` +
        `${result.summary.external} external ignored, ` +
        `${result.summary.excluded} excluded, ` +
        `${result.summary.ignoredNavigation} query links ignored, ` +
        `${result.summary.failed} failed\n` +
        `Mirror: ${result.rootDir}\n` +
        `Manifest: ${result.manifestPath}\n`,
    );
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
