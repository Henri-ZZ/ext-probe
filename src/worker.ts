import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { collectHttpRanking } from "./adapters/http.js";
import { DAILY_CRON_SHARDS, DEFAULT_TOP_N, getShardJobs, TARGET_EXTENSION_ID } from "./config.js";

interface Env {
  DATABASE_URL: string;
  TOP_N?: string;
  COLLECTION_DELAY_MS?: string;
}

interface CronController {
  scheduledTime: number;
  cron: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type RunStatus = "success" | "failed";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveSuccessfulRun(
  sql: NeonQueryFunction<false, false>,
  input: {
    runId: string;
    batchId: string;
    collectedAt: Date;
    keyword: string;
    locale: string;
    topN: number;
    durationMs: number;
    items: Array<{ position: number; extensionId: string }>;
    loadedBatches: number;
    endOfResults: boolean;
    diagnostics: string[];
  },
): Promise<void> {
  const targetRank = input.items.find((item) => item.extensionId === TARGET_EXTENSION_ID)?.position ?? null;
  const resultsJson = JSON.stringify(input.items.map((item) => ({
    position: item.position,
    extension_id: item.extensionId,
  })));

  await sql`
    WITH inserted_run AS (
      INSERT INTO ranking_runs (
        id, batch_id, collected_at, keyword, locale, target_extension_id,
        target_rank, not_found_within, requested_top_n, collected_count,
        status, duration_ms, collection_mode, loaded_batches, end_of_results, diagnostics
      ) VALUES (
        ${input.runId}::uuid, ${input.batchId}::uuid, ${input.collectedAt.toISOString()}::timestamptz,
        ${input.keyword}, ${input.locale}, ${TARGET_EXTENSION_ID}, ${targetRank},
        ${targetRank === null ? Math.min(input.topN, input.items.length) : null},
        ${input.topN}, ${input.items.length}, 'success', ${input.durationMs},
        'http-pagination', ${input.loadedBatches}, ${input.endOfResults}, ${JSON.stringify(input.diagnostics)}::jsonb
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

async function saveFailedRun(
  sql: NeonQueryFunction<false, false>,
  input: {
    runId: string;
    batchId: string;
    collectedAt: Date;
    keyword: string;
    locale: string;
    topN: number;
    durationMs: number;
    error: unknown;
  },
): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await sql`
    INSERT INTO ranking_runs (
      id, batch_id, collected_at, keyword, locale, target_extension_id,
      requested_top_n, collected_count, status, duration_ms, collection_mode, error_message
    ) VALUES (
      ${input.runId}::uuid, ${input.batchId}::uuid, ${input.collectedAt.toISOString()}::timestamptz,
      ${input.keyword}, ${input.locale}, ${TARGET_EXTENSION_ID},
      ${input.topN}, 0, 'failed', ${input.durationMs}, 'http-pagination', ${message.slice(0, 4000)}
    )
  `;
}

export async function runCollection(
  env: Env,
  scheduledAt = new Date(),
  shardIndex = 0,
): Promise<{ batchId: string; shardIndex: number; succeeded: number; failed: number }> {
  if (!env.DATABASE_URL) throw new Error("缺少 DATABASE_URL secret。");

  const sql = neon(env.DATABASE_URL);
  const batchId = crypto.randomUUID();
  const topN = positiveInteger(env.TOP_N, DEFAULT_TOP_N);
  const delayMs = positiveInteger(env.COLLECTION_DELAY_MS, 1000);
  const jobs = getShardJobs(shardIndex);
  let succeeded = 0;
  let failed = 0;

  await sql`
    INSERT INTO collection_batches (id, scheduled_at, started_at, status, source, shard_index, shard_count)
    VALUES (
      ${batchId}::uuid, ${scheduledAt.toISOString()}::timestamptz, now(), 'running',
      'cloudflare-cron', ${shardIndex}, ${DAILY_CRON_SHARDS.length}
    )
  `;

  try {
    for (const [index, { keyword, locale }] of jobs.entries()) {
        if (index > 0) await pause(delayMs);
        const runId = crypto.randomUUID();
        const collectedAt = new Date();
        const started = performance.now();
        try {
          const result = await collectHttpRanking(keyword, locale, topN);
          if (!result.reliable || !result.items) {
            throw new Error(`采集结果不可靠：${result.diagnostics.join("；")}`);
          }
          await saveSuccessfulRun(sql, {
            runId,
            batchId,
            collectedAt,
            keyword,
            locale,
            topN,
            durationMs: Math.round(performance.now() - started),
            items: result.items,
            loadedBatches: result.loadedBatches,
            endOfResults: result.endOfResults,
            diagnostics: result.diagnostics,
          });
          succeeded += 1;
        } catch (error) {
          failed += 1;
          await saveFailedRun(sql, {
            runId,
            batchId,
            collectedAt,
            keyword,
            locale,
            topN,
            durationMs: Math.round(performance.now() - started),
            error,
          });
        }
    }

    const status: RunStatus = failed === 0 ? "success" : "failed";
    await sql`
      UPDATE collection_batches
      SET completed_at = now(), status = ${status}, succeeded_count = ${succeeded}, failed_count = ${failed}
      WHERE id = ${batchId}::uuid
    `;
    return { batchId, shardIndex, succeeded, failed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      UPDATE collection_batches
      SET completed_at = now(), status = 'failed', succeeded_count = ${succeeded},
          failed_count = ${failed}, error_message = ${message.slice(0, 4000)}
      WHERE id = ${batchId}::uuid
    `;
    throw error;
  }
}

export default {
  async scheduled(controller: CronController, env: Env, ctx: WorkerExecutionContext): Promise<void> {
    const shardIndex = DAILY_CRON_SHARDS.indexOf(controller.cron as typeof DAILY_CRON_SHARDS[number]);
    if (shardIndex < 0) throw new Error(`未识别的 Cron 表达式：${controller.cron}`);
    ctx.waitUntil(runCollection(env, new Date(controller.scheduledTime), shardIndex).then((summary) => {
      console.log("定时采集完成", summary);
    }));
  },

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not Found", { status: 404 });
    }
    return Response.json({
      ok: true,
      service: "cws-ranking-probe",
      mode: "cloudflare-cron",
      topN: DEFAULT_TOP_N,
    });
  },
};
