import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Request } from "playwright-core";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const keyword = process.argv[2] ?? "web page editor";
const locale = process.argv[3] ?? "en";
const url = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;
const outputDir = path.join(process.cwd(), "data", "research", `${new Date().toISOString().replace(/[:.]/g, "-")}__${keyword.replace(/\W+/g, "-")}__${locale}`);

type CapturedRequest = {
  batch: number;
  resourceType: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  cookiePresent: boolean;
  postData: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBodyFile: string | null;
  responseBodyError?: string;
};

function sanitized(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !["cookie", "set-cookie", "authorization"].includes(name.toLowerCase())));
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const context = await browser.newContext({ locale: locale.replace("_", "-"), viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const captured: CapturedRequest[] = [];
const pending = new Set<Promise<void>>();
const requestBatches = new WeakMap<Request, number>();
let batch = 0;

page.on("request", (request: Request) => {
  if (batch > 0 && ["fetch", "xhr"].includes(request.resourceType())) requestBatches.set(request, batch);
});

page.on("requestfinished", (request: Request) => {
  const activeBatch = requestBatches.get(request);
  if (!activeBatch) return;
  const work = (async () => {
    const response = await request.response();
    const requestHeaders = await request.allHeaders();
    const item: CapturedRequest = {
      batch: activeBatch,
      resourceType: request.resourceType(),
      url: request.url(),
      method: request.method(),
      headers: sanitized(requestHeaders),
      cookiePresent: Boolean(requestHeaders.cookie),
      postData: request.postData(),
      responseStatus: response?.status() ?? null,
      responseHeaders: response ? sanitized(await response.allHeaders()) : {},
      responseBodyFile: null,
    };
    if (response) {
      try {
        const body = await response.body();
        const filename = `batch-${activeBatch}__response-${captured.length + 1}.bin`;
        await writeFile(path.join(outputDir, filename), body);
        item.responseBodyFile = filename;
      } catch (error) {
        item.responseBodyError = error instanceof Error ? error.message : String(error);
      }
    }
    captured.push(item);
  })();
  pending.add(work);
  void work.finally(() => pending.delete(work));
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const cards = page.locator("[data-item-id]");
  await cards.first().waitFor({ state: "attached", timeout: 15_000 });
  await page.waitForLoadState("load", { timeout: 15_000 });
  await page.getByRole("button", { name: /Load more|加载更多/i }).first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(2_000);

  for (batch = 1; batch <= 4; batch += 1) {
    const previousCount = await cards.count();
    const loadMore = page.getByRole("button", { name: /Load more|加载更多/i }).first();
    await loadMore.click();
    await cards.nth(previousCount).waitFor({ state: "attached", timeout: 30_000 });
    console.error(`batch ${batch}: ${previousCount} -> ${await cards.count()}`);
  }

  await page.waitForTimeout(1_000);
} finally {
  await Promise.allSettled([...pending]);
  const ids = await page.locator("[data-item-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-item-id"))).catch(() => []);
  await writeFile(path.join(outputDir, "final-ids.json"), `${JSON.stringify(ids, null, 2)}\n`);
  await writeFile(path.join(outputDir, "network.json"), `${JSON.stringify({ keyword, locale, url, requests: captured.sort((a, b) => a.batch - b.batch) }, null, 2)}\n`);
  console.log(outputDir);
  await context.close();
  await browser.close();
}
