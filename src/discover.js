import * as cheerio from "cheerio";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { init, parse } from "es-module-lexer";

const HTML_ATTRIBUTES = [
  ["script[src]", "src"],
  ["link[rel~='stylesheet'][href]", "href"],
  ["link[rel~='modulepreload'][href]", "href"],
  ["link[rel~='preload'][href]", "href"],
  ["link[rel~='icon'][href]", "href"],
  ["img[src]", "src"],
  ["source[src]", "src"],
  ["video[poster]", "poster"],
];

const JAVASCRIPT_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

const HTML_NAVIGATION_ATTRIBUTES = [
  ["a[href]", "href"],
  ["area[href]", "href"],
];

function resolveReference(raw, baseUrl) {
  if (!raw || raw.startsWith("#")) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function rewriteResolvedReference(raw, baseUrl, resolved, rewrite) {
  const replacement = rewrite(resolved);
  if (!replacement) return replacement;
  const fragment = new URL(raw, baseUrl).hash;
  if (!fragment) return replacement;
  try {
    if (new URL(replacement, baseUrl).hash === fragment) return replacement;
  } catch {
    // Preserve the fragment on nonstandard rewrite values as well.
  }
  return `${replacement}${fragment}`;
}

function decodeJavaScriptString(raw) {
  return raw.replace(
    /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|.)/gs,
    (_, escape, codePoint, unicode, hex, character) => {
      if (codePoint)
        return String.fromCodePoint(Number.parseInt(codePoint, 16));
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (escape === "\n" || escape === "\r\n") return "";
      const simple = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        0: "\0",
      };
      return simple[character] ?? character;
    },
  );
}

function escapeJavaScriptString(value, quote) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

function findJavaScriptUrlLiterals(source) {
  const string = (quoteGroup = 1) =>
    `(["'])((?:\\\\[\\s\\S]|(?!\\${quoteGroup})[^\\\\\\r\\n])*)\\${quoteGroup}`;
  const patterns = [
    new RegExp(String.raw`\bfetch\s*\(\s*${string()}`, "g"),
    new RegExp(String.raw`\baxios\s*\.\s*get\s*\(\s*${string()}`, "g"),
    new RegExp(
      String.raw`\bnew\s+(?:Worker|SharedWorker|URL)\s*\(\s*${string()}`,
      "g",
    ),
  ];
  const literals = [];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[2];
      const rawOffset = match[0].lastIndexOf(raw);
      literals.push({
        start: match.index + rawOffset,
        end: match.index + rawOffset + raw.length,
        quote: match[1],
        raw,
      });
    }
  }

  const openPattern = new RegExp(
    String.raw`\.\s*open\s*\(\s*${string()}\s*,\s*${string(3)}`,
    "g",
  );
  for (const match of source.matchAll(openPattern)) {
    if (!/^(?:GET|HEAD)$/i.test(decodeJavaScriptString(match[2]))) continue;
    const raw = match[4];
    const rawOffset = match[0].lastIndexOf(raw);
    literals.push({
      start: match.index + rawOffset,
      end: match.index + rawOffset + raw.length,
      quote: match[3],
      raw,
    });
  }

  return literals;
}

function rewriteSrcset(value, baseUrl, addReference) {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return trimmed;
      const match = trimmed.match(/^(\S+)(\s+.*)?$/);
      if (!match) return trimmed;
      const replacement = addReference(match[1], baseUrl);
      return `${replacement ?? match[1]}${match[2] ?? ""}`;
    })
    .join(", ");
}

