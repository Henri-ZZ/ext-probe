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
// 商店的两种间歇性行为，以及由此而来的「必须报不可靠、不能报未找到」。
// ---------------------------------------------------------------------------

const INITIAL_ATTEMPTS = 5;
const CORPUS = "QVl4VEdCQWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";

/** 第 i 个扩展 id：32 位且只含 a–p。 */
const idAt = (index: number): string => String.fromCharCode(97 + index).repeat(32);

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

/** 记录搜索页调用次数；handler 可据 url / 次数 / 请求体决定返回什么。 */
function stubFetch(handler: (url: string, searchCalls: number, body: string) => Response) {
  const real = globalThis.fetch;
  let searchCalls = 0;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("/search/")) searchCalls += 1;
    const body = typeof init?.body === "string" ? init.body : "";
    return handler(url, searchCalls, body);
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

const FIRST_PAGE = Array.from({ length: 10 }, (_, index) => idAt(index));

test("a search page that carries no result list is retried", async () => {
  // 商店有时返回分类正常、却一个扩展 ID 都没有的 HTML。
  const stub = stubFetch((url, searchCalls) =>
    url.includes("/search/")
      ? new Response(searchCalls === 1 ? "<html><body>no serp here</body></html>" : serpHtml(12, null), { status: 200 })
      : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 10);
    assert.equal(stub.searchCalls, 2, "解析不出结果页时应当重试");
    assert.equal(result.reliable, true);
    assert.equal(result.items?.length, 10);
  } finally {
    stub.restore();
  }
});

test("a missing HTML token is recovered by bootstrapping the RPC", async () => {
  // 初始 HTML 常常不带续传 token；用空 token 调 RPC 可以换到它，分页因此自举。
  let rpcCalls = 0;
  const stub = stubFetch((url) => {
    if (url.includes("/search/")) return new Response(serpHtml(10, null), { status: 200 });
    rpcCalls += 1;
    // 第 1 次（自举）给第 1 页 + 续传 token；第 2 次给零条，即结果集到头。
    return new Response(rpcCalls === 1 ? rpcResponse(FIRST_PAGE, CORPUS) : rpcResponse([], null), { status: 200 });
  });

  try {
    const result = await collectHttpRanking("edit page", "ja", 50);
    assert.equal(stub.searchCalls, 1, "页面可用时不该为 token 反复重抓");
    assert.equal(result.reliable, true);
    assert.equal(result.items?.length, 10);
    assert.equal(result.endOfResults, true);
    assert.match(result.diagnostics.join(" "), /bootstrapped/);
  } finally {
    stub.restore();
  }
});

test("an unusable bootstrap reports an incomplete collection instead of 'not found'", async () => {
  // 页面没有 token、自举也拿不到：绝不能据此断定目标不在前面。
  const stub = stubFetch((url) =>
    url.includes("/search/")
      ? new Response(serpHtml(10, null), { status: 200 })
      : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 50);
    assert.equal(stub.searchCalls, 1);
    assert.equal(result.reliable, false, "只验证了 10 条就不能声称可靠");
    assert.equal(result.items, null, "不能返回一个会被当成完整结果集的数组");
    assert.equal(result.endOfResults, false, "拿不到 token 不等于结果集到头");
    assert.match(result.diagnostics.join(" "), /No continuation token/);
  } finally {
    stub.restore();
  }
});

test("no usable search page at all is reported as such", async () => {
  const stub = stubFetch((url) =>
    url.includes("/search/") ? new Response("<html>nope</html>", { status: 200 }) : new Response(rpcResponse([], null), { status: 200 }),
  );

  try {
    const result = await collectHttpRanking("edit page", "ja", 50);
    assert.equal(stub.searchCalls, INITIAL_ATTEMPTS, "应当重试到上限");
    assert.equal(result.reliable, false);
    assert.equal(result.items, null);
    assert.match(result.diagnostics.join(" "), /No search page with an ordered result list/);
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
