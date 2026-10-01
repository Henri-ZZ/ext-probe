import assert from "node:assert/strict";
import test from "node:test";
import { extractInitialToken, parseRpcResponse } from "./adapters/http.js";

test("extracts an HTML-escaped initial continuation token", () => {
  assert.equal(extractInitialToken('before "QVl4VEdCQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo\\u003d" after'), "QVl4VEdCQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=");
});

test("parses IDs and next token from a framed zTyKYc response", () => {
  const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const inner: unknown[] = [];
  const records = [[[[first]]], [[[second]]]];
  const payload: unknown[] = [];
  payload[5] = [[records]];
  inner[0] = [[payload]];
  inner[2] = ["QVl4VEdCTkVYVFRPS0VOQUJDREVGR0hJSktMTU5PUA\\u003d"];
  const frame = [["wrb.fr", "zTyKYc", JSON.stringify(inner), null, null, null, "generic"]];
  const text = `)]}'\n\n${JSON.stringify(frame).length}\n${JSON.stringify(frame)}\n`;
  assert.deepEqual(parseRpcResponse(text), {
    ids: [first, second],
    token: "QVl4VEdCTkVYVFRPS0VOQUJDREVGR0hJSktMTU5PUA=",
  });
});
