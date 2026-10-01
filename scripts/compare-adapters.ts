import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectBrowserRanking } from "../src/adapters/browser.js";
import { collectHttpRanking } from "../src/adapters/http.js";
import { EDIT_PAGE_ID } from "../src/lib.js";

const keyword = process.argv[2] ?? "web page editor";
const locale = process.argv[3] ?? "en";
const topN = Number(process.argv[4] ?? 50);

console.error(`Browser ground truth: ${JSON.stringify(keyword)} / ${locale}`);
const browser = await collectBrowserRanking(keyword, locale, topN);
console.error(`Pure HTTP: ${JSON.stringify(keyword)} / ${locale}`);
const http = await collectHttpRanking(keyword, locale, topN);
const browserIds = browser.items?.map((item) => item.extensionId) ?? [];
const httpIds = http.items?.map((item) => item.extensionId) ?? [];
const differences = Array.from({ length: Math.max(browserIds.length, httpIds.length) }, (_, index) => ({
  position: index + 1,
  browser: browserIds[index] ?? null,
  http: httpIds[index] ?? null,
})).filter((item) => item.browser !== item.http);
const report = {
  comparedAt: new Date().toISOString(),
  keyword,
  locale,
  topN,
  browserReliable: browser.reliable,
  httpReliable: http.reliable,
  browserCount: browserIds.length,
  httpCount: httpIds.length,
  identical: differences.length === 0 && browserIds.length === topN && httpIds.length === topN,
  matchingPositions: topN - differences.length,
  browserEditPageRank: browserIds.indexOf(EDIT_PAGE_ID) >= 0 ? browserIds.indexOf(EDIT_PAGE_ID) + 1 : null,
  httpEditPageRank: httpIds.indexOf(EDIT_PAGE_ID) >= 0 ? httpIds.indexOf(EDIT_PAGE_ID) + 1 : null,
  browserLoadedBatches: browser.loadedBatches,
  httpLoadedBatches: http.loadedBatches,
  differences,
  browserIds,
  httpIds,
};
const outputDir = path.join(process.cwd(), "data", "research");
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `adapter-comparison-${new Date().toISOString().replace(/[:.]/g, "-")}__${keyword.replace(/\W+/g, "-")}__${locale}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, browserIds: undefined, httpIds: undefined, outputPath: path.relative(process.cwd(), outputPath) }, null, 2));
if (!report.identical) process.exitCode = 2;
