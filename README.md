# Static Site Dependency Mirror

A Node.js CLI for downloading one entry document and the static files it references. HTML, CSS, and JavaScript are inspected recursively and supported URLs are rewritten to point at the downloaded files.

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
node src/cli.js https://drawaria.online/
```

Options:

```text
--output <path>       Output parent directory (default: mirror)
--concurrency <n>     Simultaneous downloads, 1-100 (default: 8)
--allow-private       Permit localhost and private-network targets
--help                Show CLI help
```

Example:

```sh
node src/cli.js https://example.com/ --output ./downloads --concurrency 12
```

The default layout is:

```text
mirror/
  example.com/
    mirror-manifest.json
    example.com/
      index.html
      assets/
    cdn.example.net/
      library.js
```

Each remote host gets a separate subtree. Query strings receive a stable hash suffix so URLs such as `app.js?v=1` and `app.js?v=2` do not collide.

## What is discovered

- HTML scripts, stylesheets, module preloads, preloads, icons, images, sources, posters, and `srcset`
- URLs in inline `style` attributes and `<style>` elements
- Imports in inline module scripts
- CSS `@import` and `url(...)`
- JavaScript static imports/exports and literal `import(...)`
- JavaScript source-map comments

Ordinary links, forms, runtime `fetch`/XHR/WebSocket traffic, and dynamically constructed JavaScript URLs are not followed.

## Security behavior

Only HTTP and HTTPS resources are accepted. Localhost, loopback, link-local, and private-network addresses are blocked by default, including redirect destinations. Use `--allow-private` only when intentionally mirroring a trusted local service.

## Repeat runs and failures

Files reached in the current run are refreshed. Unrelated files already in the destination are left untouched. A failed dependency does not stop the crawl; its error is written to `mirror-manifest.json`. An inaccessible entry document produces a nonzero exit code.

## Test

```sh
npm test
```

Or, when PowerShell blocks `npm.ps1`:

```powershell
npm.cmd test
```
