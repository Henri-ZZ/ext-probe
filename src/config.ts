/**
 * 采集目标不再硬编码在代码里：生产环境的 (keyword, locale) 任务来自
 * 数据库中的 `tracking_targets` 表（由 ext-signal 写入）。
 *
 * 本文件只保留三类东西：
 *   1. 本地 CLI 实验用的默认值；
 *   2. Worker 的批次与保鲜策略；
 *   3. 不依赖数据库的纯函数，方便测试。
 */

/** 本地 CLI（probe / repeat）默认关注的目标扩展：Edit Page。 */
export const TARGET_EXTENSION_ID = "edjbgblhciojhakodeflnpampekciifl";

/** `npm run matrix` 使用的默认关键词集合。 */
export const DEFAULT_KEYWORDS = [
  "edit page",
  "page editor",
  "edit webpage",
  "edit web page",
  "webpage editor",
  "web page editor",
  "edit website",
  "website editor",
  "full page screenshot",
] as const;

export const DEFAULT_LOCALES = ["en", "zh_CN"] as const;
export const DEFAULT_TOP_N = 50;

/**
 * Worker 每 15 分钟检查一次是否有过期任务，而不是把任务硬编码成三个每日分片。
 * Cloudflare Cron 最小粒度是 1 分钟，Free 计划最多 5 个 trigger。
 */
export const COLLECTION_CRON = "*/15 * * * *";

/**
 * 单次 Worker 调用最多采集多少个 (keyword, locale) 组。
 * 每组约 5 个子请求（1 次 GET + 4 次分页 POST），6 组约 30 个，
 * 低于 Cloudflare Workers Free 单次 50 个子请求的限制。
 */
export const DEFAULT_BATCH_SIZE = 6;

/** 一个组距上次成功采集超过多少小时算「过期」。 */
export const DEFAULT_REFRESH_HOURS = 20;

export type ProbeJob = {
  keyword: string;
  locale: string;
};

export type ResolvedTargetRank = {
  cwsId: string;
  rank: number | null;
};

/**
 * 一次采集拿到的是完整 SERP，可能同时服务多个目标扩展。
 * 这里把 SERP 映射成「每个目标扩展的名次」：不在列表里就是 null（NR）。
 */
export function resolveTargetRanks(
  items: Array<{ position: number; extensionId: string }>,
  targetCwsIds: string[],
): ResolvedTargetRank[] {
  const positionByExtension = new Map(
    items.map((item) => [item.extensionId, item.position]),
  );

  return targetCwsIds.map((cwsId) => ({
    cwsId,
    rank: positionByExtension.get(cwsId) ?? null,
  }));
}

export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
