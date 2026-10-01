import { chromium } from "playwright-core";
import { parseOrderedSerp } from "../parser.js";
import type { CollectionResult } from "./types.js";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function languageHeader(locale: string): string {
  const normalized = locale.replace("_", "-");
  const base = normalized.split("-")[0];
  return base && base !== normalized ? `${normalized},${base};q=0.9,en;q=0.7` : `${normalized},en;q=0.8`;
}

export async function collectBrowserRanking(keyword: string, locale: string, topN: number): Promise<CollectionResult> {
  const url = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  let html = "";
  let status = 0;
  let loadedBatches = 0;
  let endOfResults = false;
  let screenshot: Buffer;

  try {
    const context = await browser.newContext({
      locale: locale.replace("_", "-"),
      userAgent: USER_AGENT,
      extraHTTPHeaders: { "Accept-Language": languageHeader(locale) },
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    status = response?.status() ?? 0;
    const cards = page.locator("[data-item-id]");
    await cards.first().waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForLoadState("load", { timeout: 15_000 });
    await page.getByRole("button", { name: /Load more|加载更多/i }).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

    while (await cards.count() < topN) {
      const previousCount = await cards.count();
      const loadMore = page.getByRole("button", { name: /Load more|加载更多/i });
      if (await loadMore.count() === 0 || !await loadMore.first().isVisible()) {
        endOfResults = true;
        break;
      }
      console.error(`Loading browser results ${previousCount + 1}-${Math.min(previousCount + 10, topN)}...`);
      await loadMore.first().click();
      await cards.nth(previousCount).waitFor({ state: "attached", timeout: 30_000 });
      loadedBatches += 1;
    }

    html = await page.content();
    screenshot = await page.screenshot({ fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }

  const parsed = parseOrderedSerp(html);
  return { status, html, ...parsed, loadedBatches, endOfResults, screenshot };
}
