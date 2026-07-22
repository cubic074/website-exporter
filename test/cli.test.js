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

test("CLI resolves repeated includes and exclusion patterns against a base URL", () => {
  const parsed = parseArgs([
    "--base-url",
    "https://example.com/app/",
    "--include",
    "/",
    "--include",
    "about",
    "--exclude",
    "/avatar/cache/*",
    "--exclude",
    "temporary/*",
  ]);

  assert.deepEqual(parsed.entryUrls, [
    "https://example.com/",
    "https://example.com/app/about",
  ]);
  assert.deepEqual(parsed.options.excludeUrls, [
    "https://example.com/avatar/cache/*",
    "https://example.com/app/temporary/*",
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
    /requires a URL pattern/,
  );
});

test("CLI requires base URL includes and rejects include wildcards", () => {
  assert.throws(
    () => parseArgs(["--include", "/about"]),
    /requires --base-url/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--base-url",
        "https://example.com/",
        "--include",
        "/docs/*",
      ]),
    /does not support wildcard/,
  );
});
