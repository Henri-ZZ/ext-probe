import type { SerpItem } from "./types.js";

const EXTENSION_ID = /^[a-p]{32}$/;
const DETAIL_URL = /\/detail\/([^"'<>\\/\s?]+)\/([a-p]{32})(?:[?"'<>\\/\s]|$)/g;
const INDEXED_CARD = /data-item-id="([a-p]{32})"[\s\S]{0,2000}?href="\.\/detail\/([^"<>]+)\/\1"[\s\S]{0,1200}?jslog="[^"]*?\bindex:(\d+)"/g;

export function extractRawIds(html: string): string[] {
  return [...new Set(html.match(/\b[a-p]{32}\b/g) ?? [])];
}

function decodeEmbeddedText(value: string): string {
  return value
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\x2f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export function inspectIdContext(html: string, extensionId: string, radius = 500): string[] {
  const contexts: string[] = [];
  let cursor = 0;
  while (contexts.length < 5) {
    const index = html.indexOf(extensionId, cursor);
    if (index < 0) break;
    contexts.push(html.slice(Math.max(0, index - radius), Math.min(html.length, index + extensionId.length + radius)));
    cursor = index + extensionId.length;
  }
  return contexts;
}

export function parseOrderedSerp(html: string): {
  items: SerpItem[] | null;
  reliable: boolean;
  strategy: string | null;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const indexed: Array<{ extensionId: string; index: number }> = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(INDEXED_CARD)) {
    const extensionId = match[1];
    const slug = match[2];
    const index = Number(match[3]);
    if (!slug || !extensionId || !EXTENSION_ID.test(extensionId) || !Number.isSafeInteger(index) || seen.has(extensionId)) continue;
    seen.add(extensionId);
    indexed.push({ extensionId, index });
  }

  diagnostics.push(`Found ${indexed.length} unique result cards with data-item-id, matching detail href, and explicit jslog index.`);
  const ordered = indexed.sort((left, right) => left.index - right.index);
  const indices = ordered.map((item) => item.index);
  const consecutiveFromZero = indices.every((index, position) => index === position);
  if (ordered.length >= 3 && consecutiveFromZero) {
    diagnostics.push(`Validated a unique consecutive zero-based index sequence 0..${ordered.length - 1}.`);
    diagnostics.push("Titles are omitted: the detail URL slug can be truncated and is not accepted as an exact title.");
    return {
      items: ordered.map(({ extensionId, index }) => ({ extensionId, position: index + 1 })),
      reliable: true,
      strategy: "result-card-explicit-index",
      diagnostics,
    };
  }

  const decoded = decodeEmbeddedText(html);
  const detailIds = [...decoded.matchAll(DETAIL_URL)].map((match) => match[2]).filter((id): id is string => Boolean(id));
  diagnostics.push(`Indexed cards were insufficient or non-consecutive (indices: ${indices.join(", ") || "none"}).`);
  diagnostics.push(`Found ${new Set(detailIds).size} unique detail-link IDs as fallback evidence, but link order alone is not accepted as a reliable SERP.`);
  if (detailIds.length === 0) {
    diagnostics.push("No ordered representation was found; raw IDs remain reconnaissance only.");
  }
  return { items: null, reliable: false, strategy: null, diagnostics };
}
