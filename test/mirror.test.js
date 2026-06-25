import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mirrorSite } from "../src/mirror.js";

async function fixtureServer() {
  const hits = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    hits.set(url.pathname + url.search, (hits.get(url.pathname + url.search) || 0) + 1);
    const routes = {
      "/": ["text/html", `<link rel="stylesheet" href="/style"><script type="module" src="/app.js"></script><img src="/img.png">`],
      "/style": ["text/css", `@import "/nested.css"; body{background:url("/img.png")}`],
      "/nested.css": ["text/css", `.x{color:red}`],
      "/app.js": ["text/javascript", `import "./dep.js"; //# sourceMappingURL=app.js.map`],
      "/dep.js": ["text/javascript", `export default 1`],
      "/app.js.map": ["application/json", `{}`],
      "/img.png": ["image/png", "PNG"],
      "/missing.js": null
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
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("end-to-end crawl downloads recursively, rewrites, deduplicates, and manifests", async (t) => {
  const fixture = await fixtureServer();
  t.after(() => fixture.close());
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));

  const result = await mirrorSite(fixture.url, {
    output,
    allowPrivate: true,
    concurrency: 3
  });

  assert.equal(result.summary.downloaded, 7);
  assert.equal(result.summary.failed, 0);
  assert.equal(fixture.hits.get("/img.png"), 1);
  const entryRecord = result.manifest.resources.find((item) => item.originalUrl === fixture.url);
  const html = await fs.readFile(path.join(result.rootDir, entryRecord.localPath), "utf8");
  assert.match(html, /style\.css/);
  assert.match(html, /app\.js/);
  assert.equal(result.manifest.resources.length, 7);
});

test("entry private-network targets are blocked by default", async () => {
  await assert.rejects(
    mirrorSite("http://127.0.0.1:1/", { output: await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-")) }),
    /Private-network target blocked/
  );
});