export async function processHtml(source, responseUrl, rewrite, options = {}) {
  const $ = cheerio.load(source, { decodeEntities: false });
  const baseHref = $("base[href]").first().attr("href");
  const baseUrl = baseHref ? new URL(baseHref, responseUrl).href : responseUrl;
  const dependencies = [];
  const add = (raw, base = baseUrl) => {
    const resolved = resolveReference(raw, base);
    if (!resolved) return null;
    dependencies.push(resolved);
    return rewriteResolvedReference(raw, base, resolved, rewrite);
  };

  for (const [selector, attribute] of HTML_ATTRIBUTES) {
    $(selector).each((_, element) => {
      const raw = $(element).attr(attribute);
      const replacement = add(raw);
      if (replacement) $(element).attr(attribute, replacement);
    });
  }

  $("[srcset]").each((_, element) => {
    $(element).attr(
      "srcset",
      rewriteSrcset($(element).attr("srcset"), baseUrl, add),
    );
  });

  $("[style]").each((_, element) => {
    const result = processCssValue($(element).attr("style"), baseUrl, add);
    $(element).attr("style", result);
  });

  for (const element of $("style").toArray()) {
    const result = await processCss($(element).html() || "", baseUrl, rewrite);
    $(element).html(result.content);
    dependencies.push(...result.dependencies);
  }

  for (const element of $("script:not([src])").toArray()) {
    const type = ($(element).attr("type") || "").trim().toLowerCase();
    if (!JAVASCRIPT_SCRIPT_TYPES.has(type)) continue;
    const result = await processJavaScript(
      $(element).html() || "",
      baseUrl,
      rewrite,
    );
    $(element).html(result.content);
    dependencies.push(...result.dependencies);
  }

  const rewriteNavigation = options.rewriteNavigation;
  if (options.discoverNavigation || rewriteNavigation) {
    for (const [selector, attribute] of HTML_NAVIGATION_ATTRIBUTES) {
      $(selector).each((_, element) => {
        const raw = $(element).attr(attribute);
        const resolved = resolveReference(raw, baseUrl);
        if (!resolved) return;
        if (options.discoverNavigation) dependencies.push(resolved);
        if (!rewriteNavigation) return;
        const replacement = rewriteResolvedReference(
          raw,
          baseUrl,
          resolved,
          (url) => rewriteNavigation(url, raw),
        );
        if (replacement) $(element).attr(attribute, replacement);
      });
    }
  }

  if (rewriteNavigation) {
    $("form[action]").each((_, element) => {
      const raw = $(element).attr("action");
      const resolved = resolveReference(raw, baseUrl);
      if (!resolved) return;
      const replacement = rewriteResolvedReference(
        raw,
        baseUrl,
        resolved,
        (url) => rewriteNavigation(url, raw),
      );
      if (replacement) $(element).attr("action", replacement);
    });
  }

  $("base").remove();
  return { content: $.html(), dependencies: [...new Set(dependencies)] };
}

function processCssValue(value, baseUrl, addReference) {
  const parsed = valueParser(value || "");
  parsed.walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const raw = valueParser
      .stringify(node.nodes)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    const replacement = addReference(raw, baseUrl);
    if (replacement) {
      node.nodes = [{ type: "string", quote: '"', value: replacement }];
    }
  });
  return parsed.toString();
}

export async function processCss(source, responseUrl, rewrite) {
  const dependencies = [];
  const add = (raw) => {
    const resolved = resolveReference(raw, responseUrl);
    if (!resolved) return null;
    dependencies.push(resolved);
    return rewriteResolvedReference(raw, responseUrl, resolved, rewrite);
  };
  let root;
  try {
    root = postcss.parse(source, { from: responseUrl });
  } catch {
    return { content: source, dependencies: [] };
  }

  root.walkAtRules("import", (rule) => {
    const parsed = valueParser(rule.params);
    const first = parsed.nodes[0];
    let raw;
    if (first?.type === "string") raw = first.value;
    if (first?.type === "function" && first.value.toLowerCase() === "url") {
      raw = valueParser
        .stringify(first.nodes)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
    }
    const replacement = add(raw);
    if (!replacement) return;
    if (first.type === "string") first.value = replacement;
    else first.nodes = [{ type: "string", quote: '"', value: replacement }];
    rule.params = parsed.toString();
  });

  root.walkDecls((declaration) => {
    declaration.value = processCssValue(declaration.value, responseUrl, add);
  });

  return { content: root.toString(), dependencies: [...new Set(dependencies)] };
}

export async function processJavaScript(source, responseUrl, rewrite) {
  await init;
  let imports;
  try {
    [imports] = parse(source);
  } catch {
    return { content: source, dependencies: [] };
  }

  const dependencies = [];
  const edits = [];
  for (const item of imports) {
    if (!item.n) continue;
    const resolved = resolveReference(item.n, responseUrl);
    if (!resolved) continue;
    dependencies.push(resolved);
    edits.push({
      start: item.s,
      end: item.e,
      value: rewriteResolvedReference(item.n, responseUrl, resolved, rewrite),
    });
  }

  const occupied = edits.map(({ start, end }) => ({ start, end }));
  for (const literal of findJavaScriptUrlLiterals(source)) {
    if (
      occupied.some(
        ({ start, end }) => literal.start < end && literal.end > start,
      )
    )
      continue;
    const raw = decodeJavaScriptString(literal.raw);
    const resolved = resolveReference(raw, responseUrl);
    if (!resolved) continue;
    dependencies.push(resolved);
    edits.push({
      start: literal.start,
      end: literal.end,
      value: escapeJavaScriptString(
        rewriteResolvedReference(raw, responseUrl, resolved, rewrite),
        literal.quote,
      ),
    });
  }

  const sourceMapPattern = /([#@]\s*sourceMappingURL=)([^\s*]+)/g;
  for (const match of source.matchAll(sourceMapPattern)) {
    const resolved = resolveReference(match[2], responseUrl);
    if (!resolved) continue;
    dependencies.push(resolved);
    const start = match.index + match[1].length;
    edits.push({
      start,
      end: start + match[2].length,
      value: rewriteResolvedReference(match[2], responseUrl, resolved, rewrite),
    });
  }

  edits.sort((a, b) => b.start - a.start);
  let content = source;
  for (const edit of edits) {
    content =
      content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  }
  return { content, dependencies: [...new Set(dependencies)] };
}
