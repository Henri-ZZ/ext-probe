import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

const adminRequest = (query: string, token?: string) =>
  new Request(`https://example.test/admin/run${query}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

test("manual endpoint rejects missing configuration and bad credentials before collection", async () => {
  const missing = await worker.fetch(adminRequest(""), { DATABASE_URL: "unused" });
  assert.equal(missing.status, 503);

  const unauthorized = await worker.fetch(adminRequest("", "wrong"), {
    DATABASE_URL: "unused",
    MANUAL_TRIGGER_TOKEN: "correct",
  });
  assert.equal(unauthorized.status, 401);
});

test("manual endpoint rejects an out-of-range batch before touching the database", async () => {
  const env = { DATABASE_URL: "unused", MANUAL_TRIGGER_TOKEN: "correct" };

  for (const query of ["?batch=0", "?batch=99", "?batch=abc"]) {
    const response = await worker.fetch(adminRequest(query, "correct"), env);
    assert.equal(response.status, 400, `expected 400 for ${query}`);

    const body = (await response.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  }
});

test("health endpoint reports the collection strategy", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health"),
    { DATABASE_URL: "unused" },
  );

  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    ok: boolean;
    mode: string;
    batchSize: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.mode, "tracking-targets");
  assert.equal(body.batchSize, 6);
});

test("unknown routes return 404", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/nope"),
    { DATABASE_URL: "unused" },
  );

  assert.equal(response.status, 404);
});
