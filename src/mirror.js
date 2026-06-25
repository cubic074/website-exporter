import fs from "node:fs/promises";
import path from "node:path";
import { processCss, processHtml, processJavaScript } from "./discover.js";
import { assertSafeUrl } from "./security.js";
import {
  hostDirectory,
  localPathForUrl,
  normalizeUrl,
  relativeReference
} from "./paths.js";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

function contentKind(contentType, url) {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/css") return "css";
  if (["text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript"].includes(mime)) {
    return "javascript";
  }
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".css") return "css";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return "binary";
}

async function fetchWithSafeRedirects(url, allowPrivate) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertSafeUrl(current, allowPrivate);
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": "static-site-dependency-mirror/1.0",
        "accept": "*/*"
      }
    });
    if (!REDIRECT_CODES.has(response.status)) return { response, finalUrl: current.href };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current.href };
    current = new URL(location, current);
  }
  throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
}

export async function mirrorSite(entryUrl, options = {}) {
  const output = path.resolve(options.output || "mirror");
  const concurrency = options.concurrency || 8;
  const allowPrivate = Boolean(options.allowPrivate);
  const logger = options.logger || (() => {});
  const entry = new URL(entryUrl);
  const rootDir = path.join(output, hostDirectory(entry));
  const manifestPath = path.join(rootDir, "mirror-manifest.json");
  const queue = [];
  const records = new Map();
  const summary = { downloaded: 0, skipped: 0, failed: 0 };
  let active = 0;
  let fatalEntryError;
  let resolveComplete;
  const complete = new Promise((resolve) => { resolveComplete = resolve; });

  await fs.mkdir(rootDir, { recursive: true });

  function enqueue(url, parentUrl = null, isEntry = false) {
    let normalized;
    try {
      normalized = normalizeUrl(url);
    } catch {
      return;
    }
    if (records.has(normalized)) {
      summary.skipped += 1;
      return;
    }
    const record = {
      originalUrl: normalized,
      finalUrl: null,
      localPath: null,
      contentType: null,
      status: "queued",
      httpStatus: null,
      parentUrl,
      error: null
    };
    records.set(normalized, record);
    queue.push({ url: normalized, record, isEntry });
    pump();
  }

  async function processJob(job) {
    const { url, record, isEntry } = job;
    try {
      const { response, finalUrl } = await fetchWithSafeRedirects(url, allowPrivate);
      record.finalUrl = finalUrl;
      record.httpStatus = response.status;
      record.contentType = response.headers.get("content-type") || "application/octet-stream";
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

      const relativePath = localPathForUrl(new URL(finalUrl), record.contentType);
      const absolutePath = path.join(rootDir, relativePath);
      record.localPath = relativePath.split(path.sep).join("/");
      const body = Buffer.from(await response.arrayBuffer());
      const kind = contentKind(record.contentType, finalUrl);
      record.body = body;
      record.kind = kind;
      record.absolutePath = absolutePath;

      if (kind !== "binary") {
        const source = body.toString("utf8");
        const rewrite = (dependencyUrl) => dependencyUrl;
        let result;
        if (kind === "html") result = await processHtml(source, finalUrl, rewrite);
        if (kind === "css") result = await processCss(source, finalUrl, rewrite);
        if (kind === "javascript") result = await processJavaScript(source, finalUrl, rewrite);
        for (const dependency of result.dependencies) enqueue(dependency, url);
      }

      record.status = "downloaded";
      summary.downloaded += 1;
      logger(`[${response.status}] ${url}`);
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      summary.failed += 1;
      logger(`[FAILED] ${url}: ${error.message}`);
      if (isEntry) fatalEntryError = error;
    }
  }

  function pump() {
    while (active < concurrency && queue.length > 0 && !fatalEntryError) {
      const job = queue.shift();
      active += 1;
      processJob(job).finally(() => {
        active -= 1;
        pump();
      });
    }
    if (active === 0 && (queue.length === 0 || fatalEntryError)) resolveComplete();
  }

  enqueue(entry.href, null, true);
  await complete;

  if (!fatalEntryError) {
    for (const record of records.values()) {
      if (record.status !== "downloaded") continue;
      let outputBody = record.body;
      if (record.kind !== "binary") {
        const source = record.body.toString("utf8");
        const rewrite = (dependencyUrl) => {
          const target = records.get(normalizeUrl(dependencyUrl));
          if (!target?.localPath) return dependencyUrl;
          return relativeReference(record.localPath, target.localPath);
        };
        let result;
        if (record.kind === "html") result = await processHtml(source, record.finalUrl, rewrite);
        if (record.kind === "css") result = await processCss(source, record.finalUrl, rewrite);
        if (record.kind === "javascript") {
          result = await processJavaScript(source, record.finalUrl, rewrite);
        }
        outputBody = Buffer.from(result.content);
      }
      await fs.mkdir(path.dirname(record.absolutePath), { recursive: true });
      await fs.writeFile(record.absolutePath, outputBody);
      logger(`[SAVED] ${record.localPath}`);
    }
  }

  const publicRecords = [...records.values()].map((record) => ({
    originalUrl: record.originalUrl,
    finalUrl: record.finalUrl,
    localPath: record.localPath,
    contentType: record.contentType,
    status: record.status,
    httpStatus: record.httpStatus,
    parentUrl: record.parentUrl,
    error: record.error
  }));
  const manifest = {
    version: 1,
    entryUrl: entry.href,
    createdAt: new Date().toISOString(),
    summary,
    resources: publicRecords
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (fatalEntryError) throw new Error(`Unable to download entry document: ${fatalEntryError.message}`);

  return { rootDir, manifestPath, summary, manifest };
}
