import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseOrderedSerp } from "../src/parser.js";

const keyword = process.argv[2] ?? "web page editor";
const locale = process.argv[3] ?? "en";
const pageSize = Number(process.argv[4] ?? 10);
const headerMode = process.argv[5] ?? "minimal";
const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;
const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function extractToken(text: string): string {
  const decoded = text.replace(/\\u003d/gi, "=");
  const tokens = [...decoded.matchAll(/QVl4VEdC[A-Za-z0-9_+/=-]{20,}/g)].map((match) => match[0]);
  const token = tokens.at(-1);
  if (!token) throw new Error("No continuation token found.");
  return token;
}

function parseRpcResponse(text: string): { ids: string[]; token: string } {
  const lines = text.split("\n");
  let inner: unknown = null;
  for (const line of lines) {
    if (!line.startsWith("[[")) continue;
    try {
      const frame = JSON.parse(line) as unknown[][];
      if (frame[0]?.[0] === "wrb.fr" && frame[0]?.[1] === "zTyKYc" && typeof frame[0]?.[2] === "string") {
        inner = JSON.parse(frame[0][2] as string);
        break;
      }
    } catch {
      // Ignore framing lines that are not the RPC payload.
    }
  }
  if (!Array.isArray(inner)) throw new Error("No zTyKYc response payload found.");

  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "string" && /^[a-p]{32}$/.test(value[0])) ids.push(value[0]);
    for (const child of value) visit(child);
  };
  visit(inner);
  const token = (inner as unknown[])[2];
  const nextToken = Array.isArray(token) && typeof token[0] === "string" ? token[0].replace(/\\u003d/gi, "=") : null;
  if (!nextToken) throw new Error("No next continuation token found in RPC response.");
  return { ids: [...new Set(ids)], token: nextToken };
}

function rpcBody(token: string): string {
  const payload = [[null, [null, null, null, [keyword, [pageSize, token]]]]];
  const request = [[[("zTyKYc"), JSON.stringify(payload), null, "generic"]]];
  return `${new URLSearchParams({ "f.req": JSON.stringify(request) })}&`;
}

const initialResponse = await fetch(searchUrl, {
  headers: { "User-Agent": userAgent, "Accept-Language": locale.replace("_", "-") },
  redirect: "follow",
});
const initialHtml = await initialResponse.text();
const parsed = parseOrderedSerp(initialHtml);
if (!parsed.reliable || !parsed.items) throw new Error(`Initial page parsing failed: ${parsed.diagnostics.join(" ")}`);

const ids = parsed.items.map((item) => item.extensionId);
let token = extractToken(initialHtml);
const pages: Array<{ status: number; ids: string[]; requestToken: string; responseToken: string; setCookie: boolean }> = [];

for (let pageNumber = 1; ids.length < 50; pageNumber += 1) {
  const params = new URLSearchParams({
    rpcids: "zTyKYc",
    "source-path": `/search/${encodeURIComponent(keyword)}`,
    hl: locale,
    rt: "c",
  });
  const response = await fetch(`https://chromewebstore.google.com/_/ChromeWebStoreConsumerFeUi/data/batchexecute?${params}`, {
    method: "POST",
    headers: headerMode === "bare"
      ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }
      : {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Origin: "https://chromewebstore.google.com",
          Referer: "https://chromewebstore.google.com/",
          "User-Agent": userAgent,
          "Accept-Language": locale.replace("_", "-"),
          "X-Same-Domain": "1",
        },
    body: rpcBody(token),
  });
  const text = await response.text();
  const page = parseRpcResponse(text);
  pages.push({ status: response.status, ids: page.ids, requestToken: token, responseToken: page.token, setCookie: Boolean(response.headers.get("set-cookie")) });
  ids.push(...page.ids);
  token = page.token;
  if (page.ids.length === 0 || pageNumber >= 10) break;
}

const report = {
  keyword,
  locale,
  pageSize,
  headerMode,
  initialStatus: initialResponse.status,
  initialSetCookieIgnored: Boolean(initialResponse.headers.get("set-cookie")),
  requestCookieSent: false,
  pageCount: pages.length,
  pages,
  ids,
};
const outputDir = path.join(process.cwd(), "data", "research");
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `pure-http-pagesize-${pageSize}-${new Date().toISOString().replace(/[:.]/g, "-")}__${keyword.replace(/\W+/g, "-")}__${locale}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, outputPath: path.relative(process.cwd(), outputPath) }, null, 2));
