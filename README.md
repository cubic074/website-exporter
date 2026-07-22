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
node src/cli.js --base-url https://example.com --include / --include /about
```

Options:

```text
--base-url <url>     Base URL used to resolve includes and exclusions
--include <path>     Entry URL or path; may be repeated
--output <path>       Output parent directory (default: mirror)
--concurrency <n>     Simultaneous downloads, 1-100 (default: 8)
--header <name:value> Add a request header; may be repeated
--exclude <pattern>   Do not visit matching URLs; `*` is a wildcard; repeatable
--log-only            Write only visited-urls.log; do not export site files
--allow-private       Permit localhost and private-network targets
--help                Show CLI help
```

Example:

```sh
node ./src/cli.js --base-url https://drawaria.online --include "/" --include "/test" --include "/modpanel" --include "/event" --include "/links" --include "/terms" --include "/rules" --include "/room/1" --include "/stencils" --include "/gallery" --include "/palettes" --include "/gallery/hot" --include "/gallery/new" --include "/gallery/top" --include "/scoreboards/" --include "/gallery/img/" --include "/gallery/picks" --include "/avatar/builder" --include "/scoreboards/mostwins" --include "/scoreboards/mostscore" --include "/scoreboards/moststars" --include "/scoreboards/mostscore/day" --include "/scoreboards/mostscore/year" --include "/scoreboards/mostscore/month" --include "/scoreboards/mostscore/alltime" --include "/gallery/?uid=c998b5a0-a8da-11ef-acaf-250da20bac69" --include "/profile/?uid=c998b5a0-a8da-11ef-acaf-250da20bac69" --include "/friends/?uid=c998b5a0-a8da-11ef-acaf-250da20bac69" --include "/palettes/?uid=c998b5a0-a8da-11ef-acaf-250da20bac69" --exclude "/logout" --exclude "/clearsessions" --exclude "/*/logout" --exclude "/*/clearsessions" --exclude "/*.png" --exclude "/*.jpg" --exclude "/*.gif" --exclude "/*.svg" --exclude "/*.js.map" --header "Cookie: sid1=s:tfvUT0lSJe10S13iCpyZ-c7f4okjliYm.WcKAk+THu+q1WC7LzUZxAlaPMtOamJGGuOJgJl4Ptvw"
```

All entry points must have the same origin: scheme, hostname, and port. Headers are sent only to that origin. Redirects to another origin are not followed, which prevents cookies and authorization headers from leaking to an external redirect target.

`--base-url` removes the need to repeat the origin. Each `--include` is an entry point and can be absolute or relative to that base. The original positional URL syntax remains supported.

Use `--exclude` more than once to prevent matching URLs from being requested. Exclusions can be absolute or relative to the base URL. `*` matches any number of characters; without a wildcard, matching remains exact. Quote patterns so the shell passes them unchanged:

```sh
node src/cli.js --base-url https://example.com \
  --include / \
  --include /about \
  --exclude "/avatar/cache/*" \
  --exclude "/logout"
```

Use `--log-only` to crawl and discover URLs without exporting the mirrored site. The only file written by that run is `visited-urls.log` inside the domain output directory. It contains one unique URL per line for every HTTP request attempted after safety checks, including redirect hops. External, excluded, and unsafe URLs are not listed because no HTTP request is made:

```sh
node src/cli.js --base-url https://example.com \
  --include / \
  --exclude "/avatar/cache/*" \
  --log-only
```

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

Query-bearing navigation is entry-list controlled. A URL containing `?` is followed from an `<a>` or `<area>` only when that exact URL was supplied as an entry point. This prevents a user gallery, profile, or friends page from recursively crawling the same route for every linked user ID. Ignored URLs are listed under `ignoredNavigationUrls` in the manifest. Query strings on static assets and discovered API/resource calls are unaffected by this rule.

## Programmatic use

```js
import { mirrorSite } from "./src/mirror.js";

await mirrorSite(["https://example.com/", "https://example.com/account"], {
  output: "./mirror",
  excludeUrls: ["/logout", "/avatar/cache/*"],
  headers: {
    Cookie: "session=your-session-cookie",
  },
});
```

`mirrorSite` continues to accept a single URL string for compatibility.

## Deduplication and manifest

URLs are normalized and queued once per run. An explicitly listed query-bearing HTML page is consolidated into a generic query-free page when it is the sole representative for that pathname, or when its other downloaded variants have byte-identical content. For example, an entry point `/gallery/?uid=...` is stored and rewritten as `gallery/index.html`, ready for a later script to populate manually. A distinct `/gallery` page remains separate as `gallery.html`; trailing-slash path identity is preserved. Original query source URLs remain manifest records, marked with `genericQueryPage` and `queryCanonicalOf`. If multiple explicitly listed variants return different HTML bodies, they retain distinct query-hashed paths.

Every downloaded response and final output receives a SHA-256 fingerprint in `mirror-manifest.json`. Other distinct URLs with byte-identical final output may share storage through hard links. `duplicateOf` identifies the first resource. A normal file is written as a portable fallback when hard links are unavailable. `sourceDuplicateOf` also records identical response bodies whose rewritten outputs differ.

The manifest stores normalized configured patterns under `excludePatterns`, skipped external URLs under `externalUrls`, and URLs that actually matched an exclusion under `excludedUrls`. Request headers and their values are never written to it.

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
