import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { processCss, processHtml, processJavaScript } from "./discover.js";
import { assertSafeUrl } from "./security.js";
import {
  hostDirectory,
  localPathForUrl,
  normalizeUrl,
  relativeReference,
} from "./paths.js";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;
const MANIFEST_FILENAME = "mirror-manifest.json";
const VISITED_LOG_FILENAME = "visited-urls.log";

class ExcludedUrlError extends Error {
  constructor(url) {
    super(`Excluded URL not visited: ${url}`);
    this.excludedUrl = url;
  }
}

function contentKind(contentType, url) {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/css") return "css";
  if (
    [
      "text/javascript",
      "application/javascript",
      "application/ecmascript",
      "text/ecmascript",
    ].includes(mime)
  ) {
    return "javascript";
  }
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".css") return "css";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return "binary";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEntryUrls(input) {
  const values = Array.isArray(input) ? input : [input];
  if (
    values.length === 0 ||
    values.some(
      (value) => value === undefined || value === null || value === "",
    )
  ) {
    throw new Error("At least one entry URL is required");
  }

  const entries = values.map((value) => new URL(value));
  for (const entry of entries) {
    if (!["http:", "https:"].includes(entry.protocol)) {
      throw new Error(`Entry URL must use http:// or https://: ${entry.href}`);
    }
    entry.hash = "";
  }

  const crawlOrigin = entries[0].origin;
  const externalEntry = entries.find((entry) => entry.origin !== crawlOrigin);
  if (externalEntry) {
    throw new Error(
      `All entry points must use the same origin (${crawlOrigin}); received ${externalEntry.origin}`,
    );
  }
  return entries;
}

function createRequestHeaders(customHeaders) {
  const headers = new Headers({
    accept: "*/*",
    "user-agent": "static-site-dependency-mirror/2.0",
  });
  if (!customHeaders) return headers;

  const supplied = new Headers(customHeaders);
  for (const [name, value] of supplied) headers.set(name, value);
  return headers;
}

function compileExclusionPatterns(values, crawlOrigin) {
  if (values === undefined || values === null) return [];
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => {
    const url = new URL(value, `${crawlOrigin}/`);
    url.hash = "";
    const pattern = url.href;
    const expression = pattern
      .split("*")
      .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
      .join(".*");
    return { pattern, regex: new RegExp(`^${expression}$`) };
  });
}

