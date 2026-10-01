# Chrome 应用商店排名探测工具

这是一个 Node.js + TypeScript 实验工具，用于验证和采集 Chrome 应用商店（Chrome Web Store，简称 CWS）的搜索结果顺序。

当前默认 Top 50 使用纯 HTTP：首次普通 GET 获取前 10 条和 continuation token，随后进行 4 次匿名分页 POST。它不需要浏览器、Cookie、Google 登录或代理。Browser adapter 仍保留用于 ground truth 和回退验证。

项目现已包含 Cloudflare Worker 定时入口和 Neon PostgreSQL 存储，可每天自动采集 9 个关键词 × 2 个语言地区。为遵守 Workers Free 单次 50 个子请求限制，每天的 18 组任务固定拆成 3 个 Cron 分片，每次只跑 6 组。Vercel 和前端暂未接入。详见 [Cloudflare + Neon 部署指南](docs/Cloudflare-Neon部署指南.md)、[纯 HTTP Top 50 研究报告](docs/纯HTTP-Top50研究报告.md) 和 [Cloudflare 部署架构](docs/Cloudflare部署架构.md)。

## 当前能做什么

- 请求指定关键词和语言地区的 Chrome 应用商店搜索页。
- 判断返回的是正常页面、限流、验证码、同意页还是其他异常页面。
- 保存原始 HTML，方便后续核查。
- 提取符合 CWS 扩展 ID 格式的字符串，但不会把原始 ID 出现顺序误认为搜索排名。
- 只有在页面包含可信的显式结果索引时，才输出有序搜索结果和目标扩展排名。
- 默认通过纯 HTTP 加载并检查前 50 条结果。
- 支持单次探测、关键词矩阵实验和重复性实验。

当前跟踪的目标扩展是 **Edit Page**，扩展 ID：

```text
edjbgblhciojhakodeflnpampekciifl
```

## 环境要求

- Node.js 20 或更高版本
- npm
- 只有使用 `--adapter browser` 时才需要 macOS 上安装 Google Chrome

安装依赖：

```bash
npm install
```

## 用法

### 1. 单次探测

指定关键词和语言地区，执行一次查询：

```bash
npm run probe -- --keyword "page editor" --locale en
```

中文地区示例：

```bash
npm run probe -- --keyword "page editor" --locale zh_CN
```

默认检查前 50 名。需要指定其他深度时使用 `--top-n`：

```bash
npm run probe -- --keyword "page editor" --locale en --top-n 30
```

默认 adapter 是纯 HTTP。需要运行浏览器 ground truth 时：

```bash
npm run probe -- --keyword "page editor" --locale en --adapter browser
```

参数说明：

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `--keyword` | 搜索关键词；单次探测时必填 | `"page editor"` |
| `--locale` | CWS 页面语言地区 | `en`、`zh_CN` |
| `--top-n` | 最多检查前多少名 | `50` |
| `--adapter` | `http` 或 `browser`；默认不启动浏览器 | `http` |

命令会在终端输出 HTTP 状态码、响应大小、耗时、页面分类、原始 ID 探查结果、解析可信度，以及可信情况下的 Edit Page 排名。

生成文件：

```text
data/debug/    原始 HTML 和目标扩展附近的文本片段
data/results/  JSON 格式的结构化结果
```

### 2. 关键词矩阵实验

默认按顺序测试 9 个已知关键词，并分别请求 `en` 和 `zh_CN`。每次请求之间等待 5 秒：

```bash
npm run matrix
```

只测试英文，并将请求间隔改为 10 秒：

```bash
npm run matrix -- --locales en --delay-ms 10000
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--locales` | 用逗号分隔的语言地区列表 | `en,zh_CN` |
| `--delay-ms` | 两次查询之间的等待时间，单位为毫秒 | `5000` |
| `--top-n` | 每个关键词最多检查前多少名 | `50` |

矩阵输出中的排名含义：

- 数字：解析可靠，且找到了 Edit Page；
- `NR`（Not Ranked within checked range）：解析可靠，但 Edit Page 不在已检查范围内。默认范围为前 50名；
- `unknown`：页面已获取，但解析器无法可靠确认顺序；
- `not-run`：该组合尚未执行。

如果遇到 HTTP 429、验证码、同意页、HTTP 错误或非预期页面，工具会保存证据并停止继续请求。

### 3. 重复性实验

默认连续执行 3 次，最多允许 5 次，用于比较同一关键词的 Top N 结果是否稳定：

