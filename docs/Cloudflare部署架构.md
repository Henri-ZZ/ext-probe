# Cloudflare 部署架构

日期：2026-10-01

## 结论

生产采集不需要 Chromium。Cloudflare Worker 直接复用 `src/adapters/http.ts`：每组搜索先请求一次 Chrome 应用商店 HTML，再进行最多 4 次匿名分页 RPC，得到 Top 50。

首版采用以下链路：

```text
Cloudflare Cron Trigger
  → Worker scheduled() 入口
  → 9 个关键词 × 2 个语言地区
  → 每组 1 GET + 4 POST
  → Neon PostgreSQL
```

Browser adapter 只保留在本地，用于偶尔与真实渲染结果做 ground truth 对照，不参与线上定时任务。

## 为什么使用 Neon

Neon 提供 PostgreSQL，并有可在 Cloudflare Workers 中使用的 serverless driver。当前实现通过 `@neondatabase/serverless` 的 HTTP 查询接口写库，不需要持有传统 TCP 连接。

数据库分成三张表：

- `collection_batches`：一次 Cron 批次的开始时间、结束时间和成功/失败数量；
- `ranking_runs`：一个关键词和语言的一次采集摘要，包括 Edit Page 排名、NR 范围、耗时和错误；
- `ranking_results`：该次采集的完整 Top 50 扩展 ID 顺序。

完整榜单采用正规化行存储，后续前端既能画目标扩展排名趋势，也能查询任意竞品的历史位置。

## Cloudflare 限制

默认完整矩阵会产生大约：

- 90 个 Chrome 应用商店请求：18 组 × 每组 5 个；
- 约 21 个 Neon 请求：批次开始/结束，加每组一次写入；
- 合计约 111 个外部子请求。

Cloudflare Workers Free 当前每次调用最多 50 个子请求，Paid 为 10,000 个，因此当前“一次 Cron 跑完整矩阵”的实现需要 Workers Paid。等待外部网络不计入 CPU 时间，但 Cron 单次墙钟时间上限为 15 分钟。

如果要坚持 Free，可以在下一阶段把 18 组任务拆到 Queue、Workflow 或多个独立调用中；当前没有为了规避限制而增加这层复杂度。

## 排名可比性风险

迁移到 Cloudflare 后，出口网络与本机不同。Chrome 应用商店排序可能受 `hl`、出口地区、服务端实验和采集时间影响。因此云端结果代表“Cloudflare 运行环境在该时刻看到的排名”，不应默认等同于某个本地用户的个性化结果。

迁移初期建议每周在本机用 Browser adapter 抽查一组关键词，与云端同时间窗口结果对照。

## 安全边界

- Neon `DATABASE_URL` 只保存为 Cloudflare secret；
- `.dev.vars` 已被 Git 忽略；
- Worker 对外只提供 `/health`，不提供匿名手动采集接口；
- Cron 配置和普通参数进入版本库，真实密钥不进入版本库；
- 线上不使用验证码绕过、Google 账号、代理或其他反爬规避。

## 后续扩展

Vercel 和前端暂不创建。需要查询页面时，可直接读取 Neon；届时再决定使用 Vercel、Cloudflare Pages 或其他前端平台，不影响现有采集和数据结构。

## 官方资料

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Neon serverless driver GA](https://neon.com/blog/serverless-driver-ga)
