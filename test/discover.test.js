import assert from "node:assert/strict";
import test from "node:test";
import { processCss, processHtml, processJavaScript } from "../src/discover.js";

const rewrite = (url) => `LOCAL:${new URL(url).pathname}`;

test("HTML discovers supported assets, base URLs, srcset, and inline content", async () => {
  const source = `<!doctype html><html><head>
    <base href="/assets/">
    <link rel="stylesheet" href="https://cdn.example/site.css#theme">
    <script type="module">import "./inline.js";</script>
    <script>fetch("/api/data")</script>
    <script type="application/ld+json">{"url":"/not-a-script"}</script>
    <style>.hero { background:url("hero.png") }</style>
  </head><body><a href="/ignored">ignored</a>
    <img src="image.png" srcset="small.png 1x, large.png 2x">
  </body></html>`;
  const result = await processHtml(source, "https://example.com/page", rewrite);

  assert.deepEqual(
    new Set(result.dependencies),
    new Set([
      "https://cdn.example/site.css",
      "https://example.com/assets/image.png",
      "https://example.com/assets/small.png",
      "https://example.com/assets/large.png",
      "https://example.com/assets/hero.png",
      "https://example.com/assets/inline.js",
      "https://example.com/api/data",
    ]),
  );
  assert.match(result.content, /LOCAL:\/site\.css#theme/);
  assert.match(result.content, /href="\/ignored"/);
  assert.doesNotMatch(result.content, /<base/);
});

test("CSS discovers imports and URLs", async () => {
  const result = await processCss(
    `@import "./theme.css"; .x{background:url('../img/a.png')}`,
    "https://example.com/css/main.css",
    rewrite,
  );
  assert.deepEqual(
    new Set(result.dependencies),
    new Set([
      "https://example.com/css/theme.css",
      "https://example.com/img/a.png",
    ]),
  );
  assert.match(result.content, /LOCAL:\/css\/theme\.css/);
});

test("JavaScript discovers static imports, literal dynamic imports, and source maps", async () => {
  const source = `import x from "./x.js"; export * from "./y.js";
    import("./lazy.js"); import(variable);
    //# sourceMappingURL=app.js.map`;
  const result = await processJavaScript(
    source,
    "https://example.com/js/app.js",
    rewrite,
  );
  assert.deepEqual(
    new Set(result.dependencies),
    new Set([
      "https://example.com/js/x.js",
      "https://example.com/js/y.js",
      "https://example.com/js/lazy.js",
      "https://example.com/js/app.js.map",
    ]),
  );
  assert.match(result.content, /LOCAL:\/js\/x\.js/);
  assert.match(result.content, /import\(variable\)/);
});

test("JavaScript discovers and rewrites literal API and resource calls", async () => {
  const source = `
    fetch("/api/fetch");
    axios.get("/api/axios");
    request.open('GET', "/api/xhr");
    window.open("/page", "_blank");
    const asset = new URL("/images/runtime.png", location.origin);
    fetch(variable);
    fetch("https://outside.example/data");
  `;
  const result = await processJavaScript(
    source,
    "https://example.com/js/app.js",
    rewrite,
  );

  assert.deepEqual(
    new Set(result.dependencies),
    new Set([
      "https://example.com/api/fetch",
      "https://example.com/api/axios",
      "https://example.com/api/xhr",
      "https://example.com/images/runtime.png",
      "https://outside.example/data",
    ]),
  );
  assert.match(result.content, /fetch\("LOCAL:\/api\/fetch"\)/);
  assert.match(result.content, /open\('GET', "LOCAL:\/api\/xhr"\)/);
  assert.match(result.content, /window\.open\("\/page", "_blank"\)/);
  assert.match(result.content, /fetch\(variable\)/);
});

test("HTML can rewrite navigation without crawling it as a dependency", async () => {
  const result = await processHtml(
    `<base href="/pages/"><a href="next#part">Next</a><form action="submit"></form>`,
    "https://example.com/start",
    rewrite,
    { rewriteNavigation: (url) => `NAV:${new URL(url).pathname}` },
  );

  assert.deepEqual(result.dependencies, []);
  assert.match(result.content, /href="NAV:\/pages\/next#part"/);
  assert.match(result.content, /action="NAV:\/pages\/submit"/);
  assert.doesNotMatch(result.content, /<base/);
});
