/**
 * Chrome Web Store 扩展元数据解析。
 *
 * 遵循与 parser.ts 相同的纪律：只报告能验证来源的结果，宁可返回 null 也不猜。
 * 尤其是详情页在某些情况下会 301 到商店首页，此时 og:url 不会包含目标 ID，
 * 必须拒绝这次结果，而不是把 "Chrome Web Store" 当成标题存下来。
 *
 * 两个来源：
 *   - 详情页的 og: 元数据（parseDetailProfile）
 *   - 搜索结果页内嵌的 AF_initDataCallback 数据（extractSerpProfiles）
 */

const CWS_ID_PATTERN = /^[a-p]{32}$/;
const ICON_HOST = "https://lh3.googleusercontent.com/";
const TITLE_SUFFIX = /\s*[-–]\s*Chrome Web Store\s*$/i;

export type ExtensionProfileInput = {
  cwsId: string;
  title: string;
  iconUrl: string | null;
  description: string | null;
  slug: string | null;
  rating: number | null;
  ratingCount: number | null;
};

export function isCwsId(value: unknown): value is string {
  return typeof value === "string" && CWS_ID_PATTERN.test(value);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanTitle(value: string): string {
  return decodeEntities(value).replace(TITLE_SUFFIX, "").trim();
}

/**
 * 读取 <meta> 的 content。属性顺序不固定，因此分别尝试
 * property/name 在前与 content 在前两种写法。
 */
function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]*?(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escaped}["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function slugFromCanonical(canonical: string): string | null {
  const match = canonical.match(/\/detail\/([^/?#]+)\/[a-p]{32}/i);
  return match?.[1] ?? null;
}

/**
 * 解析详情页。只有当 og:url / canonical 明确指向目标扩展时才返回结果——
 * 重定向到首页的响应会因为不含目标 ID 而被拒绝。
 */
export function parseDetailProfile(
  html: string,
  expectedCwsId: string,
): ExtensionProfileInput | null {
  const canonical =
    metaContent(html, "og:url") ??
    html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
    null;

  if (!canonical || !canonical.includes(expectedCwsId)) return null;

  const title = cleanTitle(metaContent(html, "og:title") ?? "");
  if (!title || title.toLowerCase() === "chrome web store") return null;

  const icon = metaContent(html, "og:image");
  const description = metaContent(html, "og:description");

  return {
    cwsId: expectedCwsId,
    title,
    iconUrl: icon?.startsWith(ICON_HOST) ? icon : null,
    description: description ? decodeEntities(description) : null,
    slug: slugFromCanonical(canonical),
    rating: null,
    ratingCount: null,
  };
}

/** 用括号深度扫描取出 JS 字面量，避免依赖 "sideChannel:" 之类的结尾标记。 */
function scanLiteralEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

/**
 * 取出页面中所有 AF_initDataCallback 的数据块。
 * key 会随前端构建变化，因此不硬编码 ds:1，而是全部解析后在结构里找目标数组。
 */
export function extractInitDataBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const marker = "AF_initDataCallback({";
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf(marker, cursor);
    if (start < 0) break;

    const dataAt = html.indexOf("data:", start);
    if (dataAt < 0) break;

    const literalStart = dataAt + "data:".length;
    const literalEnd = scanLiteralEnd(html, literalStart);

    if (literalEnd > literalStart) {
      try {
        blocks.push(JSON.parse(html.slice(literalStart, literalEnd)) as unknown);
      } catch {
        // 忽略无法解析的数据块，继续找下一个。
      }
      cursor = literalEnd;
    } else {
      cursor = literalStart;
    }
  }

  return blocks;
}

/**
 * 在任意嵌套结构里寻找形如 [扩展 ID, 图标 URL, 标题, 评分, 评分数] 的数组。
 * 依赖字段形状而不是固定下标路径，前端调整嵌套层级时依然可用。
 */
function collectEmbeddedProfiles(
  node: unknown,
  out: Map<string, ExtensionProfileInput>,
  depth = 0,
): void {
  if (depth > 14 || !Array.isArray(node)) return;

  const [id, icon, title] = node as unknown[];

  if (
    isCwsId(id) &&
    typeof icon === "string" &&
    icon.startsWith(ICON_HOST) &&
    typeof title === "string" &&
    title.trim().length > 0 &&
    title.length < 200
  ) {
    out.set(id, {
      cwsId: id,
      title: cleanTitle(title),
      iconUrl: icon,
      description: null,
      slug: null,
      rating: numberOrNull(node[3]),
      ratingCount: numberOrNull(node[4]),
    });
    return;
  }

  for (const child of node) collectEmbeddedProfiles(child, out, depth + 1);
}

/**
 * 从搜索结果页 HTML 中提取所有可见结果的元数据。
 * 这些数据随采集免费获得，不需要额外请求。
 */
export function extractSerpProfiles(html: string): ExtensionProfileInput[] {
  const found = new Map<string, ExtensionProfileInput>();

  for (const block of extractInitDataBlocks(html)) {
    collectEmbeddedProfiles(block, found);
  }

  return [...found.values()].filter((profile) => profile.title.length > 0);
}

export type DetailFetchResult = {
  status: number;
  url: string;
  profile: ExtensionProfileInput | null;
  diagnostics: string[];
};

/** 按扩展 ID 抓取详情页元数据。locale 会影响标题与描述的本地化。 */
export async function fetchDetailProfile(
  cwsId: string,
  locale = "en",
): Promise<DetailFetchResult> {
  const url = `https://chromewebstore.google.com/detail/${cwsId}?hl=${encodeURIComponent(locale)}`;
  const response = await fetch(url, { redirect: "follow" });
  const html = await response.text();
  const profile = parseDetailProfile(html, cwsId);
  const diagnostics: string[] = [
    `HTTP ${response.status}, ${html.length} bytes, final URL ${response.url}`,
  ];

  if (!profile) {
    diagnostics.push(
      "og:url 未指向目标扩展，已放弃这次解析（页面可能被重定向到商店首页）。",
    );
  }

  return { status: response.status, url: response.url, profile, diagnostics };
}
