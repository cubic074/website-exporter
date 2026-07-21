import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  localPathForUrl,
  normalizeUrl,
  relativeReference,
} from "../src/paths.js";

test("infers extensions and handles directory URLs", () => {
  assert.equal(
    localPathForUrl("https://example.com/", "text/html"),
    "index.html",
  );
  assert.equal(
    localPathForUrl("https://example.com/app", "text/javascript"),
    "app.js",
  );
  assert.equal(
    localPathForUrl("https://example.com/gallery", "text/html"),
    "gallery.html",
  );
  assert.equal(
    localPathForUrl("https://example.com/gallery/", "text/html"),
    path.join("gallery", "index.html"),
  );
});

test("encoded path separators cannot escape a URL path segment", () => {
  assert.equal(
    localPathForUrl("https://example.com/a%2Fb/file", "text/html"),
    path.join("a_b", "file.html"),
  );
  assert.equal(
    localPathForUrl("https://example.com/CON", "text/html"),
    "_CON.html",
  );
});

test("query strings create deterministic collision-resistant names", () => {
  const first = localPathForUrl(
    "https://example.com/app.js?v=1",
    "text/javascript",
  );
  const second = localPathForUrl(
    "https://example.com/app.js?v=2",
    "text/javascript",
  );
  assert.notEqual(first, second);
  assert.match(first, /app\.__q_[a-f0-9]{10}\.js$/);
});

test("normalization drops fragments and relative references are portable", () => {
  assert.equal(
    normalizeUrl("https://example.com/a#part"),
    "https://example.com/a",
  );
  assert.equal(
    relativeReference(
      path.join("a", "pages", "index.html"),
      path.join("b", "app.js"),
    ),
    "../../b/app.js",
  );
});
