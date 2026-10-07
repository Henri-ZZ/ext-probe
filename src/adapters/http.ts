import { parseOrderedSerp } from "../parser.js";
import type { SerpItem } from "../types.js";
import type { CollectionResult } from "./types.js";

const PAGE_SIZE = 10;

export function extractInitialToken(html: string): string | null {
  const decoded = html.replace(/\\u003d/gi, "=");
  const tokens = [...decoded.matchAll(/QVl4VEdC[A-Za-z0-9_+/=-]{20,}/g)].map((match) => match[0]);
  return tokens.at(-1) ?? null;
}

export function parseRpcResponse(text: string): { ids: string[]; token: string | null } {
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
      // Ignore non-payload framing records.
    }
  }
  if (!Array.isArray(inner)) throw new Error("Pagination RPC did not return a zTyKYc payload.");

  const at = (value: unknown, index: number): unknown => Array.isArray(value) ? value[index] : undefined;
  let records: unknown = inner;
  for (const index of [0, 0, 0, 5, 0, 0]) records = at(records, index);
  if (!Array.isArray(records)) throw new Error("Pagination RPC result array is missing.");
  const ids = records.map((record) => at(at(at(record, 0), 0), 0));
  if (!ids.every((id): id is string => typeof id === "string" && /^[a-p]{32}$/.test(id))) {
    throw new Error("Pagination RPC result records do not contain valid extension IDs at the expected position.");
  }

  const tokenContainer = inner[2];
  const token = Array.isArray(tokenContainer) && typeof tokenContainer[0] === "string"
    ? tokenContainer[0].replace(/\\u003d/gi, "=")
    : null;
  return { ids: [...new Set(ids)], token };
}

function rpcBody(keyword: string, token: string | null): string {
  const payload = [[null, [null, null, null, [keyword, [PAGE_SIZE, token]]]]];
  const request = [[[("zTyKYc"), JSON.stringify(payload), null, "generic"]]];
  return `${new URLSearchParams({ "f.req": JSON.stringify(request) })}&`;
}

/**
 * 取一页搜索结果。`token` 传 null 时 RPC 会返回第 1 页加一个续传 token —— 这一点很
 * 关键：分页因此可以从 RPC 自举，不必依赖初始 HTML 里那个时有时无的 token。
 */
