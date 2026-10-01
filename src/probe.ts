import { argValue, DEFAULT_TOP_N, positiveInt, printResult, runProbe, type ProbeAdapter } from "./lib.js";

const keyword = argValue("keyword");
const locale = argValue("locale", "en")!;
const topN = positiveInt(argValue("top-n"), DEFAULT_TOP_N);
const adapter = argValue("adapter", "http") as ProbeAdapter;
if (!['http', 'browser'].includes(adapter)) throw new Error('--adapter must be "http" or "browser".');
if (!keyword) {
  console.error('Usage: npm run probe -- --keyword "page editor" --locale en');
  process.exitCode = 1;
} else {
  const result = await runProbe(keyword, locale, process.cwd(), topN, adapter);
  printResult(result);
  if (result.stopRecommended) process.exitCode = 2;
}
