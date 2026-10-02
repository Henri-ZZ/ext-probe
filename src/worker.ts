import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { collectHttpRanking } from "./adapters/http.js";
import {
  COLLECTION_CRON,
  DEFAULT_BATCH_SIZE,
  DEFAULT_REFRESH_HOURS,
  DEFAULT_TOP_N,
  FAILURE_BACKOFF_MINUTES,
  nextAttemptMinutes,
  positiveInt,
  resolveTargetRanks,
  type ProbeJob,
} from "./config.js";
import {
  extractSerpProfiles,
  fetchDetailProfile,
  isCwsId,
  type ExtensionProfileInput,
} from "./metadata.js";

/**
 * 每批次最多为多少个「还没有元数据」的被跟踪扩展额外抓一次详情页。
 * 6 组采集约 30 个子请求，加上这里仍低于 Workers Free 单次 50 的限制。
 */
const MAX_DETAIL_RESOLVES_PER_BATCH = 2;

interface Env {
  DATABASE_URL: string;
  MANUAL_TRIGGER_TOKEN?: string;
  TOP_N?: string;
  COLLECTION_DELAY_MS?: string;
  BATCH_SIZE?: string;
  REFRESH_HOURS?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

type Sql = NeonQueryFunction<false, false>;
type RunStatus = "success" | "failed";

type DueJob = {
  keyword: string;
  locale: string;
  last_collected_at: unknown;
  consecutive_failures: unknown;
};

type CollectedItem = {
  position: number;
  extensionId: string;
};

export type CollectionSummary = {
  batchId: string | null;
  /** 本轮开始时回收的被中断批次数量。 */
  recovered: number;
  jobs: number;
  collected: number;
  failed: number;
  targets: number;
  profiles: number;
};

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 写入扩展元数据。同一批次可能多次调用（每个采集任务一次），
 * 用 upsert 保证已有字段不会被后到的空值覆盖。
 */
async function upsertProfiles(
  sql: Sql,
  profiles: ExtensionProfileInput[],
  options: {
    /**
     * 商店标题会被 locale 本地化（德语 SERP 会给出德语标题）。
     * 只有英文来源才覆盖已有标题，否则界面会因为最后采集的地区而变语言。
     */
    overwriteTitle: boolean;
  },
): Promise<number> {
  const unique = new Map(profiles.map((profile) => [profile.cwsId, profile]));
  const records = [...unique.values()].map((profile) => ({
    cws_id: profile.cwsId,
    title: profile.title,
    icon_url: profile.iconUrl,
    description: profile.description,
    slug: profile.slug,
    rating: profile.rating,
    rating_count: profile.ratingCount,
  }));

  if (records.length === 0) return 0;

  await sql`
    INSERT INTO extension_profiles (
      cws_id, title, icon_url, description, slug, rating, rating_count
    )
    SELECT
      item.cws_id, item.title, item.icon_url, item.description,
      item.slug, item.rating, item.rating_count
    FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb)
      AS item(
        cws_id text,
        title text,
        icon_url text,
        description text,
        slug text,
        rating double precision,
        rating_count integer
      )
    ON CONFLICT (cws_id) DO UPDATE SET
      title = CASE
        WHEN ${options.overwriteTitle} THEN EXCLUDED.title
        ELSE extension_profiles.title
      END,
      icon_url = COALESCE(EXCLUDED.icon_url, extension_profiles.icon_url),
      description = COALESCE(EXCLUDED.description, extension_profiles.description),
      slug = COALESCE(EXCLUDED.slug, extension_profiles.slug),
      rating = COALESCE(EXCLUDED.rating, extension_profiles.rating),
      rating_count = COALESCE(EXCLUDED.rating_count, extension_profiles.rating_count),
      updated_at = now()
  `;

  return records.length;
}

/** 被跟踪但还没有元数据的扩展，用于每批次限量自愈。 */
async function getUnprofiledTargets(sql: Sql, limit: number): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT e.cws_id
    FROM tracking_targets t
    JOIN extensions e ON e.id = t.extension_id
    LEFT JOIN extension_profiles p ON p.cws_id = e.cws_id
    WHERE t.enabled = true AND p.cws_id IS NULL
    ORDER BY e.cws_id
    LIMIT ${limit}
  `) as { cws_id: string }[];

  return rows.map((row) => row.cws_id);
}

/**
 * 需要采集的 (keyword, locale) 组：从未成功采集过，或距上次成功采集已超过
 * refreshHours，并且不在失败退避期内。
 *
 * 排序仍然是「最久未采集优先」，但退避中的组合会被 WHERE 直接排除而不是靠排序让位——
 * 否则那些永远拿不到成功记录的组会一直霸占批次头部，把正常目标挤到永远排不上队。
 */
async function getDueJobs(
  sql: Sql,
  limit: number,
  refreshHours: number,
): Promise<DueJob[]> {
  return (await sql`
    SELECT
      t.keyword,
      t.locale,
      ok.collected_at AS last_collected_at,
      COALESCE(cs.consecutive_failures, 0)::int AS consecutive_failures
    FROM (
      SELECT DISTINCT keyword, locale
      FROM tracking_targets
      WHERE enabled = true
    ) t
    LEFT JOIN LATERAL (
      SELECT rr.collected_at
      FROM ranking_runs rr
      WHERE rr.keyword = t.keyword
        AND rr.locale = t.locale
        AND rr.status = 'success'
      ORDER BY rr.collected_at DESC
      LIMIT 1
    ) ok ON true
    LEFT JOIN collection_state cs
      ON cs.keyword = t.keyword AND cs.locale = t.locale
    WHERE (
        ok.collected_at IS NULL
        OR ok.collected_at < now() - (${refreshHours}::int * interval '1 hour')
      )
      AND (cs.next_attempt_at IS NULL OR cs.next_attempt_at <= now())
    ORDER BY ok.collected_at ASC NULLS FIRST, t.keyword, t.locale
    LIMIT ${limit}
  `) as DueJob[];
}

/**
 * 把 config 里的退避表编译成 SQL CASE。
 * 每档都用 `collection_state.consecutive_failures + 1`（本次失败后的次数）判断，
 * 第一个命中的分支生效，因此与 nextAttemptMinutes 一一对应，不会各自漂移。
 */
function backoffSql(): string {
  const branches = FAILURE_BACKOFF_MINUTES.slice(0, -1).map(
    (minutes, index) =>
      `WHEN collection_state.consecutive_failures + 1 <= ${index + 1} THEN interval '${minutes} minutes'`,
  );
  const cap = FAILURE_BACKOFF_MINUTES[FAILURE_BACKOFF_MINUTES.length - 1];

  return `CASE ${branches.join(" ")} ELSE interval '${cap} minutes' END`;
}

/** 记录一次失败：累加连续失败次数，并把下一次尝试推到退避之后。 */
async function recordCollectionFailure(
  sql: Sql,
  job: ProbeJob,
  message: string,
): Promise<void> {
  const firstDelay = nextAttemptMinutes(1);

  await sql`
    INSERT INTO collection_state (
      keyword, locale, consecutive_failures, next_attempt_at, last_error, last_failed_at
    ) VALUES (
      ${job.keyword}, ${job.locale}, 1,
      now() + ${sql.unsafe(`interval '${firstDelay} minutes'`)},
      ${message.slice(0, 2000)}, now()
    )
    ON CONFLICT (keyword, locale) DO UPDATE SET
      consecutive_failures = collection_state.consecutive_failures + 1,
      next_attempt_at = now() + ${sql.unsafe(backoffSql())},
      last_error = EXCLUDED.last_error,
      last_failed_at = now(),
      updated_at = now()
  `;
}

/** 采集成功后立刻解除退避，让这一组回到正常节奏。 */
async function clearCollectionFailure(sql: Sql, job: ProbeJob): Promise<void> {
  await sql`
    INSERT INTO collection_state (
      keyword, locale, consecutive_failures, next_attempt_at, last_error, last_failed_at
    ) VALUES (${job.keyword}, ${job.locale}, 0, NULL, NULL, NULL)
    ON CONFLICT (keyword, locale) DO UPDATE SET
      consecutive_failures = 0,
      next_attempt_at = NULL,
      last_error = NULL,
      updated_at = now()
  `;
}

/**
 * 回收被中断的批次。Worker 在执行中被杀（超时、部署、请求方断开）时，
 * 批次会永远停在 running，这里在每轮开始时把它们标记为失败。
 */
async function recoverStaleBatches(sql: Sql): Promise<number> {
  const rows = (await sql`
    UPDATE collection_batches
    SET completed_at = now(),
        status = 'failed',
        error_message = '执行被中断：批次超过 30 分钟仍未完成，已自动回收。'
    WHERE status = 'running'
      AND started_at < now() - interval '30 minutes'
    RETURNING id
  `) as { id: string }[];

  return rows.length;
}

/** 同一个 (keyword, locale) 组可能被多个用户 / 多个扩展跟踪。 */
async function getTargetCwsIds(
  sql: Sql,
  job: { keyword: string; locale: string },
): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT e.cws_id
    FROM tracking_targets t
    JOIN extensions e ON e.id = t.extension_id
    WHERE t.enabled = true
      AND t.keyword = ${job.keyword}
      AND t.locale = ${job.locale}
    ORDER BY e.cws_id
  `) as { cws_id: string }[];

  return rows.map((row) => row.cws_id);
}

