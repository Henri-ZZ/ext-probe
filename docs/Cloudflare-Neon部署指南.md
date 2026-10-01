# Cloudflare + Neon 部署指南

日期：2026-10-01

本指南用于把项目提交到 GitHub，并部署为 Cloudflare Worker Cron。前端和 Vercel 不在本阶段范围内。

部署后的 Worker 名称为 `ext-probe`。

## 1. 本地确认

要求 Node.js 22 或更高版本。

```bash
npm install
npm run typecheck
npm test
npm run worker:build
```

## 2. 创建 Neon 项目

1. 在 Neon 控制台创建一个项目和数据库；区域尽量选择接近 Cloudflare 主要执行区域或目标用户的区域。
2. 在 Neon SQL Editor 中执行 `db/schema.sql` 的全部内容。
3. 获取带 `sslmode=require` 的数据库连接串。
4. 不要把真实连接串写入 `wrangler.jsonc`、README、Issue 或 GitHub Actions 日志。

本地开发时可以复制示例文件：

```bash
cp .dev.vars.example .dev.vars
```

然后只在 `.dev.vars` 中填写真实 `DATABASE_URL`。该文件已加入 `.gitignore`。

## 3. 初始化 Neon 表结构

在 Neon 控制台打开 SQL Editor，按顺序执行两个仓库的 schema：

1. 本仓库的 `db/schema.sql`，创建 `collection_batches`、`ranking_runs`、`ranking_results`；
2. ext-signal 仓库的 `db/schema.sql`，创建 `extensions`、`tracking_targets` 以及 `target_latest` 视图。

顺序不能颠倒：ext-signal 的 schema 依赖 `ranking_runs` 才能建立视图。两步都是一次性操作，重复执行不会删除已有数据。

执行后确认六张表和一个视图已经出现：

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'collection_batches', 'ranking_runs', 'ranking_results', 'extension_profiles',
    'extensions', 'tracking_targets', 'target_latest'
  )
ORDER BY table_type, table_name;
```

Worker 会从 `tracking_targets` 读取采集任务，所以如果这张表不存在或没有任何启用的目标，Cron 会正常运行但不会采集任何数据。

## 4. 准备 Cloudflare 自动部署凭据

1. 登录 Cloudflare，进入 **My Profile → API Tokens → Create Token**。
2. 选择 **Edit Cloudflare Workers** 模板。
3. 把 Account Resources 限定为实际部署 Worker 的那个账号。
4. 创建后立即复制 token；Cloudflare 只显示一次。
5. 在 Cloudflare 控制台复制该账号的 Account ID。

不要使用 Global API Key，也不要把 token 或 Account ID 写进仓库。

## 5. 配置 GitHub Secrets

进入 GitHub 仓库：**Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret 名称 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `DATABASE_URL` | Neon 提供的完整 PostgreSQL 连接串，包含 `sslmode=require` |
| `MANUAL_TRIGGER_TOKEN` | 自行生成的随机手动触发密钥，例如 `openssl rand -hex 32` 的输出 |

GitHub Actions 会在 runner 中生成一个临时 secret 文件，并通过 `wrangler deploy --secrets-file` 将代码和 `DATABASE_URL` 原子部署。临时文件会在成功或失败后清理，不会进入 Git。这样首次部署时不需要预先创建 Worker。

Secret 名称区分大小写，必须准确写成表格中的名称。四项都应建立在 **Repository secrets** 中，不能放入 GitHub Variables。

另在 **Settings → Secrets and variables → Actions → Variables** 添加一个 Repository Variable：

| Variable 名称 | 内容 |
| --- | --- |
| `WORKER_URL` | Worker 的公开地址，例如 `https://ext-probe.<你的子域>.workers.dev` |

## 6. 首次部署与以后自动部署

把代码 push 到 `main`：

```bash
git push origin main
```

工作流会依次执行：

1. 安装依赖；
2. TypeScript 类型检查；
3. 自动测试；
4. Worker dry-run 构建；
5. 前四步全部通过后部署到 Cloudflare；
6. 同步 `DATABASE_URL` Worker secret；
7. 应用 `wrangler.jsonc` 中的三个 Cron Trigger。