```bash
npm run repeat -- --keyword "page editor" --locale en --repeats 3 --top-n 10 --delay-ms 8000
```

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--keyword` | 搜索关键词；必填 | 无 |
| `--locale` | 页面语言地区 | `en` |
| `--repeats` | 重复次数，最大为 5 | `3` |
| `--top-n` | 采集并对比前多少条结果 | `50` |
| `--delay-ms` | 两次请求之间的等待时间，单位为毫秒 | `8000` |

只有每次请求都得到可靠的有序结果时，实验才会标记为可比较（`comparable: true`）。如果其中任何一次无法可靠解析，工具会返回不可比较，而不会猜测结果。

## NR 的准确含义

`NR` 是 **Not Ranked within checked range** 的缩写，即“在已检查范围内未上榜”。

默认 `--top-n 50` 时，NR 表示工具已经可靠解析前 50 名，但没有找到 Edit Page；它不表示该扩展在整个 Chrome 应用商店中完全没有排名。如果页面异常、索引不连续或没有完成目标深度，工具会输出 `unknown`，不会误报 NR。

结构化结果还会记录：

- `requestedTopN`：计划检查的深度；
- `collectedCount`：实际采集条数；
- `loadedBatches`：点击“加载更多”的次数；
- `complete`：是否可靠完成目标范围；
- `notFoundWithin`：输出 NR 时实际确认未找到的范围；
- `endOfResults`：是否已经到达搜索结果末尾。

## 开发检查

运行类型检查：

```bash
npm run typecheck
```

运行测试：

```bash
npm test
```

验证 Cloudflare Worker 能否成功打包：

```bash
npm run worker:build
```

## 云端定时采集

生产入口位于 `src/worker.ts`。默认在每天 `02:00`、`02:20`、`02:40 UTC`（北京时间 `10:00`、`10:20`、`10:40`）分别执行一个分片。每组关键词和语言每天只采集一次 Top 50，并写入 Neon。

主要文件：

| 文件 | 用途 |
| --- | --- |
| `wrangler.jsonc` | Cloudflare Worker、Cron 和非敏感参数 |
| `src/worker.ts` | 定时采集与 Neon 写入入口 |
| `db/schema.sql` | Neon 数据库初始化结构 |
| `.dev.vars.example` | 本地数据库连接串示例，不包含真实密码 |
| `.github/workflows/ci.yml` | GitHub 自动测试和构建检查 |

创建 Neon 和 Cloudflare 项目后的完整上线步骤见 [Cloudflare + Neon 部署指南](docs/Cloudflare-Neon部署指南.md)。数据库连接串必须通过 Cloudflare secret 保存，不能写进仓库。

如果受限执行环境不允许 `tsx` 创建 IPC 管道，可以使用等价命令：

```bash
node --import tsx --test src/parser.test.ts
```

## 解析原则

原始 ID 只表示页面里出现了符合 32 位 `a-p` 格式的字符串，不能据此断言它们构成有序搜索结果。

当前解析器会检查结果卡片是否同时具备：

1. `data-item-id` 扩展 ID；
2. 指向同一扩展 ID 的详情链接；
3. 明确的零起始 `jslog` 索引；
4. 唯一且连续的索引序列。

只有这些条件全部满足时，`parsedSerp` 才会包含有序结果。否则它为 `null`，排名显示为 `unknown`。这种设计宁可不给排名，也不会根据不可靠的 HTML 出现顺序猜排名。

## 首屏实验发现（2026-09-30）

目前已按顺序完成两次受控请求。两次都是普通匿名 HTTP 请求，并且都返回了正常的 CWS 页面，没有出现同意页、验证码或限流。

| 关键词 | 语言地区 | HTTP | 字节数 | 耗时 | 原始 ID 数 | 已解析结果数 | Edit Page 排名 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `page editor` | `en` | 200 | 541,489 | 632 毫秒 | 10 | 10 | 8 |
| `page editor` | `zh_CN` | 200 | 542,005 | 668 毫秒 | 10 | 10 | 9 |

两份 HTML 都包含带 `data-item-id` 的结果卡片、匹配的扩展详情链接以及显式的零起始 `jslog` 索引。两组索引均唯一且从 0 连续到 9。解析器验证这些条件、按显式索引排序后，才报告排名。

Edit Page 在英文样本中的索引为 7，在简体中文样本中的索引为 8，因此对应排名分别为第 8 和第 9。这说明：对于这两份样本，直接解析 HTTP HTML 可以恢复页面中可见的十条结果顺序。

这还不能证明该方法长期稳定。虽然解析器没有依赖 CSS 类名，但 `jslog` 仍属于页面内部实现细节。当前也没有输出标题，因为详情链接中的 slug 可能被截断；只有确认页面内嵌数据的记录结构后，才应映射精确标题。

以下矩阵是升级前的 Top 10 首屏实验，历史报告中的 NR 只表示“不在前 10”。后续验证已完成：

- `page editor` / `en` 连续执行 3 次，三次 Top 10 顺序完全一致，Edit Page 均为第 8 名。
- 完整的 9 关键词 × 2 语言地区矩阵共 18 次请求全部返回正常页面，且全部通过可靠性校验。
- 浏览器实际渲染的 `page editor` 结果与 HTTP 解析结果一致：英文第 8 名，简体中文第 9 名。

完整数据和对照说明见 [验证报告](docs/验证报告-2026-09-30.md)。

默认纯 HTTP Top 50 已完成严格验证：`web page editor / en` 和 `edit web page / zh_CN` 共 100 个排名位置均与同时段 Browser ground truth 完全一致。前者 Edit Page 排名第 11，后者排名第 9。

## 下一步验证

1. 解码并验证页面内嵌结果数组的数据结构，尤其是精确标题和排序字段。
2. 在不同日期重复运行小规模实验，验证长期稳定性。
3. 增加自动化的浏览器渲染对照，避免页面结构变化后只依赖人工检查。

关于采集第 10 名以后的研究、方案比较和建议接口，见 [扩大排名采集范围方案](docs/扩大排名采集范围方案.md)。

## 文档语言约定

本项目文档默认使用中文。命令、参数、代码标识符和无法准确翻译的技术术语保留英文；如果文档需要面向英文读者，应提供中英双语内容，不再编写纯英文项目文档。
