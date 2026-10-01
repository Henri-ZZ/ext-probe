# 纯 HTTP Top 50 研究报告

日期：2026-10-01

## 明确结论

**A. Pure HTTP Top 50 可行。**

每个关键词默认需要 5 个 HTTP 请求：

1. 1 次普通匿名 GET，获取前 10 条和首枚 continuation token；
2. 4 次匿名 RPC POST，每次获取后续 10 条和下一枚 token。

整个流程：

- 不发送 Cookie；
- 不需要 Google 登录；
- 不需要 Chromium 或 JavaScript runtime；
- 不需要浏览器生成的 `f.sid`、`bl`、`_reqid`；
- 不需要 Client Hints 或 `X-Browser-*` headers；
- 只使用首次普通 GET 返回的 HTML 信息。

## Browser ground truth

现有 Playwright adapter 继续作为 ground truth：打开搜索页后点击 4 次“Load more”，每次增加 10 条，并验证结果卡片的显式索引从 `0` 连续到 `49`。

抓包显示每次加载更多的核心请求都是：

```text
POST https://chromewebstore.google.com/_/ChromeWebStoreConsumerFeUi/data/batchexecute
```

核心 RPC ID：

```text
zTyKYc
```

页面还可能发出 `xY2Ddd` 等详情请求和 `play.google.com/log` 日志请求，它们不是搜索分页所必需的部分。

## 完整请求链

### 1. 首次 GET

```text
GET https://chromewebstore.google.com/search/{keyword}?hl={locale}
```

首次 HTML 包含：

- 前 10 个结果卡片；
- 每张卡片的扩展 ID、详情链接和显式 `jslog index`；
- 首枚 continuation token。

token 当前表现为以 `QVl4VEdC` 开头的 Base64 风格字符串；HTML 中的结尾等号可能写成 `\u003d`，解析时需要还原。

首次 GET 响应可能返回 `Set-Cookie`，但 Node `fetch` 不保存也不回传它，后续分页仍然成功。

首次 GET 也已用 Node `fetch` 默认 headers 单独验证：HTTP 200、10 个首屏 ID 和 continuation token 均正常。`hl` URL 参数用于指定语言地区，不要求自定义 User-Agent 或 `Accept-Language`。

### 2. 分页 POST

使用的最小 URL 参数：

```text
rpcids=zTyKYc
source-path=/search/{encoded keyword}
hl={locale}
rt=c
```

浏览器实际请求还带有 `f.sid`、`bl`、`_reqid`、`soc-*` 等参数。逐步剥离后确认它们不是匿名分页的必要条件。

HTTP method：

```text
POST
```

实测必要请求头：

```http
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

纯 HTTP adapter 不发送 Cookie，也不发送 `Origin`、`Referer`、Client Hints、`X-Browser-*` 或 `X-Same-Domain`。四次分页均返回 HTTP 200。

POST body 是 `f.req` 表单字段，内部 payload 的有效部分为：

```json
[[null,[null,null,null,["KEYWORD",[10,"CONTINUATION_TOKEN"]]]]]
```

外层再按 Google `batchexecute` 格式包装 RPC ID `zTyKYc`。

### 3. RPC response

响应使用 XSSI 前缀和长度分帧：

```text
)]}'

<length>
[["wrb.fr","zTyKYc","<JSON string>",...]]
```

解析第三个字段中的 JSON 字符串后：

- 结果记录位于当前 payload 的结果数组中；
- 每条记录的第一个字段是 32 位扩展 ID；
- 下一枚 continuation token 位于当前 payload 的 `[2][0]`；
- 每页正常返回 10 条。

adapter 对全部扩展 ID 去重，并拒绝跨页重复 ID；任何 RPC、token 或结果结构异常都会使本次采集失败，不会静默输出错误排名。

## 四次分页差异

四次 `zTyKYc` 请求的固定部分：

- endpoint；
- HTTP method；
- RPC ID；
- keyword；
- locale；
- page size `10`；
- body 结构。

每次变化的必要字段只有 continuation token。第 N 次响应返回的 token 被用于第 N+1 次请求。

浏览器抓包中的 `_reqid` 会递增，`f.sid` 和前端 build label 保持不变；纯 HTTP 实验证明这些字段可以全部省略。

## page size 实验

把 page size 从 10 改成 40，服务端当前可以一次返回第 11–50 条；在本次 `web page editor / en` 对照中也与 Browser Top 50 完全一致。

生产 adapter 暂不采用该优化，原因是：

- 商店前端正常行为固定使用 10；
- 这是未公开的内部 RPC，没有 page size 兼容性承诺；
- 用户已接受每个 SERP 使用 5 个 HTTP 请求；
- 跟随页面正常分页行为更容易发现结构变化和降低意外差异。

## 严格一致性验证

### 基线：`web page editor / en`

- Browser：50 条，加载 4 批；
- HTTP：50 条，分页 4 批；
- 逐位置一致：50/50；
- Edit Page：Browser #11，HTTP #11；
- 一致率：100%。

证据：[对照 JSON](../data/research/adapter-comparison-2026-09-30T22-35-59-925Z__web-page-editor__en.json)

### 交叉验证：`edit web page / zh_CN`

- Browser：50 条，加载 4 批；
- HTTP：50 条，分页 4 批；
- 逐位置一致：50/50；
- Edit Page：Browser #9，HTTP #9；
- 一致率：100%。

证据：[对照 JSON](../data/research/adapter-comparison-2026-09-30T22-36-18-090Z__edit-web-page__zh_CN.json)

两组共比较 100 个排名位置，100 个位置完全一致。

## 实现状态

- `src/adapters/http.ts`：独立纯 HTTP adapter，不导入 Playwright 或 Node 文件系统；
- `src/adapters/browser.ts`：保留 Browser adapter，用于 ground truth、验证和人工 fallback；
- 默认 CLI 使用 `http`；
- 可用 `--adapter browser` 显式运行浏览器对照；
- HTTP adapter 固定 page size 为 10，默认 Top 50 共 5 个 HTTP 请求。

## 风险边界

`zTyKYc` 是 Chrome 应用商店前端的内部 RPC，不是公开 API。Google 可能修改：

- RPC ID；
- payload 嵌套结构；
- token 编码；
- response 记录位置；
- Cookie 或 header 要求。

因此 Browser adapter 必须保留，并应定期抽样进行 Browser/HTTP 同时段对照。HTTP adapter 发生结构错误时应明确失败，而不是根据不完整数据输出 NR。
