import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectHttpRanking } from "./adapters/http.js";
import { DEFAULT_TOP_N, TARGET_EXTENSION_ID } from "./config.js";
import { inspectIdContext } from "./parser.js";
import type { PageClassification, ProbeResult } from "./types.js";

export const EDIT_PAGE_ID = TARGET_EXTENSION_ID;
export { DEFAULT_TOP_N };
export type ProbeAdapter = "http" | "browser";

function classify(status: number, html: string): PageClassification {
  const sample = html.slice(0, 200_000).toLowerCase();
  if (status === 429) return "rate-limited";
  if (status < 200 || status >= 300) return "http-error";
  if (/recaptcha|g-recaptcha|captcha/.test(sample)) return "captcha";
  if (/consent\.google|before you continue to google|consent form/.test(sample)) return "consent";
  if (/chrome web store|chromewebstore/.test(sample)) return "normal";
  return "unexpected";
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "query";
}

export async function runProbe(keyword: string, locale: string, rootDir = process.cwd(), topN = DEFAULT_TOP_N, adapter: ProbeAdapter = "http"): Promise<ProbeResult> {
  const url = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;
  const started = performance.now();
  const collection = adapter === "browser"
    ? await import("./adapters/browser.js").then(({ collectBrowserRanking }) => collectBrowserRanking(keyword, locale, topN))
    : await collectHttpRanking(keyword, locale, topN);

  const elapsedMs = Math.round(performance.now() - started);
  const bytes = Buffer.byteLength(collection.html);
  const pageClassification = classify(collection.status, collection.html);
  const stopRecommended = pageClassification !== "normal";
  const parsed = stopRecommended
    ? { items: null, reliable: false, strategy: null, diagnostics: [`Parser skipped because page classification is ${pageClassification}.`] }
    : collection;
  const rawIds = parsed.items?.map((item) => item.extensionId) ?? [];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `${stamp}__${safeName(keyword)}__${safeName(locale)}`;
  const debugDir = path.join(rootDir, "data", "debug");
  const resultsDir = path.join(rootDir, "data", "results");
  await mkdir(debugDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  const htmlPath = path.join(debugDir, `${stem}.html`);
  const contextPath = path.join(debugDir, `${stem}.edit-page-context.txt`);
  const screenshotPath = path.join(debugDir, `${stem}.png`);
  const paginationPath = path.join(debugDir, `${stem}.pagination.json`);
  const jsonPath = path.join(resultsDir, `${stem}.json`);
  await writeFile(htmlPath, collection.html);
  await writeFile(contextPath, inspectIdContext(collection.html, EDIT_PAGE_ID).join("\n\n--- occurrence ---\n\n"));
  if (collection.screenshot) await writeFile(screenshotPath, collection.screenshot);
  if (collection.paginationResponses) await writeFile(paginationPath, `${JSON.stringify(collection.paginationResponses, null, 2)}\n`);

  const editPageRank = parsed.reliable && parsed.items
    ? parsed.items.find((item) => item.extensionId === EDIT_PAGE_ID)?.position ?? null
    : null;
  const collectedCount = parsed.reliable ? parsed.items?.length ?? 0 : 0;
  const complete = parsed.reliable && (collectedCount >= topN || collection.endOfResults);
  const relative = (file: string) => path.relative(rootDir, file);
  const artifacts: ProbeResult["artifacts"] = { html: relative(htmlPath), json: relative(jsonPath) };
  if (collection.screenshot) artifacts.screenshot = relative(screenshotPath);
  if (collection.paginationResponses) artifacts.pagination = relative(paginationPath);
  const result: ProbeResult = {
    requestedAt: new Date().toISOString(), keyword, locale, url, status: collection.status, bytes, elapsedMs,
    pageClassification, stopRecommended, containsEditPage: rawIds.includes(EDIT_PAGE_ID), rawIds, rawIdCount: rawIds.length,
    parsedSerp: parsed.reliable ? parsed.items : null,
    parser: { reliable: parsed.reliable, strategy: parsed.strategy, diagnostics: [...parsed.diagnostics, `Edit Page contexts: ${relative(contextPath)}`] },
    editPageRank,
    requestedTopN: topN,
    collectedCount,
    loadedBatches: collection.loadedBatches,
    collectionMode: adapter === "browser" ? "browser-load-more" : "http-pagination",
    complete,
    notFoundWithin: complete && editPageRank === null ? Math.min(topN, collectedCount) : null,
    endOfResults: collection.endOfResults,
    artifacts,
  };
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function printResult(result: ProbeResult): void {
  console.log(JSON.stringify({
    keyword: result.keyword, locale: result.locale, status: result.status, bytes: result.bytes,
    elapsedMs: result.elapsedMs, pageClassification: result.pageClassification,
    containsEditPage: result.containsEditPage, rawIdCount: result.rawIdCount,
    rawIds: result.rawIds, parsedSerpCount: result.parsedSerp?.length ?? 0,
    parserReliable: result.parser.reliable, parserStrategy: result.parser.strategy,
    requestedTopN: result.requestedTopN, collectedCount: result.collectedCount,
    loadedBatches: result.loadedBatches, collectionMode: result.collectionMode,
    complete: result.complete, endOfResults: result.endOfResults,
    editPageRank: result.editPageRank ?? (result.complete ? "NR" : "unknown"),
    notFoundWithin: result.notFoundWithin,
    diagnostics: result.parser.diagnostics, artifacts: result.artifacts,
  }, null, 2));
}

export function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export { positiveInt } from "./config.js";

export async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