Pull request 只运行检查，不部署。也可以在 GitHub 的 **Actions → 持续集成 → Run workflow** 手动重试部署。

### 手动立即采集

完成 `MANUAL_TRIGGER_TOKEN` 和 `WORKER_URL` 配置并重新部署一次后，进入：

```text
GitHub → Actions → 手动采集 → Run workflow
```

可以选择连续触发 1、3 或 6 轮，每轮仍只处理 6 组最久未采集的任务，因此不会突破单次 50 个子请求限制。

也可以直接请求 Worker：

```bash
curl -X POST "$WORKER_URL/admin/run" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN"
```

`batch` 参数可以覆盖本次批次大小（1–10），例如 `/admin/run?batch=10`。旧版的 `shard` 参数已不再使用，会被忽略。

Worker 只接受带正确 Bearer Token 的 `POST /admin/run`；未配置 token 返回 503，token 错误返回 401，`batch` 越界返回 400。不要把 token 放入 URL、仓库代码或 GitHub Variable。

## 7. 定时设置

`wrangler.jsonc` 默认配置：

```json
{
  "triggers": {
    "crons": ["*/15 * * * *"]
  }
}
```

Cloudflare Cron 使用 UTC，最小粒度是 1 分钟。Worker 每 15 分钟检查一次数据库，只采集「从未成功采集过」或「距上次成功采集超过 `REFRESH_HOURS`（默认 20 小时）」的 (keyword, locale) 组，按最久未采集优先，单次最多 `BATCH_SIZE`（默认 6）组。

因此新增扩展或关键词后不需要改代码或重新部署，下一次 Cron 就会开始采集；目标数量增长时覆盖率会自然摊开。修改 Cron 后重新部署，配置最多可能需要约 15 分钟传播。

每个批次最多 6 组、约 30 个子请求，低于 Workers Free 单次 50 个的限制。每天 96 次调用的请求量也远低于 Free 计划每日 10 万次请求的额度。

## 8. 本地模拟 Cron

准备好 `.dev.vars` 并初始化数据库后：

```bash
npm run worker:dev
```

另开终端触发一次本地 scheduled handler：

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+2+*+*+*&format=json"
```

这会真实请求 Chrome 应用商店并写入所配置的 Neon 数据库。不要用生产数据库反复测试。

健康检查：

```bash
curl "http://localhost:8787/health"
```

## 9. 验证数据

在 Neon SQL Editor 中运行：

```sql
SELECT scheduled_at, shard_index, shard_count,
       status, succeeded_count, failed_count
FROM collection_batches
ORDER BY scheduled_at DESC
LIMIT 10;
```

查看 Edit Page 排名历史：

```sql
SELECT collected_at, keyword, locale,
       COALESCE(target_rank::text, 'NR') AS rank,
       not_found_within
FROM ranking_runs
WHERE status = 'success'
ORDER BY collected_at DESC, locale, keyword
LIMIT 100;
```

查看某次完整 Top 50：

```sql
SELECT rr.position, rr.extension_id
FROM ranking_results rr
WHERE rr.run_id = '替换为 ranking_runs.id'
ORDER BY rr.position;
```

## 10. 首次提交 GitHub

当前目录若尚未初始化 Git：

```bash
git init
git branch -M main
git add .
git commit -m "feat: prepare Cloudflare cron and Neon storage"
```

然后在 GitHub 创建空仓库，并按 GitHub 页面给出的地址连接和推送：

```bash
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
```

仓库中的 CI 会在 push 和 pull request 时执行类型检查、测试和 Worker dry-run 构建。push 到 `main` 时，检查通过后会自动部署。

## 11. 暂不处理的内容

- 不创建 Vercel 项目；
- 不创建前端页面；
- 不启用 Browser Run；
- 不创建预览环境。

等前端需求明确后，再基于 Neon 数据表设计查询 API 和页面即可。

## 12. 官方资料

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare GitHub Actions 部署](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Neon：在 Cloudflare Workers 中使用 serverless driver](https://neon.com/blog/api-cf-drizzle-neon)
