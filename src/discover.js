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
  ["video[poster]", "poster"]
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

function rewriteSrcset(value, baseUrl, addReference) {
  return value.split(",").map((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed) return trimmed;
    const match = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!match) return trimmed;
    const replacement = addReference(match[1], baseUrl);
    return `${replacement ?? match[1]}${match[2] ?? ""}`;
  }).join(", ");
}

export async function processHtml(source, responseUrl, rewrite) {
  const $ = cheerio.load(source, { decodeEntities: false });
  const baseHref = $("base[href]").first().attr("href");
  const baseUrl = baseHref ? new URL(baseHref, responseUrl).href : responseUrl;
  const dependencies = [];
  const add = (raw, base = baseUrl) => {
    const resolved = resolveReference(raw, base);
    if (!resolved) return null;
    dependencies.push(resolved);
    return rewrite(resolved);
  };

  for (const [selector, attribute] of HTML_ATTRIBUTES) {
    $(selector).each((_, element) => {
      const raw = $(element).attr(attribute);
      const replacement = add(raw);
      if (replacement) $(element).attr(attribute, replacement);
    });
  }

  $("[srcset]").each((_, element) => {
    $(element).attr("srcset", rewriteSrcset($(element).attr("srcset"), baseUrl, add));
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

  for (const element of $("script[type='module']:not([src])").toArray()) {
    const result = await processJavaScript($(element).html() || "", baseUrl, rewrite);
    $(element).html(result.content);
    dependencies.push(...result.dependencies);
  }

  $("base").remove();
  return { content: $.html(), dependencies: [...new Set(dependencies)] };
}

function processCssValue(value, baseUrl, addReference) {
  const parsed = valueParser(value || "");
  parsed.walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const raw = valueParser.stringify(node.nodes).trim().replace(/^(['"])(.*)\1$/, "$2");
    const replacement = addReference(raw, baseUrl);
    if (replacement) {
      node.nodes = [{ type: "string", quote: "\"", value: replacement }];
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
    return rewrite(resolved);
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
      raw = valueParser.stringify(first.nodes).trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    const replacement = add(raw);
    if (!replacement) return;
    if (first.type === "string") first.value = replacement;
    else first.nodes = [{ type: "string", quote: "\"", value: replacement }];
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
    edits.push({ start: item.s, end: item.e, value: rewrite(resolved) });
  }

  const sourceMapPattern = /([#@]\s*sourceMappingURL=)([^\s*]+)/g;
  for (const match of source.matchAll(sourceMapPattern)) {
    const resolved = resolveReference(match[2], responseUrl);
    if (!resolved) continue;
    dependencies.push(resolved);
    const start = match.index + match[1].length;
    edits.push({ start, end: start + match[2].length, value: rewrite(resolved) });
  }

  edits.sort((a, b) => b.start - a.start);
  let content = source;
  for (const edit of edits) {
    content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  }
  return { content, dependencies: [...new Set(dependencies)] };
}
