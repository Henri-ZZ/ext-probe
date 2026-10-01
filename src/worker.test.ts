import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

test("manual endpoint rejects missing configuration and bad credentials before collection", async () => {
  const missing = await worker.fetch(
    new Request("https://example.test/admin/run?shard=0", { method: "POST" }),
    { DATABASE_URL: "unused" },
  );
  assert.equal(missing.status, 503);

  const unauthorized = await worker.fetch(
    new Request("https://example.test/admin/run?shard=0", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }),
    { DATABASE_URL: "unused", MANUAL_TRIGGER_TOKEN: "correct" },
  );
  assert.equal(unauthorized.status, 401);

  const invalidShard = await worker.fetch(
    new Request("https://example.test/admin/run?shard=9", {
      method: "POST",
      headers: { Authorization: "Bearer correct" },
    }),
    { DATABASE_URL: "unused", MANUAL_TRIGGER_TOKEN: "correct" },
  );
  assert.equal(invalidShard.status, 400);
});
