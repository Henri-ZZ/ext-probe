import assert from "node:assert/strict";
import test from "node:test";
import { collectHttpRanking, extractInitialToken, parseRpcResponse } from "./adapters/http.js";

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

// ---------------------------------------------------------------------------
// 初始 HTML 的续传 token 时有时无，这一组测试锁住由此而来的两个行为。
// ---------------------------------------------------------------------------

const INITIAL_ATTEMPTS = 5;
const CORPUS = "QVl4VEdCQWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";

/** 第 i 个扩展 id：32 位且只含 a–p。 */
const idAt = (index: number): string =>
  String.fromCharCode(97 + index).repeat(32);

/** 一张能被 parseOrderedSerp 认作有序 SERP 的搜索页。 */
function serpHtml(count: number, token: string | null): string {
  const cards = Array.from({ length: count }, (_, index) => {
    const id = idAt(index);
    return `<div data-item-id="${id}"><a href="./detail/x/${id}" jslog="event; index:${index}"></a></div>`;
  }).join("");
  return token ? `${cards}<script>var t="${token}"</script>` : cards;
}

/** 一个 zTyKYc RPC 响应；ids 为空数组即「结果集到头」。 */
function rpcResponse(ids: string[], token: string | null): string {
  const records = ids.map((id) => [[[id]]]);
  const payload: unknown[] = [];
  payload[5] = [[records]];
  const inner: unknown[] = [];
  inner[0] = [[payload]];
  inner[2] = [token];
  const frame = [["wrb.fr", "zTyKYc", JSON.stringify(inner), null, null, null, "generic"]];
  return `)]}'\n\n${JSON.stringify(frame).length}\n${JSON.stringify(frame)}\n`;
}

/** 记录调用次数、可自定义每个响应。 */
function stubFetch(handler: (url: string, searchCalls: number) => Response) {
  const real = globalThis.fetch;
  let searchCalls = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/search/")) searchCalls += 1;
    return handler(url, searchCalls);
  }) as unknown as typeof fetch;
  return {
    get searchCalls() {
      return searchCalls;
    },
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test("a search page without a continuation token is retried, not treated as the end", async () => {
  // 第一次不给 token，第二次给——真实商店就是这个行为。
  const stub = stubFetch((url, searchCalls) =>
    url.includes("/search/")
      ? new Response(serpHtml(10, searchCalls === 1 ? null : CORPUS), { status: 200 })
      : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 50);
    assert.equal(stub.searchCalls, 2, "第一次没有 token 时应当重试搜索页");
    assert.equal(result.reliable, true);
    assert.equal(result.items?.length, 10);
    // RPC 明确返回零条，这才是真正的「结果集到头」。
    assert.equal(result.endOfResults, true);
  } finally {
    stub.restore();
  }
});

test("giving up on the token reports an incomplete collection instead of 'not found'", async () => {
  // 始终拿不到 token：绝不能据此断定目标不在前面。
  const stub = stubFetch((url) =>
    url.includes("/search/")
      ? new Response(serpHtml(10, null), { status: 200 })
      : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 50);
    assert.equal(stub.searchCalls, INITIAL_ATTEMPTS, "应当重试到上限");
    assert.equal(result.reliable, false, "只验证了 10 条就不能声称可靠");
    assert.equal(result.items, null, "不能返回一个会被当成完整结果集的数组");
    assert.equal(result.endOfResults, false, "没有 token 不等于结果集到头");
    assert.match(result.diagnostics.join(" "), /No continuation token/);
  } finally {
    stub.restore();
  }
});

test("a first page that already covers topN needs no token", async () => {
  const stub = stubFetch((url) =>
    url.includes("/search/")
      ? new Response(serpHtml(12, null), { status: 200 })
      : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 10);
    assert.equal(stub.searchCalls, 1, "首页就够长时不该多抓");
    assert.equal(result.reliable, true);
    assert.equal(result.items?.length, 10);
  } finally {
    stub.restore();
  }
});