type SuccessfulRunInput = {
  runId: string;
  batchId: string;
  collectedAt: Date;
  keyword: string;
  locale: string;
  cwsId: string;
  rank: number | null;
  topN: number;
  durationMs: number;
  items: CollectedItem[];
  loadedBatches: number;
  endOfResults: boolean;
  diagnostics: string[];
};

/**
 * 一次采集服务多个目标扩展时，每个目标各写一行 ranking_runs，
 * 并把这批完整 Top N 写进各自的 ranking_results。
 *
 * 稍微冗余，但让「按最新一次 run 反查竞品」这类查询不必去猜哪一行
 * 才带结果，代价是每组多几十行。
 */
async function saveSuccessfulRun(sql: Sql, input: SuccessfulRunInput): Promise<void> {
  const notFoundWithin =
    input.rank === null ? Math.min(input.topN, input.items.length) : null;

  const resultsJson = JSON.stringify(
    input.items.map((item) => ({
      position: item.position,
      extension_id: item.extensionId,
    })),
  );

  await sql`
    WITH inserted_run AS (
      INSERT INTO ranking_runs (
        id, batch_id, collected_at, keyword, locale, target_extension_id,
        target_rank, not_found_within, requested_top_n, collected_count,
        status, duration_ms, collection_mode, loaded_batches, end_of_results, diagnostics
      ) VALUES (
        ${input.runId}::uuid, ${input.batchId}::uuid, ${input.collectedAt.toISOString()}::timestamptz,
        ${input.keyword}, ${input.locale}, ${input.cwsId}, ${input.rank},
        ${notFoundWithin},
        ${input.topN}, ${input.items.length}, 'success', ${input.durationMs},
        'http-pagination', ${input.loadedBatches}, ${input.endOfResults},
        ${JSON.stringify(input.diagnostics)}::jsonb
      )
      RETURNING id
    )
    INSERT INTO ranking_results (run_id, position, extension_id)
    SELECT inserted_run.id, result.position, result.extension_id
    FROM inserted_run
    CROSS JOIN jsonb_to_recordset(${resultsJson}::jsonb)
      AS result(position integer, extension_id text)
  `;
}

