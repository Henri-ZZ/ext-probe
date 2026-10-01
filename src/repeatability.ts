import { writeFile } from "node:fs/promises";
import path from "node:path";
import { argValue, DEFAULT_TOP_N, pause, positiveInt, runProbe, type ProbeAdapter } from "./lib.js";

const keyword = argValue("keyword");
const locale = argValue("locale", "en")!;
const repeats = Math.min(5, positiveInt(argValue("repeats"), 3));
const topN = positiveInt(argValue("top-n"), DEFAULT_TOP_N);
const delayMs = positiveInt(argValue("delay-ms"), 8000);
const adapter = argValue("adapter", "http") as ProbeAdapter;
if (!['http', 'browser'].includes(adapter)) throw new Error('--adapter must be "http" or "browser".');
if (!keyword) throw new Error('Pass --keyword, for example: npm run repeat -- --keyword "page editor" --locale en');

const results = [];
for (let index = 0; index < repeats; index += 1) {
  if (index > 0) await pause(delayMs);
  console.error(`Repeat ${index + 1}/${repeats}...`);
  const result = await runProbe(keyword, locale, process.cwd(), topN, adapter);
  results.push(result);
  if (result.stopRecommended) break;
}
const topLists = results.map((result) => result.parsedSerp?.slice(0, topN).map((item) => item.extensionId) ?? null);
const comparable = topLists.length === repeats && topLists.every((list) => list !== null);
const identical = comparable && topLists.slice(1).every((list) => JSON.stringify(list) === JSON.stringify(topLists[0]));
const summary = { keyword, locale, adapter, requestedRepeats: repeats, completedRepeats: results.length, topN, comparable, identical: comparable ? identical : null, topLists, results };
console.log(JSON.stringify(summary, null, 2));
await writeFile(path.join(process.cwd(), "data", "results", `repeatability-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(summary, null, 2)}\n`);
