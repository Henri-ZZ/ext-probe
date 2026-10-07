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

function rpcBody(keyword: string, token: string): string {
  const payload = [[null, [null, null, null, [keyword, [PAGE_SIZE, token]]]]];
  const request = [[[("zTyKYc"), JSON.stringify(payload), null, "generic"]]];
  return `${new URLSearchParams({ "f.req": JSON.stringify(request) })}&`;
}

/**
 * 初始 HTML 里的续传 token 时有时无：同一个 URL 连续请求，实测约一半概率缺失
 * （HTML 长度几乎一样，不是页面变体）。没有它就无法翻页，所以这里重试把它拿稳，
 * 而不是把「拿不到 token」当成「结果集到头」。
 */
const INITIAL_ATTEMPTS = 5;

export async function collectHttpRanking(keyword: string, locale: string, topN: number): Promise<CollectionResult> {
  const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;

  let response: Response | undefined;
  let html = "";
  let initial: ReturnType<typeof parseOrderedSerp> | undefined;
  let token: string | null = null;

  for (let attempt = 1; attempt <= INITIAL_ATTEMPTS; attempt += 1) {
    response = await fetch(searchUrl, { redirect: "follow" });
    html = await response.text();
    initial = parseOrderedSerp(html);
    if (!initial.reliable || !initial.items) break;
    token = extractInitialToken(html);
    // 首页自身就够长，或拿到了能继续翻页的 token，都不需要再抓。
    if (initial.items.length >= topN || token) break;
  }

  if (!initial || !initial.reliable || !initial.items) {
    return {
      status: response?.status ?? 0,
      html,
      items: null,
      reliable: false,
      strategy: null,
      diagnostics: [
        ...(initial?.diagnostics ?? []),
        `No usable search page after ${INITIAL_ATTEMPTS} attempts.`,
      ],
      loadedBatches: 0,
      endOfResults: false,
      paginationResponses: [],
    };
  }

  const ids = initial.items.map((item) => item.extensionId);
  const paginationResponses: string[] = [];
  const diagnostics = [...initial.diagnostics];
  let loadedBatches = 0;
  let endOfResults = false;
  // 首页只有 10 条而 topN 更大时，没有 token 就意味着翻不了页。这和「结果集到头」
  // 是两回事——绝不能据此断定目标不在前面。这里保持 endOfResults 为 false，让
  // complete 为假、整次采集被判为不可靠，由 worker 记成失败并走退避重试：
  // 报一个假的「未进前 N」比报失败糟得多，前者会静默污染排名历史。
  let paginationUnavailable = false;

  while (ids.length < topN) {
    if (!token) {
      paginationUnavailable = true;
      break;
    }
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
    paginationResponses.push(text);
    if (!response.ok) throw new Error(`Pagination RPC returned HTTP ${response.status}.`);
    const page = parseRpcResponse(text);
    if (page.ids.length === 0) {
      // 这才是真正的「结果集到头」：RPC 明确返回了零条。
      endOfResults = true;
      break;
    }
    const duplicates = page.ids.filter((id) => ids.includes(id));
    if (duplicates.length > 0) throw new Error(`Pagination RPC repeated extension IDs: ${duplicates.join(", ")}`);
    ids.push(...page.ids);
    token = page.token;
    loadedBatches += 1;
    console.error(`Loaded HTTP results ${ids.length - page.ids.length + 1}-${ids.length}...`);
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