async function fetchPaginationPage(
  keyword: string,
  locale: string,
  token: string | null,
  responses: string[],
): Promise<{ ids: string[]; token: string | null }> {
  const params = new URLSearchParams({
    rpcids: "zTyKYc",
    "source-path": `/search/${encodeURIComponent(keyword)}`,
    hl: locale,
    rt: "c",
  });
  const response = await fetch(`https://chromewebstore.google.com/_/ChromeWebStoreConsumerFeUi/data/batchexecute?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: rpcBody(keyword, token),
  });
  const text = await response.text();
  responses.push(text);
  if (!response.ok) throw new Error(`Pagination RPC returned HTTP ${response.status}.`);
  return parseRpcResponse(text);
}

/**
 * 商店有时返回分类正常、却解析不出有序结果（一个扩展 ID 都没有）的 HTML，所以首页
 * 要重试。缺续传 token 的情况不在此列——那个由 RPC 自举兜住，见下面的说明。
 */
const INITIAL_ATTEMPTS = 5;

export async function collectHttpRanking(keyword: string, locale: string, topN: number): Promise<CollectionResult> {
  const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;

  let response: Response | undefined;
  let lastDiagnostics: string[] = [];
  let page: { html: string; items: SerpItem[]; diagnostics: string[]; token: string | null } | undefined;

  for (let attempt = 1; attempt <= INITIAL_ATTEMPTS; attempt += 1) {
    response = await fetch(searchUrl, { redirect: "follow" });
    const body = await response.text();
    const parsed = parseOrderedSerp(body);
    if (!parsed.reliable || !parsed.items) {
      lastDiagnostics = parsed.diagnostics;
      continue;
    }
    // 页面可用就收工。这里不再为「缺 token」而重抓：那个 token 时有时无，反复抓同一个
    // URL 往往还是拿不到，而翻页能力可以从 RPC 自举，没必要为此多传 500KB。
    page = { html: body, items: parsed.items, diagnostics: parsed.diagnostics, token: extractInitialToken(body) };
    break;
  }

  if (!page) {
    return {
      status: response?.status ?? 0,
      html: "",
      items: null,
      reliable: false,
      strategy: null,
      diagnostics: [
        ...lastDiagnostics,
        `No search page with an ordered result list after ${INITIAL_ATTEMPTS} attempts.`,
      ],
      loadedBatches: 0,
      endOfResults: false,
      paginationResponses: [],
    };
  }

  const html = page.html;
  let ids = page.items.map((item) => item.extensionId);
  const paginationResponses: string[] = [];
  const diagnostics = [...page.diagnostics];
  let token = page.token;
  let loadedBatches = 0;
  let endOfResults = false;
  // 首页只有 10 条而 topN 更大时就必须翻页，而翻页需要一个续传 token。这里保持
  // endOfResults 为 false，让拿不到 token 的情况判为「不可靠」而不是「结果集到头」：
  // 报一个假的「未进前 N」比报失败糟得多，前者会静默污染排名历史。
  let paginationUnavailable = false;

  // 初始 HTML 经常不带续传 token（实测 8 次里 7 次没有，而且它以「一批一批」的形式
  // 出现，短时间内重试同一个 URL 往往也拿不到）。但用空 token 调一次 RPC 会返回第 1 页
  // 加一个可用的续传 token，所以分页可以自举，不必再依赖那个时有时无的 HTML token。
  //
  // 自举时以 RPC 返回的第 1 页为准，而不是 HTML 里解析出的那一页：这样后面每一页都
  // 来自同一条链路，不会因为两个来源有细微差别而误触重复 ID 检查。
  if (!token && ids.length < topN) {
    const bootstrapped = await fetchPaginationPage(keyword, locale, null, paginationResponses);
    if (bootstrapped.ids.length > 0) {
      ids = bootstrapped.ids;
      token = bootstrapped.token;
      diagnostics.push(
        `The initial page carried no continuation token; pagination was bootstrapped from the RPC instead (${ids.length} results on the first page).`,
      );
    }
  }

  while (ids.length < topN) {
    if (!token) {
      paginationUnavailable = true;
      break;
    }
    const next = await fetchPaginationPage(keyword, locale, token, paginationResponses);
    if (next.ids.length === 0) {
      // 这才是真正的「结果集到头」：RPC 明确返回了零条。
      endOfResults = true;
      break;
    }
    const duplicates = next.ids.filter((id) => ids.includes(id));
    if (duplicates.length > 0) throw new Error(`Pagination RPC repeated extension IDs: ${duplicates.join(", ")}`);
    ids.push(...next.ids);
    token = next.token;
    loadedBatches += 1;
    console.error(`Loaded HTTP results ${ids.length - next.ids.length + 1}-${ids.length}...`);
    if (!token) endOfResults = true;
  }

  const selected = ids.slice(0, topN);
  const items: SerpItem[] = selected.map((extensionId, index) => ({ extensionId, position: index + 1 }));
  const complete = items.length >= topN || endOfResults;
  if (paginationUnavailable) {
    diagnostics.push(
      `No continuation token after ${INITIAL_ATTEMPTS} attempts, so only the first ${ids.length} results were verified. Incomplete on purpose: a rank below ${ids.length} cannot be ruled out.`,
    );
  }
  diagnostics.push(`Loaded ${loadedBatches} anonymous HTTP pagination batches with page size ${PAGE_SIZE}; no Cookie header was sent.`);
  diagnostics.push(`Validated ${items.length} unique ordered extension IDs across the initial HTML and pagination RPC responses.`);
  return {
    status: response?.status ?? 0,
    html,
    items: complete ? items : null,
    reliable: complete,
    strategy: complete ? "initial-html-plus-zTyKYc-pagination" : null,
    diagnostics,
    loadedBatches,
    endOfResults,
    paginationResponses,
  };
}
