# Static Site Dependency Mirror

A Node.js CLI for exporting one or more entry pages and their recursively discovered, same-origin dependencies. Downloaded references are rewritten for local use. External URLs remain external and are never requested by the exporter.

This is intended for authorized analysis and offline inspection. It is not a browser, a full website crawler, or an authentication/anti-bot bypass.

## Requirements

- Node.js 20 or newer
- npm

## Install

```sh
npm install
```

On Windows PowerShell systems where script execution blocks `npm.ps1`, use:

```powershell
npm.cmd install
```

## Usage

```sh
node src/cli.js https://example.com/ https://example.com/about
```

Options:

```text
--output <path>       Output parent directory (default: mirror)
--concurrency <n>     Simultaneous downloads, 1-100 (default: 8)
--header <name:value> Add a request header; may be repeated
--allow-private       Permit localhost and private-network targets
--help                Show CLI help
```

Example:

```sh
node src/cli.js https://drawaria.online/ https://drawaria.online/modpanel https://drawaria.online/gallery https://drawaria.online/scoreboards https://drawaria.online/event https://drawaria.online/test https://drawaria.online/login https://drawaria.online/terms https://drawaria.online/privacy \
  --output ./downloads \
  --concurrency 12 \
  --header "Cookie: sid1=s:tfvUT0lSJe10S13iCpyZ-c7f4okjliYm.WcKAk+THu+q1WC7LzUZxAlaPMtOamJGGuOJgJl4Ptvw"
```

All entry points must have the same origin: scheme, hostname, and port. Headers are sent only to that origin. Redirects to another origin are not followed, which prevents cookies and authorization headers from leaking to an external redirect target.

The default layout is:

```text
mirror/
  example.com/
    mirror-manifest.json
    index.html
    about.html
    assets/
```

The entry domain is the root directory inside `mirror`. Query strings receive a stable hash suffix so URLs such as `app.js?v=1` and `app.js?v=2` do not collide. Other path collisions receive a stable URL suffix.

## What is discovered

- Same-origin HTML links in `<a>` and `<area>` elements
- HTML scripts, stylesheets, module preloads, preloads, icons, images, sources, posters, and `srcset`
- URLs in inline `style` attributes and `<style>` elements
- Imports in inline module scripts
- CSS `@import` and `url(...)`
- JavaScript static imports/exports and literal `import(...)`
- Literal JavaScript `fetch(...)`, `axios.get(...)`, GET/HEAD `XMLHttpRequest.open(...)`, `new URL(...)`, and Worker resource URLs
- JavaScript source-map comments

Same-origin links recursively expand the crawl and are rewritten to their downloaded targets. External links remain live and are not requested. Form actions are never submitted or used to expand the crawl; they are only rewritten when their target was downloaded through another route. Dynamically constructed JavaScript URLs, non-GET API behavior, WebSocket traffic, and browser-generated requests cannot be exported reliably and are left alone.

## Programmatic use

```js
import { mirrorSite } from "./src/mirror.js";

await mirrorSite(["https://example.com/", "https://example.com/account"], {
  output: "./mirror",
  headers: {
    Cookie: "session=your-session-cookie",
  },
});
```

`mirrorSite` continues to accept a single URL string for compatibility.

## Deduplication and manifest

URLs are normalized and queued once per run. Every downloaded response and final output receives a SHA-256 fingerprint in `mirror-manifest.json`. Distinct URLs with byte-identical final output are stored as hard links when the filesystem supports them, with `duplicateOf` identifying the first resource. A normal file is written as a portable fallback when hard links are unavailable. `sourceDuplicateOf` also records identical response bodies whose rewritten outputs differ.

The manifest lists skipped external URLs under `externalUrls`; request headers and their values are never written to it.

## Security behavior

Only HTTP and HTTPS resources are accepted. Localhost, loopback, link-local, and private-network addresses are blocked by default, including redirect destinations. Use `--allow-private` only when intentionally mirroring a trusted local service.

## Repeat runs and failures

Files reached in the current run are refreshed. Unrelated files already in the destination are left untouched. A failed dependency does not stop the crawl; its error is written to `mirror-manifest.json`. All entry points are attempted, and one or more inaccessible entry documents produce a nonzero exit code after the manifest is written.

## Test

```sh
npm test
```

Or, when PowerShell blocks `npm.ps1`:

```powershell
npm.cmd test
```
