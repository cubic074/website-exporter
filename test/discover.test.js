import assert from "node:assert/strict";
import test from "node:test";
import { processCss, processHtml, processJavaScript } from "../src/discover.js";

const rewrite = (url) => `LOCAL:${new URL(url).pathname}`;

test("HTML discovers supported assets, base URLs, srcset, and inline content", async () => {
  const source = `<!doctype html><html><head>
    <base href="/assets/">
    <link rel="stylesheet" href="site.css">
    <script type="module">import "./inline.js";</script>
    <style>.hero { background:url("hero.png") }</style>
  </head><body><a href="/ignored">ignored</a>
    <img src="image.png" srcset="small.png 1x, large.png 2x">
  </body></html>`;
  const result = await processHtml(source, "https://example.com/page", rewrite);

  assert.deepEqual(new Set(result.dependencies), new Set([
    "https://example.com/assets/site.css",
    "https://example.com/assets/image.png",
    "https://example.com/assets/small.png",
    "https://example.com/assets/large.png",
    "https://example.com/assets/hero.png",
    "https://example.com/assets/inline.js"
  ]));
  assert.match(result.content, /LOCAL:\/assets\/site\.css/);
  assert.match(result.content, /href="\/ignored"/);
  assert.doesNotMatch(result.content, /<base/);
});

test("CSS discovers imports and URLs", async () => {
  const result = await processCss(
    `@import "./theme.css"; .x{background:url('../img/a.png')}`,
    "https://example.com/css/main.css",
    rewrite
  );
  assert.deepEqual(new Set(result.dependencies), new Set([
    "https://example.com/css/theme.css",
    "https://example.com/img/a.png"
  ]));
  assert.match(result.content, /LOCAL:\/css\/theme\.css/);
});

test("JavaScript discovers static imports, literal dynamic imports, and source maps", async () => {
  const source = `import x from "./x.js"; export * from "./y.js";
    import("./lazy.js"); import(variable);
    //# sourceMappingURL=app.js.map`;
  const result = await processJavaScript(source, "https://example.com/js/app.js", rewrite);
  assert.deepEqual(new Set(result.dependencies), new Set([
    "https://example.com/js/x.js",
    "https://example.com/js/y.js",
    "https://example.com/js/lazy.js",
    "https://example.com/js/app.js.map"
  ]));
  assert.match(result.content, /LOCAL:\/js\/x\.js/);
  assert.match(result.content, /import\(variable\)/);
});
