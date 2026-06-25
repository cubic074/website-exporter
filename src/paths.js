import crypto from "node:crypto";
import path from "node:path";

const MIME_EXTENSIONS = new Map([
  ["text/html", ".html"],
  ["text/css", ".css"],
  ["text/javascript", ".js"],
  ["application/javascript", ".js"],
  ["application/json", ".json"],
  ["application/wasm", ".wasm"],
  ["image/svg+xml", ".svg"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/x-icon", ".ico"],
  ["font/woff", ".woff"],
  ["font/woff2", ".woff2"],
  ["application/font-woff", ".woff"],
  ["application/pdf", ".pdf"]
]);

function safeSegment(segment) {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  })();
  const safe = decoded.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  return safe || "_";
}

export function normalizeUrl(input) {
  const url = new URL(input);
  url.hash = "";
  return url.href;
}

export function hostDirectory(url) {
  return safeSegment(url.host.replaceAll(":", "_"));
}

export function localPathForUrl(input, contentType = "") {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  const segments = url.pathname.split("/").filter(Boolean).map(safeSegment);
  const pathEndsWithSlash = url.pathname.endsWith("/");
  let filename = segments.pop();
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const inferred = MIME_EXTENSIONS.get(mime) || "";

  if (!filename || pathEndsWithSlash) {
    if (filename) segments.push(filename);
    filename = `index${inferred || ".html"}`;
  } else if (!path.extname(filename) && inferred) {
    filename += inferred;
  }

  if (url.search) {
    const hash = crypto.createHash("sha256").update(url.search).digest("hex").slice(0, 10);
    const ext = path.extname(filename);
    filename = `${filename.slice(0, ext ? -ext.length : undefined)}.__q_${hash}${ext}`;
  }

  return path.join(hostDirectory(url), ...segments, filename || "index.html");
}

export function relativeReference(fromFile, toFile) {
  let relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}
