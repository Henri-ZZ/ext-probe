import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_KEYWORDS } from "./config.js";
import { argValue, DEFAULT_TOP_N, pause, positiveInt, runProbe, type ProbeAdapter } from "./lib.js";
import type { ProbeResult } from "./types.js";

const KEYWORDS = DEFAULT_KEYWORDS;
const locales = (argValue("locales", "en,zh_CN") ?? "en,zh_CN").split(",").map((value) => value.trim()).filter(Boolean);
const delayMs = positiveInt(argValue("delay-ms"), 5000);
const topN = positiveInt(argValue("top-n"), DEFAULT_TOP_N);
const adapter = argValue("adapter", "http") as ProbeAdapter;
if (!['http', 'browser'].includes(adapter)) throw new Error('--adapter must be "http" or "browser".');
const results: ProbeResult[] = [];

for (const locale of locales) {
  for (const keyword of KEYWORDS) {
    if (results.length > 0) await pause(delayMs);
    console.error(`Probing ${JSON.stringify(keyword)} (${locale})...`);
    const result = await runProbe(keyword, locale, process.cwd(), topN, adapter);
    results.push(result);
    if (result.stopRecommended) {
      console.error(`Stopping: received ${result.pageClassification}; raw artifacts were saved.`);
      break;
    }
  }
  if (results.at(-1)?.stopRecommended) break;
}

const matrix = KEYWORDS.map((keyword) => ({
  keyword,
  ...Object.fromEntries(locales.map((locale) => {
    const result = results.find((item) => item.keyword === keyword && item.locale === locale);
    const rank = !result ? "not-run" : result.editPageRank ?? (result.complete ? "NR" : "unknown");
    return [locale, rank];
  })),
}));
console.table(matrix);
await writeFile(path.join(process.cwd(), "data", "results", `matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ delayMs, topN, adapter, results, matrix }, null, 2)}\n`);
