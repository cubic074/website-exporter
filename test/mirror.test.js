import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mirrorSite } from "../src/mirror.js";

async function fixtureServer(externalScriptUrl = "") {
  const hits = new Map();
  const requestHeaders = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    hits.set(
      url.pathname + url.search,
      (hits.get(url.pathname + url.search) || 0) + 1,
    );
    requestHeaders.set(url.pathname + url.search, request.headers);
    const routes = {
      "/": [
        "text/html",
        `<link rel="stylesheet" href="/style"><script type="module" src="/app.js"></script><script src="/api-client.js"></script><script src="${externalScriptUrl}"></script><a href="/second">Second</a><img src="/img.png">`,
      ],
      "/second": ["text/html", `<a href="/">Home</a><img src="/copy.png">`],
      "/style": [
        "text/css",
        `@import "/nested.css"; body{background:url("/img.png")}`,
      ],
      "/nested.css": ["text/css", `.x{color:red}`],
      "/app.js": [
        "text/javascript",
        `import "./dep.js"; //# sourceMappingURL=app.js.map`,
      ],
      "/dep.js": ["text/javascript", `export default 1`],
      "/app.js.map": ["application/json", `{}`],
      "/api-client.js": [
        "text/javascript",
        `fetch("/api/data"); const u = new URL("/extra.png", location.origin); const x = new XMLHttpRequest(); x.open("GET", "/api/xhr")`,
      ],
      "/api/data": ["application/json", `{"source":"fetch"}`],
      "/api/xhr": ["application/json", `{"source":"xhr"}`],
      "/extra.png": ["image/png", "EXTRA"],
      "/img.png": ["image/png", "PNG"],
      "/copy.png": ["image/png", "PNG"],
      "/missing.js": null,
    };
    const route = routes[url.pathname];
    if (!route) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": route[0] });
    response.end(route[1]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    requestHeaders,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function externalServer() {
  let hits = 0;
  const server = http.createServer((_, response) => {
    hits += 1;
    response
      .writeHead(200, { "content-type": "text/javascript" })
      .end("external");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/external.js`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("end-to-end crawl downloads recursively, rewrites, deduplicates, and manifests", async (t) => {
  const external = await externalServer();
  t.after(() => external.close());
  const fixture = await fixtureServer(external.url);
  t.after(() => fixture.close());
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const result = await mirrorSite(fixture.url, {
    output,
    allowPrivate: true,
    concurrency: 3,
    headers: { cookie: "session=allowed", "x-export": "yes" },
  });

  assert.equal(result.summary.downloaded, 13);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.external, 1);
  assert.equal(result.summary.deduplicated, 1);
  assert.equal(fixture.hits.get("/img.png"), 1);
  assert.equal(external.hits(), 0);
  assert.equal(fixture.requestHeaders.get("/").cookie, "session=allowed");
  assert.equal(fixture.requestHeaders.get("/api/data")["x-export"], "yes");

  const entryRecord = result.manifest.resources.find(
    (item) => item.originalUrl === fixture.url,
  );
  assert.equal(entryRecord.localPath, "index.html");
  const html = await fs.readFile(
    path.join(result.rootDir, entryRecord.localPath),
    "utf8",
  );
  assert.match(html, /style\.css/);
  assert.match(html, /app\.js/);
  assert.match(html, /href="\.\/second\.html"/);
  assert.ok(html.includes(external.url));

  const apiRecord = result.manifest.resources.find((item) =>
    item.originalUrl.endsWith("/api-client.js"),
  );
  const apiScript = await fs.readFile(
    path.join(result.rootDir, apiRecord.localPath),
    "utf8",
  );
  assert.match(apiScript, /fetch\("\.\/api\/data\.json"\)/);
  assert.match(apiScript, /open\("GET", "\.\/api\/xhr\.json"\)/);

  const duplicateRecords = result.manifest.resources.filter(
    (item) => item.duplicateOf,
  );
  assert.equal(duplicateRecords.length, 1);
  assert.equal(result.manifest.entryUrls.length, 1);
  const linkedPage = result.manifest.resources.find((item) =>
    item.originalUrl.endsWith("/second"),
  );
  assert.equal(linkedPage.status, "downloaded");
  assert.equal(linkedPage.isEntry, false);
  assert.equal(result.manifest.resources.length, 13);
  await assert.rejects(
    fs.stat(path.join(result.rootDir, new URL(fixture.url).host)),
    /ENOENT/,
  );
});

test("entry points from a different origin are rejected", async () => {
  await assert.rejects(
    mirrorSite(["https://example.com/", "https://cdn.example.com/page"]),
    /same origin/,
  );
});

test("cross-origin redirects are not followed and cannot receive custom headers", async (t) => {
  const external = await externalServer();
  t.after(() => external.close());
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(`<script src="/redirect.js"></script>`);
      return;
    }
    response.writeHead(302, { location: external.url }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const result = await mirrorSite(`http://127.0.0.1:${port}/`, {
    output,
    allowPrivate: true,
    headers: { authorization: "Bearer secret" },
  });

  assert.equal(external.hits(), 0);
  assert.equal(result.summary.failed, 1);
  const redirected = result.manifest.resources.find((item) =>
    item.originalUrl.endsWith("/redirect.js"),
  );
  assert.match(redirected.error, /External redirect not followed/);
});

test("refreshing one previously deduplicated file does not mutate stale hard links", async (t) => {
  let secondRun = false;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      const images = secondRun
        ? `<img src="/a.png">`
        : `<img src="/a.png"><img src="/b.png">`;
      response.writeHead(200, { "content-type": "text/html" }).end(images);
      return;
    }
    const body = secondRun && request.url === "/a.png" ? "NEW" : "SAME";
    response.writeHead(200, { "content-type": "image/png" }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const entry = `http://127.0.0.1:${port}/`;
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const first = await mirrorSite(entry, { output, allowPrivate: true });
  assert.equal(first.summary.deduplicated, 1);
  secondRun = true;
  const second = await mirrorSite(entry, { output, allowPrivate: true });

  assert.equal(
    await fs.readFile(path.join(second.rootDir, "a.png"), "utf8"),
    "NEW",
  );
  assert.equal(
    await fs.readFile(path.join(second.rootDir, "b.png"), "utf8"),
    "SAME",
  );
});

test("entry private-network targets are blocked by default", async () => {
  await assert.rejects(
    mirrorSite("http://127.0.0.1:1/", {
      output: await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-")),
    }),
    /Private-network target blocked/,
  );
});