async function fetchWithSafeRedirects(url, options) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.origin !== options.crawlOrigin) {
      throw new Error(`External redirect not followed: ${current.href}`);
    }
    if (options.isExcluded(current.href)) {
      throw new ExcludedUrlError(normalizeUrl(current));
    }
    await assertSafeUrl(current, options.allowPrivate);
    options.onVisit(current.href);
    const response = await fetch(current, {
      redirect: "manual",
      headers: options.headers,
    });
    if (!REDIRECT_CODES.has(response.status))
      return { response, finalUrl: current.href };

    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current.href };
    const next = new URL(location, current);
    if (next.origin !== options.crawlOrigin) {
      await response.body?.cancel();
      throw new Error(`External redirect not followed: ${next.href}`);
    }
    await response.body?.cancel();
    current = next;
  }
  throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS})`);
}

function withUrlSuffix(relativePath, url, attempt = 0) {
  const extension = path.extname(relativePath);
  const stem = extension
    ? relativePath.slice(0, -extension.length)
    : relativePath;
  const suffix = sha256(`${url}\0${attempt}`).slice(0, 10);
  return `${stem}.__u_${suffix}${extension}`;
}

function publicRecord(record) {
  const localPath = record.localPath
    ? record.localPath.split(path.sep).join("/")
    : null;
  const localReference = localPath
    ? `${localPath}${record.genericQueryPage ? "" : new URL(record.originalUrl).search}`
    : null;
  return {
    originalUrl: record.originalUrl,
    finalUrl: record.finalUrl,
    localPath,
    localReference,
    contentType: record.contentType,
    status: record.status,
    httpStatus: record.httpStatus,
    parentUrl: record.parentUrl,
    isEntry: record.isEntry,
    contentLength: record.contentLength,
    contentSha256: record.contentSha256,
    outputSha256: record.outputSha256,
    sourceDuplicateOf: record.sourceDuplicateOf,
    duplicateOf: record.duplicateOf,
    genericQueryPage: Boolean(record.genericQueryPage),
    queryCanonicalOf: record.queryCanonicalOf,
    error: record.error,
  };
}

function throwIfEntryFailed(records, result) {
  const failedEntries = records.filter(
    (record) => record.isEntry && record.status === "failed",
  );
  if (failedEntries.length === 0) return;

  const error = new Error(
    `Unable to download ${failedEntries.length} entry point(s): ` +
      failedEntries
        .map((record) => `${record.originalUrl} (${record.error})`)
        .join(", "),
  );
  error.result = result;
  throw error;
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function mirrorSite(entryUrls, options = {}) {
  const entries = normalizeEntryUrls(entryUrls);
  const output = path.resolve(options.output || "mirror");
  const concurrency = options.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error("concurrency must be an integer from 1 to 100");
  }

  const allowPrivate = Boolean(options.allowPrivate);
  const logOnly = Boolean(options.logOnly);
  const logger = options.logger || (() => {});
  const log = (message) => {
    try {
      logger(message);
    } catch {
      // Logging must not change crawl results.
    }
  };
  const crawlOrigin = entries[0].origin;
  const entryUrlSet = new Set(entries.map((entry) => entry.href));
  const exclusionPatterns = compileExclusionPatterns(
    options.excludeUrls,
    crawlOrigin,
  );
  const isExcluded = (candidate) => {
    const normalized = normalizeUrl(candidate);
    return exclusionPatterns.some(({ regex }) => regex.test(normalized));
  };
  const headers = createRequestHeaders(options.headers);
  const rootDir = path.join(output, hostDirectory(entries[0]));
  const manifestPath = path.join(rootDir, MANIFEST_FILENAME);
  const visitedLogPath = path.join(rootDir, VISITED_LOG_FILENAME);
  const queue = [];
  const records = [];
  const recordsByUrl = new Map();
  const externalUrls = new Set();
  const excludedUrls = new Set();
  const ignoredNavigationUrls = new Set();
  const visitedUrls = new Set();
  const claimedPaths = new Set([MANIFEST_FILENAME.toLowerCase()]);
  const sourceContentOwners = new Map();
  const summary = {
    downloaded: 0,
    skipped: 0,
    deduplicated: 0,
    external: 0,
    excluded: 0,
    ignoredNavigation: 0,
    failed: 0,
  };
  let active = 0;
  let started = false;
  let resolveComplete;
  const complete = new Promise((resolve) => {
    resolveComplete = resolve;
  });

  await fs.mkdir(rootDir, { recursive: true });

  function allocateLocalPath(url, contentType) {
    const initial = localPathForUrl(new URL(url), contentType);
    let candidate = initial;
    let attempt = 0;
    while (
      claimedPaths.has(candidate.split(path.sep).join("/").toLowerCase())
    ) {
      candidate = withUrlSuffix(initial, url, attempt);
      attempt += 1;
    }
    claimedPaths.add(candidate.split(path.sep).join("/").toLowerCase());
    return candidate;
  }

  function exclude(normalized) {
    excludedUrls.add(normalized);
    summary.excluded = excludedUrls.size;
    log(`[EXCLUDED] ${normalized}`);
    return null;
  }

  function enqueue(url, parentUrl = null, isEntry = false) {
    let normalized;
    try {
      normalized = normalizeUrl(url);
    } catch {
      return null;
    }

    if (new URL(normalized).origin !== crawlOrigin) {
      externalUrls.add(normalized);
      summary.external = externalUrls.size;
      return null;
    }

    if (isExcluded(normalized)) return exclude(normalized);

    const existing = recordsByUrl.get(normalized);
    if (existing) {
      if (isEntry) existing.isEntry = true;
      summary.skipped += 1;
      return existing;
    }

    const record = {
      originalUrl: normalized,
      finalUrl: null,
      localPath: null,
      contentType: null,
      status: "queued",
      httpStatus: null,
      parentUrl,
      isEntry,
      contentLength: null,
      contentSha256: null,
      outputSha256: null,
      sourceDuplicateOf: null,
      duplicateOf: null,
      genericQueryPage: false,
      queryCanonicalOf: null,
      error: null,
    };
    records.push(record);
    recordsByUrl.set(normalized, record);
    queue.push({ url: normalized, record });
    if (started) pump();
    return record;
  }

  function enqueueNavigation(url, parentUrl) {
    let normalized;
    try {
      normalized = normalizeUrl(url);
    } catch {
      return null;
    }
    const parsed = new URL(normalized);
    if (parsed.origin === crawlOrigin && isExcluded(normalized)) {
      return exclude(normalized);
    }
    if (
      parsed.origin === crawlOrigin &&
      parsed.search &&
      !entryUrlSet.has(normalized) &&
      !recordsByUrl.has(normalized)
    ) {
      ignoredNavigationUrls.add(normalized);
      summary.ignoredNavigation = ignoredNavigationUrls.size;
      return null;
    }
    return enqueue(normalized, parentUrl);
  }

  async function processJob(job) {
    const { url, record } = job;
    try {
      const { response, finalUrl } = await fetchWithSafeRedirects(url, {
        allowPrivate,
        crawlOrigin,
        headers,
        isExcluded,
        onVisit: (visitedUrl) => visitedUrls.add(normalizeUrl(visitedUrl)),
      });
      record.finalUrl = normalizeUrl(finalUrl);
      record.httpStatus = response.status;
      record.contentType =
        response.headers.get("content-type") || "application/octet-stream";
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }

      if (!recordsByUrl.has(record.finalUrl))
        recordsByUrl.set(record.finalUrl, record);
      record.localPath = allocateLocalPath(record.finalUrl, record.contentType);
      record.absolutePath = path.join(rootDir, record.localPath);
      record.body = Buffer.from(await response.arrayBuffer());
      record.contentLength = record.body.length;
      record.contentSha256 = sha256(record.body);
      record.kind = contentKind(record.contentType, record.finalUrl);

      if (record.kind !== "binary") {
        const source = record.body.toString("utf8");
        const rewrite = (dependencyUrl) => dependencyUrl;
        let result;
        if (record.kind === "html") {
          result = await processHtml(source, record.finalUrl, rewrite, {
            discoverNavigation: true,
          });
        }
        if (record.kind === "css")
          result = await processCss(source, record.finalUrl, rewrite);
        if (record.kind === "javascript")
          result = await processJavaScript(source, record.finalUrl, rewrite);
        for (const dependency of result.dependencies) enqueue(dependency, url);
        for (const navigation of result.navigationDependencies || []) {
          enqueueNavigation(navigation, url);
        }
      }

      const sourceOwner = sourceContentOwners.get(record.contentSha256);
      if (sourceOwner) record.sourceDuplicateOf = sourceOwner.originalUrl;
      else sourceContentOwners.set(record.contentSha256, record);

      record.status = "downloaded";
      summary.downloaded += 1;
      log(`[${response.status}] ${url}`);
    } catch (error) {
      if (error instanceof ExcludedUrlError) {
        exclude(error.excludedUrl);
        record.status = "excluded";
        record.finalUrl = error.excludedUrl;
        log(`[EXCLUDED REDIRECT] ${url} -> ${error.excludedUrl}`);
        return;
      }
      record.status = "failed";
      record.error = error.message;
      summary.failed += 1;
      log(`[FAILED] ${url}: ${error.message}`);
    }
  }

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      processJob(job).finally(() => {
        active -= 1;
        pump();
      });
    }
    if (started && active === 0 && queue.length === 0) resolveComplete();
  }

  for (const entry of entries) enqueue(entry.href, null, true);
  started = true;
  pump();
  await complete;

  if (logOnly) {
    const contents = [...visitedUrls].map((url) => `${url}\n`).join("");
    await fs.writeFile(visitedLogPath, contents);
    const result = {
      rootDir,
      manifestPath: null,
      visitedLogPath,
      summary,
      manifest: null,
    };
    throwIfEntryFailed(records, result);
    return result;
  }

  const queryPageGroups = new Map();
  for (const record of records) {
    if (record.status !== "downloaded" || record.kind !== "html") continue;
    const url = new URL(record.finalUrl);
    const key = `${url.origin}${url.pathname}`;
    const group = queryPageGroups.get(key) || [];
    group.push(record);
    queryPageGroups.set(key, group);
  }

  const genericQueryPagesByPath = new Map();
  for (const group of queryPageGroups.values()) {
    const queryVariants = group.filter(
      (record) => new URL(record.finalUrl).search,
    );
    if (!queryVariants.some((record) => record.isEntry)) continue;
    if (new Set(group.map((record) => record.contentSha256)).size !== 1)
      continue;

    const owner = group[0];
    const pathSource =
      group.find((record) => !new URL(record.finalUrl).search) || owner;
    const genericUrl = new URL(pathSource.finalUrl);
    genericUrl.search = "";
    const genericPath = localPathForUrl(genericUrl, owner.contentType);
    const genericPathKey = genericPath
      .split(path.sep)
      .join("/")
      .toLowerCase();
    const groupPathKeys = new Set(
      group.map((record) =>
        record.localPath.split(path.sep).join("/").toLowerCase(),
      ),
    );
    if (claimedPaths.has(genericPathKey) && !groupPathKeys.has(genericPathKey))
      continue;

    claimedPaths.add(genericPathKey);
    for (const record of group) {
      record.localPath = genericPath;
      record.absolutePath = path.join(rootDir, genericPath);
      record.genericQueryPage = true;
      record.genericQueryOwner = owner;
      record.queryCanonicalOf = owner.originalUrl;
    }
    genericQueryPagesByPath.set(
      `${genericUrl.origin}${genericUrl.pathname}`,
      owner,
    );
  }

  for (const record of records) {
    if (record.status !== "downloaded") continue;
    if (record.genericQueryOwner && record.genericQueryOwner !== record) {
      record.outputBody = record.genericQueryOwner.outputBody;
      record.outputSha256 = record.genericQueryOwner.outputSha256;
      continue;
    }
    let outputBody = record.body;
    if (record.kind !== "binary") {
      const source = record.body.toString("utf8");
      const rewriteTarget = (dependencyUrl, allowGenericQueryPage = false) => {
        let normalized;
        try {
          normalized = normalizeUrl(dependencyUrl);
        } catch {
          return dependencyUrl;
        }
        const url = new URL(normalized);
        if (url.origin !== crawlOrigin) return dependencyUrl;
        let target = recordsByUrl.get(normalized);
        if (
          (!target || target.status !== "downloaded") &&
          allowGenericQueryPage &&
          url.search
        ) {
          target = genericQueryPagesByPath.get(`${url.origin}${url.pathname}`);
        }
        if (!target?.localPath || target.status !== "downloaded")
          return dependencyUrl;
        const query = target.genericQueryPage
          ? ""
          : url.search;
        return `${relativeReference(record.localPath, target.localPath)}${query}`;
      };
      const rewrite = (dependencyUrl) => rewriteTarget(dependencyUrl);
      const rewriteNavigation = (dependencyUrl) =>
        rewriteTarget(dependencyUrl, true);
      let result;
      if (record.kind === "html") {
        result = await processHtml(source, record.finalUrl, rewrite, {
          rewriteNavigation,
        });
      }
      if (record.kind === "css")
        result = await processCss(source, record.finalUrl, rewrite);
      if (record.kind === "javascript") {
        result = await processJavaScript(source, record.finalUrl, rewrite);
      }
      outputBody = Buffer.from(result.content);
    }
    record.outputBody = outputBody;
    record.outputSha256 = sha256(outputBody);
  }

  const outputOwners = new Map();
  for (const record of records) {
    if (record.status !== "downloaded") continue;
    const owner = outputOwners.get(record.outputSha256);
    if (owner) {
      record.duplicateOf = owner.originalUrl;
      summary.deduplicated += 1;
    } else {
      outputOwners.set(record.outputSha256, record);
    }

    if (owner?.absolutePath === record.absolutePath) {
      log(`[DEDUPED] ${record.localPath.split(path.sep).join("/")}`);
      continue;
    }

    await fs.mkdir(path.dirname(record.absolutePath), { recursive: true });
    await unlinkIfExists(record.absolutePath);
    if (!owner) {
      await fs.writeFile(record.absolutePath, record.outputBody);
    } else {
      try {
        await fs.link(owner.absolutePath, record.absolutePath);
      } catch {
        await fs.writeFile(record.absolutePath, record.outputBody);
      }
    }
    log(`[SAVED] ${record.localPath.split(path.sep).join("/")}`);
  }

  const manifest = {
    version: 2,
    entryUrl: entries[0].href,
    entryUrls: entries.map((entry) => entry.href),
    origin: crawlOrigin,
    createdAt: new Date().toISOString(),
    summary,
    excludePatterns: exclusionPatterns.map(({ pattern }) => pattern),
    externalUrls: [...externalUrls],
    excludedUrls: [...excludedUrls],
    ignoredNavigationUrls: [...ignoredNavigationUrls],
    resources: records.map(publicRecord),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = {
    rootDir,
    manifestPath,
    visitedLogPath: null,
    summary,
    manifest,
  };
  throwIfEntryFailed(records, result);
  return result;
}
