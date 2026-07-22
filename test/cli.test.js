import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

test("CLI accepts multiple entry points, headers, and exclusions", () => {
  const parsed = parseArgs([
    "https://example.com/",
    "https://example.com/about",
    "--header",
    "Cookie: session=abc",
    "--header",
    "X-Access: yes",
    "--exclude",
    "/logout",
    "--exclude",
    "https://example.com/private",
  ]);

  assert.deepEqual(parsed.entryUrls, [
    "https://example.com/",
    "https://example.com/about",
  ]);
  assert.deepEqual(parsed.options.headers, [
    ["Cookie", "session=abc"],
    ["X-Access", "yes"],
  ]);
  assert.deepEqual(parsed.options.excludeUrls, [
    "/logout",
    "https://example.com/private",
  ]);
});

test("CLI rejects malformed custom headers", () => {
  assert.throws(
    () => parseArgs(["https://example.com/", "--header", "missing-separator"]),
    /name:value/,
  );
});

test("CLI requires a value for --exclude", () => {
  assert.throws(
    () => parseArgs(["https://example.com/", "--exclude"]),
    /requires a URL/,
  );
});
