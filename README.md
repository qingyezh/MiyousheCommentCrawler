# 米游社评论区爬虫

TypeScript + pnpm 实现。输入米游社帖子 URL，爬取帖子信息、一级/二级评论（含 `comment_type=root|child`），可选爬取用户主页 `level_exps`，生成中文列名 CSV，并自动绘制分析图表。

## 快速开始

```powershell
# 1. 配置 cookie + 目标
# - 复制 app/config/config.example.yaml -> app/config/config.yaml 并填写
# - 或设置环境变量 $env:MIYOUSHE_COOKIE = "..."

# 2. 在 config.yaml 的 crawl 节填好目标后，一键运行（爬完自动分析）：
pnpm run crawl

# 3. 或临时用命令行覆盖配置：
pnpm run crawl -- --url "https://www.miyoushe.com/ys/article/79085282" --users --ana true
```

### 配置优先级

CLI 参数 > `app/config/config.yaml` 的 `crawl` 节 > `default.yaml`

```yaml
cookie: "..."
crawl:
  url: "https://www.miyoushe.com/ys/article/xxxxxx"
  users: true
  includeChild: true
  maxRootPages: 0
  maxUsers: 0
  analysis: true          # 爬完自动分析出图
```

## 输出文件（每个帖子一套）

稳定目录：`app/data/results/<帖子ID>/`

| 文件                 | 说明                                                            |
| -------------------- | --------------------------------------------------------------- |
| `帖子基本信息.csv` | 帖子标题/作者/统计等                                            |
| `评论数据.csv`     | 含 `评论类型` = root/child；**始终统计去重用户数**      |
| `用户数据.csv`     | 去重用户 + 各游戏等级 + 性别/IP/注册时间                        |
| `总结统计.csv`     | 评论总览 + IP/性别 + 各游戏游玩率                               |
| `summary.json`     | 机器可读总结                                                    |
| `analysis/`        | 分析产物：`analysis.html`、`分析汇总.csv`、`charts/*.svg` |

CSV 均为 UTF-8 BOM + 中文列名。同时会在 `app/data/runs/<runId>/final/` 归档，并生成 `report.xlsx`。

### 分析图表

- SVG 源文件：`analysis/charts/svg/*.svg`
- PNG 导出：`analysis/charts/*.png`（用系统字体渲染中文）
- 关键图：
  - `游戏活跃度_0`：全量样本活跃率（level≥阈值 或 exp>0）
  - `游戏活跃度_1`：排除该游戏社区等级=1 用户后的活跃率
  - `ip分布` / `性别分布` / `注册时间分布` / `游戏等级_<游戏名>` / `评论类型` / `高赞作者`
- 打开 `analysis/analysis.html` 可一页总览（嵌入 PNG）

`总结统计.csv` / `分析汇总.csv` 同时写入 `_0` 与 `_1` 两套百分比。

## 实时监控（浏览器曲线）

```powershell
pnpm run monitor -- --url "https://www.miyoushe.com/ys/article/xxx" --interval 2
```

- 每 2 秒拉取浏览/点赞/评论
- 终端打印数值与 sparkline
- 浏览器打开 `http://127.0.0.1:18765/` 看实时曲线 + 增长曲线
- 结束（Ctrl+C）后默认导出：
  - `app/data/results/<id>/monitor/原始曲线.svg`
  - `app/data/results/<id>/monitor/增长曲线.svg`
  - `app/data/results/<id>/monitor/时间序列.csv`

可选参数：`--port 18765` `--window 180` `--max 5000`

## 中途快照分析

爬取进行中可另开终端生成临时分析（**不改 checkpoint**，不影响 crawl/resume）：

```powershell
pnpm run partial
# 或
pnpm run partial -- --checkpoint app/data/checkpoint.json
```

输出目录：

```text
app/data/results/<帖子ID>/analysis-partial/
```

可与爬取并行；从当前 `runs/<runId>/batches/` 批次只读分析。

## 分析命令

爬完默认自动分析（`crawl.analysis: true` / `--ana true`）。也可对已有结果重跑：

```powershell
# 数字帖子 ID
pnpm run analysis -- --id 79085282

# 或路径（绝对/相对）
pnpm run analysis -- --id app\data\results\79085282
pnpm run analysis -- --id D:\Desktop\program\preoject\米游社\app\data\results\79085282
```

crawl 时控制是否分析：

```powershell
pnpm run crawl -- --ana true    # 默认（config.crawl.analysis）
pnpm run crawl -- --ana false   # 跳过分析
pnpm run crawl -- --ana 1
pnpm run crawl -- --ana 0
```

## 断点续爬

运行中若中断（Ctrl+C / 崩溃），进度写在：

- `app/data/checkpoint.json` — 当前 phase、`rootLastId`、已完成楼层、用户完成数
- `app/data/runs/<runId>/batches/` — 已落盘的评论/用户批次 jsonl

续爬：

```powershell
pnpm run resume
# 或指定 checkpoint
pnpm run resume -- --checkpoint app/data/checkpoint.json
```

说明：

1. 续爬会**复用** checkpoint 里的 `runId`，继续写同一批次目录，避免重复用户。
2. 已写入的评论会重建内存 uid 去重集合。
3. 已完成的用户主页批次会跳过。
4. 成功结束时 `checkpoint.phase=done`。

## 常用参数

```powershell
pnpm run crawl -- --url <URL> --users          # 开主页
pnpm run crawl -- --url <URL> --max-pages 3    # 限制一级评论页数
pnpm run crawl -- --url <URL> --max-users 100  # 限制主页用户数
pnpm run crawl -- --ana false                  # 不自动分析
pnpm run resume                                # 断点续爬
pnpm run report                                # 仅重出报表
pnpm run analysis -- --id 79085282             # 对已有数据分析
```

## 请求间隔与限流

- 评论区：`1.2s`（`intervals.commentMs`）
- 主页：`0.8s`（`intervals.userMs`）
- 限流处理：
  1. 一次「命中限流 → 重试成功或最终失败」只记 **1 次限流事件**
  2. 每次事件：该池请求间隔 **+50ms**，累计额外间隔上限 **1500ms**
  3. 事件内重试仍用斐波那契等待（最多 `rateLimitMaxRetries=6` 次）
  4. **每 3 次事件**暂停：5 分钟，其后每次 +3 分钟，封顶 **20 分钟**


## 日志

- 按天：`app/log/app-YYYY-MM-DD.log`（按配置时区命名）
- 启动时把超过 `log.historyDays`（默认 3 天）的旧日志挪到 `app/log/history/`
- 时间偏移：`log.timezoneOffset`，默认 `UTC+8`
  合法值：`UTC` / `UTC+0` ~ `UTC+23`；非法值自动回落 `UTC`
