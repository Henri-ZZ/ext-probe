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

export async function collectHttpRanking(keyword: string, locale: string, topN: number): Promise<CollectionResult> {
  const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(keyword)}?hl=${encodeURIComponent(locale)}`;
  const initialResponse = await fetch(searchUrl, { redirect: "follow" });
  const html = await initialResponse.text();
  const initial = parseOrderedSerp(html);
  if (!initial.reliable || !initial.items) {
    return { status: initialResponse.status, html, ...initial, loadedBatches: 0, endOfResults: false, paginationResponses: [] };
  }

  const ids = initial.items.map((item) => item.extensionId);
  const paginationResponses: string[] = [];
  const diagnostics = [...initial.diagnostics];
  let token = extractInitialToken(html);
  let loadedBatches = 0;
  let endOfResults = false;

  while (ids.length < topN) {
    if (!token) {
      endOfResults = true;
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
  diagnostics.push(`Loaded ${loadedBatches} anonymous HTTP pagination batches with page size ${PAGE_SIZE}; no Cookie header was sent.`);
  diagnostics.push(`Validated ${items.length} unique ordered extension IDs across the initial HTML and pagination RPC responses.`);
  return {
    status: initialResponse.status,
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
