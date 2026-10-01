import assert from "node:assert/strict";
import test from "node:test";
import { positiveInt, resolveTargetRanks } from "./config.js";

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
