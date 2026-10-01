import assert from "node:assert/strict";
import test from "node:test";
import { DAILY_CRON_SHARDS, getDailyJobs, getShardJobs } from "./config.js";

test("daily matrix is split into three complete non-overlapping shards", () => {
  const allJobs = getDailyJobs();
  const shards = DAILY_CRON_SHARDS.map((_, index) => getShardJobs(index));

  assert.deepEqual(shards.map((jobs) => jobs.length), [6, 6, 6]);
  assert.equal(shards.flat().length, allJobs.length);
  assert.equal(new Set(shards.flat().map((job) => `${job.keyword}\0${job.locale}`)).size, allJobs.length);
  assert.deepEqual(
    shards.flat().map((job) => `${job.keyword}\0${job.locale}`).sort(),
    allJobs.map((job) => `${job.keyword}\0${job.locale}`).sort(),
  );
});
