import assert from "node:assert/strict";
import test from "node:test";
import {
  FAILURE_BACKOFF_CAP_MINUTES,
  FAILURE_BACKOFF_MINUTES,
  nextAttemptMinutes,
  positiveInt,
  resolveTargetRanks,
} from "./config.js";

test("失败退避按连续次数逐级拉长，并在最后一档封顶", () => {
  assert.deepEqual(
    Array.from({ length: FAILURE_BACKOFF_MINUTES.length }, (_, i) =>
      nextAttemptMinutes(i + 1),
    ),
    FAILURE_BACKOFF_MINUTES,
  );

  // 超过表长之后一直停在最后一档，不会无限增长。
  assert.equal(
    nextAttemptMinutes(FAILURE_BACKOFF_MINUTES.length + 1),
    FAILURE_BACKOFF_CAP_MINUTES,
  );
  assert.equal(nextAttemptMinutes(50), FAILURE_BACKOFF_CAP_MINUTES);
  assert.equal(nextAttemptMinutes(0), FAILURE_BACKOFF_MINUTES[0]);
  assert.equal(nextAttemptMinutes(-3), FAILURE_BACKOFF_MINUTES[0]);

  // 退避必须严格递增，否则「让位给正常目标」的前提不成立。
  for (let i = 1; i < FAILURE_BACKOFF_MINUTES.length; i += 1) {
    const current = FAILURE_BACKOFF_MINUTES[i] ?? 0;
    const previous = FAILURE_BACKOFF_MINUTES[i - 1] ?? 0;
    assert.ok(current > previous, `第 ${i + 1} 档必须大于第 ${i} 档`);
  }
});

test("resolveTargetRanks 为每个目标扩展返回名次，未出现则为 null", () => {
  const items = [
    { position: 1, extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { position: 8, extensionId: "edjbgblhciojhakodeflnpampekciifl" },
    { position: 11, extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ];

  assert.deepEqual(
    resolveTargetRanks(items, [
      "edjbgblhciojhakodeflnpampekciifl",
      "cccccccccccccccccccccccccccccccc",
    ]),
    [
      { cwsId: "edjbgblhciojhakodeflnpampekciifl", rank: 8 },
      { cwsId: "cccccccccccccccccccccccccccccccc", rank: null },
    ],
  );
});

test("resolveTargetRanks 对重复目标只按 SERP 取一次名次", () => {
  const items = [{ position: 3, extensionId: "dddddddddddddddddddddddddddddddd" }];

  assert.deepEqual(
    resolveTargetRanks(items, [
      "dddddddddddddddddddddddddddddddd",
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ]),
    [
      { cwsId: "dddddddddddddddddddddddddddddddd", rank: 3 },
      { cwsId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", rank: null },
    ],
  );
});

test("resolveTargetRanks 在空 SERP 下全部返回 null", () => {
  assert.deepEqual(resolveTargetRanks([], ["ffffffffffffffffffffffffffffffff"]), [
    { cwsId: "ffffffffffffffffffffffffffffffff", rank: null },
  ]);
});

test("positiveInt 只接受正整数，否则回退", () => {
  assert.equal(positiveInt("6", 3), 6);
  assert.equal(positiveInt("0", 3), 3);
  assert.equal(positiveInt("-2", 3), 3);
  assert.equal(positiveInt("abc", 3), 3);
  assert.equal(positiveInt(undefined, 3), 3);
  assert.equal(positiveInt("2.5", 3), 3);
});
