import assert from "node:assert/strict";
import test from "node:test";
import { extractRawIds, parseOrderedSerp } from "./parser.js";

const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("raw IDs are deduplicated without claiming order", () => {
  assert.deepEqual(extractRawIds(`${first} ${second} ${first}`), [first, second]);
});

test("explicit consecutive card indices produce an ordered SERP", () => {
  const html = [
    `<div data-item-id="${second}"><a href="./detail/second/${second}" jslog="event; index:1"></a></div>`,
    `<div data-item-id="${first}"><a href="./detail/first/${first}" jslog="event; index:0"></a></div>`,
    `<div data-item-id="cccccccccccccccccccccccccccccccc"><a href="./detail/third/cccccccccccccccccccccccccccccccc" jslog="event; index:2"></a></div>`,
  ].join("");
  const parsed = parseOrderedSerp(html);
  assert.equal(parsed.reliable, true);
  assert.deepEqual(parsed.items?.map(({ extensionId, position }) => ({ extensionId, position })), [
    { extensionId: first, position: 1 },
    { extensionId: second, position: 2 },
    { extensionId: "cccccccccccccccccccccccccccccccc", position: 3 },
  ]);
});

test("detail links without explicit indices are not promoted to a SERP", () => {
  const parsed = parseOrderedSerp(`<a href="./detail/first/${first}"></a><a href="./detail/second/${second}"></a>`);
  assert.equal(parsed.reliable, false);
  assert.equal(parsed.items, null);
});