type FailedRunInput = {
  runId: string;
  batchId: string;
  collectedAt: Date;
  keyword: string;
  locale: string;
  cwsId: string;
  topN: number;
  durationMs: number;
  error: unknown;
};

async function saveFailedRun(sql: Sql, input: FailedRunInput): Promise<void> {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);

  await sql`
    INSERT INTO ranking_runs (
      id, batch_id, collected_at, keyword, locale, target_extension_id,
      requested_top_n, collected_count, status, duration_ms, collection_mode, error_message
    ) VALUES (
      ${input.runId}::uuid, ${input.batchId}::uuid, ${input.collectedAt.toISOString()}::timestamptz,
      ${input.keyword}, ${input.locale}, ${input.cwsId},
      ${input.topN}, 0, 'failed', ${input.durationMs}, 'http-pagination',
      ${message.slice(0, 4000)}
    )
  `;
}

export async function runCollection(
  env: Env,
  scheduledAt = new Date(),
  options: { batchSize?: number; source?: string } = {},
): Promise<CollectionSummary> {
  if (!env.DATABASE_URL) throw new Error("缺少 DATABASE_URL secret。");

  const sql = neon(env.DATABASE_URL);
  const topN = positiveInt(env.TOP_N, DEFAULT_TOP_N);
  const batchSize =
    options.batchSize ?? positiveInt(env.BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const refreshHours = positiveInt(env.REFRESH_HOURS, DEFAULT_REFRESH_HOURS);
  const delayMs = positiveInt(env.COLLECTION_DELAY_MS, 1000);
  const source = options.source ?? "cloudflare-cron";

  // 先回收上一轮被中断的批次，即使本轮没有到期任务也要做。
  const recovered = await recoverStaleBatches(sql);

  const jobs = await getDueJobs(sql, batchSize, refreshHours);
  if (jobs.length === 0) {
    return {
      batchId: null,
      recovered,
      jobs: 0,
      collected: 0,
      failed: 0,
      targets: 0,
      profiles: 0,
    };
  }

  const batchId = crypto.randomUUID();
  await sql`
    INSERT INTO collection_batches (id, scheduled_at, started_at, status, source)
    VALUES (
      ${batchId}::uuid, ${scheduledAt.toISOString()}::timestamptz, now(), 'running',
      ${source}
    )
  `;

  let collected = 0;
  let failed = 0;
  let targets = 0;
  let profiles = 0;

  try {
    for (const [index, job] of jobs.entries()) {
      if (index > 0) await pause(delayMs);

      const targetCwsIds = await getTargetCwsIds(sql, job);
      if (targetCwsIds.length === 0) continue;

      const collectedAt = new Date();
      const started = performance.now();

      try {
        const result = await collectHttpRanking(job.keyword, job.locale, topN);
        if (!result.reliable || !result.items) {
          throw new Error(`采集结果不可靠：${result.diagnostics.join("；")}`);
        }

        const durationMs = Math.round(performance.now() - started);
        for (const { cwsId, rank } of resolveTargetRanks(result.items, targetCwsIds)) {
          await saveSuccessfulRun(sql, {
            runId: crypto.randomUUID(),
            batchId,
            collectedAt,
            keyword: job.keyword,
            locale: job.locale,
            cwsId,
            rank,
            topN,
            durationMs,
            items: result.items,
            loadedBatches: result.loadedBatches,
            endOfResults: result.endOfResults,
            diagnostics: result.diagnostics,
          });
          targets += 1;
        }

        // 搜索结果页内嵌了每个结果的标题与图标，顺手存下来不需要额外请求。
        // 元数据失败绝不能让一次成功的排名采集变成失败。
        try {
          profiles += await upsertProfiles(sql, extractSerpProfiles(result.html), {
            overwriteTitle: job.locale === "en",
          });
        } catch (error) {
          console.error("写入搜索结果元数据失败", error);
        }

        // 成功即解除退避。失败本身不能让采集结果作废，因此单独兜住异常。
        try {
          await clearCollectionFailure(sql, job);
        } catch (stateError) {
          console.error("清除采集失败状态失败", stateError);
        }

        collected += 1;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        for (const cwsId of targetCwsIds) {
          await saveFailedRun(sql, {
            runId: crypto.randomUUID(),
            batchId,
            collectedAt,
            keyword: job.keyword,
            locale: job.locale,
            cwsId,
            topN,
            durationMs,
            error,
          });
          targets += 1;
        }

        try {
          await recordCollectionFailure(
            sql,
            job,
            error instanceof Error ? error.message : String(error),
          );
        } catch (stateError) {
          console.error("记录采集失败状态失败", stateError);
        }

        failed += 1;
      }
    }

    // 自愈：为还没有元数据的被跟踪扩展补一次详情页（数量受限）。
    try {
      const pending = await getUnprofiledTargets(sql, MAX_DETAIL_RESOLVES_PER_BATCH);
      for (const [position, cwsId] of pending.entries()) {
        if (position > 0) await pause(delayMs);
        const detail = await fetchDetailProfile(cwsId);
        if (detail.profile) {
          profiles += await upsertProfiles(sql, [detail.profile], {
            overwriteTitle: true,
          });
        } else {
          console.error("详情页元数据不可用", cwsId, detail.diagnostics.join("；"));
        }
      }
    } catch (error) {
      console.error("补齐扩展元数据失败", error);
    }

    const status: RunStatus = failed === 0 ? "success" : "failed";
    await sql`
      UPDATE collection_batches
      SET completed_at = now(), status = ${status},
          succeeded_count = ${collected}, failed_count = ${failed}
      WHERE id = ${batchId}::uuid
    `;

    return {
      batchId,
      recovered,
      jobs: jobs.length,
      collected,
      failed,
      targets,
      profiles,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE collection_batches
      SET completed_at = now(), status = 'failed', succeeded_count = ${collected},
          failed_count = ${failed}, error_message = ${message.slice(0, 4000)}
      WHERE id = ${batchId}::uuid
    `;
    throw error;
  }
}

function authorized(request: Request, env: Env): boolean {
  return (
    Boolean(env.MANUAL_TRIGGER_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.MANUAL_TRIGGER_TOKEN}`
  );
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: WorkerExecutionContext,
  ): Promise<void> {
    if (controller.cron !== COLLECTION_CRON) {
      console.log("忽略未配置的 Cron 表达式", controller.cron);
      return;
    }

    ctx.waitUntil(
      runCollection(env, new Date(controller.scheduledTime)).then((summary) => {
        console.log("定时采集完成", summary);
      }),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "ext-probe",
        mode: "tracking-targets",
        cron: COLLECTION_CRON,
        topN: positiveInt(env.TOP_N, DEFAULT_TOP_N),
        batchSize: positiveInt(env.BATCH_SIZE, DEFAULT_BATCH_SIZE),
        refreshHours: positiveInt(env.REFRESH_HOURS, DEFAULT_REFRESH_HOURS),
      });
    }

    if (request.method === "POST" && url.pathname === "/admin/run") {
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return Response.json(
          { ok: false, error: "手动触发尚未配置。" },
          { status: 503 },
        );
      }
      if (!authorized(request, env)) {
        return Response.json({ ok: false, error: "未授权。" }, { status: 401 });
      }

      // batch 控制本次最多采集多少组；旧版的 shard 参数已不再使用。
      const batchParam = url.searchParams.get("batch");
      let batchSize: number | undefined;

      if (batchParam !== null) {
        const parsed = Number(batchParam);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
          return Response.json(
            { ok: false, error: "batch 必须是 1 到 10 之间的整数。" },
            { status: 400 },
          );
        }
        batchSize = parsed;
      }

      const summary = await runCollection(env, new Date(), {
        batchSize,
        source: "manual-http",
      });

      return Response.json({ ok: true, ...summary });
    }

    /**
     * 按扩展 ID 同步解析商店元数据并落库。
     * ext-signal 在「添加扩展」时调用，让标题与图标立刻可见。
     */
    if (request.method === "POST" && url.pathname === "/admin/resolve") {
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return Response.json(
          { ok: false, error: "手动触发尚未配置。" },
          { status: 503 },
        );
      }
      if (!authorized(request, env)) {
        return Response.json({ ok: false, error: "未授权。" }, { status: 401 });
      }

      const body = (await request.json().catch(() => null)) as {
        cwsIds?: unknown;
        locale?: unknown;
      } | null;

      const requested = Array.isArray(body?.cwsIds)
        ? [...new Set(body.cwsIds.filter(isCwsId))]
        : [];

      if (requested.length === 0 || requested.length > 10) {
        return Response.json(
          { ok: false, error: "cwsIds 需要包含 1 到 10 个合法的扩展 ID。" },
          { status: 400 },
        );
      }

      const locale =
        typeof body?.locale === "string" && body.locale.length > 0
          ? body.locale
          : "en";

      const sql = neon(env.DATABASE_URL);
      const resolved: ExtensionProfileInput[] = [];
      const failures: Array<{ cwsId: string; diagnostics: string[] }> = [];

      for (const cwsId of requested) {
        const detail = await fetchDetailProfile(cwsId, locale);
        if (detail.profile) resolved.push(detail.profile);
        else failures.push({ cwsId, diagnostics: detail.diagnostics });
      }

      if (resolved.length > 0) {
        await upsertProfiles(sql, resolved, { overwriteTitle: locale === "en" });
      }

      return Response.json({
        ok: true,
        requested: requested.length,
        resolved: resolved.length,
        profiles: resolved,
        failures,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
