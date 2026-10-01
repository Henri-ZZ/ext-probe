# Cloudflare + Neon 部署指南

日期：2026-10-01

本指南用于把项目提交到 GitHub，并部署为 Cloudflare Worker Cron。前端和 Vercel 不在本阶段范围内。

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

## 3. 创建并登录 Cloudflare

登录：

```bash
npx wrangler login
```

先设置 Neon 连接串为加密 secret；如果 Worker 还不存在，Wrangler 会引导创建：

```bash
npx wrangler secret put DATABASE_URL
```

`wrangler secret put` 会创建并部署新的 Worker 版本。输入时粘贴 Neon 连接串，不要把连接串作为命令行参数。

然后部署代码，以确认 secret 和 Cron 配置都已生效：

```bash
npm run worker:deploy
```

## 4. 定时设置

`wrangler.jsonc` 默认配置：

```json
{
  "triggers": {
    "crons": ["0 2 * * *"]
  }
}
```

Cloudflare Cron 使用 UTC。该表达式表示每天 `02:00 UTC`，即北京时间每天 `10:00`。修改后重新部署，配置最多可能需要约 15 分钟传播。

当前完整矩阵约有 111 个外部子请求，超过 Workers Free 每次调用的 50 个限制，因此需要 Workers Paid。若暂时只用 Free，不应直接上线完整矩阵，应先把任务拆分。

## 5. 本地模拟 Cron

准备好 `.dev.vars` 并初始化数据库后：

```bash
npm run worker:dev
```

另开终端触发一次本地 scheduled handler：

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```

这会真实请求 Chrome 应用商店并写入所配置的 Neon 数据库。不要用生产数据库反复测试。

健康检查：

```bash
curl "http://localhost:8787/health"
```

## 6. 验证数据

在 Neon SQL Editor 中运行：

```sql
SELECT scheduled_at, status, succeeded_count, failed_count
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

## 7. 提交 GitHub

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

仓库中的 CI 会在 push 和 pull request 时执行类型检查、测试和 Worker dry-run 构建。当前未配置 GitHub 自动部署，以免在 Cloudflare/Neon 项目尚未建立时要求生产密钥。

## 8. 暂不处理的内容

- 不创建 Vercel 项目；
- 不创建前端页面；
- 不在 GitHub Actions 中保存 Neon 连接串；
- 不启用 Browser Run；
- 不配置自动生产部署。

等前端需求明确后，再基于 Neon 数据表设计查询 API 和页面即可。

## 9. 官方资料

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Neon：在 Cloudflare Workers 中使用 serverless driver](https://neon.com/blog/api-cf-drizzle-neon)
