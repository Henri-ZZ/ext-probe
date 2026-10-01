export const TARGET_EXTENSION_ID = "edjbgblhciojhakodeflnpampekciifl";

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

export const DAILY_CRON_SHARDS = [
  "0 2 * * *",
  "20 2 * * *",
  "40 2 * * *",
] as const;

export type ProbeJob = {
  keyword: string;
  locale: string;
};

export function getDailyJobs(): ProbeJob[] {
  return DEFAULT_LOCALES.flatMap((locale) =>
    DEFAULT_KEYWORDS.map((keyword) => ({ keyword, locale })),
  );
}

export function getShardJobs(shardIndex: number, shardCount = DAILY_CRON_SHARDS.length): ProbeJob[] {
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`无效的分片编号：${shardIndex}/${shardCount}`);
  }
  return getDailyJobs().filter((_, index) => index % shardCount === shardIndex);
}
