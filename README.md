# douyin-creator-tools

> 本文件面向 OpenClaw, OpenClaw 读到此仓库时按本文件指引操作。
> 碳基生物读到此文件时可以将本仓库地址丢给 OpenClaw, 让 OpenClaw 来加载此技能

本仓库基于 Playwright 做抖音创作者中心自动化，供 OpenClaw 通过内置 skill 调度。支持获取作品列表、导出指定作品的未回复评论、模型逐条决策回复，以及按 JSON 批量回复。

## 仓库位置

固定 clone 到 OpenClaw 目录下：

```bash
cd ~/.openclaw
git clone https://github.com/wenyg/douyin-creator-tools.git
```

下文 `$PROJECT_DIR = ~/.openclaw/douyin-creator-tools`。Skill 文件位于 `$PROJECT_DIR/skills/douyin-creator/`，由 OpenClaw 加载（加载机制由 OpenClaw 自行处理，无需人工配置）。

## 首次初始化

在 `$PROJECT_DIR` 下按序检查并补齐：

| 检查                                        | 补齐动作                                                       |
| ------------------------------------------- | -------------------------------------------------------------- |
| `node -v` >= v22                            | 缺则停，让用户升级 Node                                        |
| `node_modules/` 存在                        | 缺则 `npm install`                                             |
| `npx playwright --version` 且 chromium 可用 | 缺或报错 missing chromium → `npx playwright install chromium`  |
| `.playwright/douyin-profile/` 存在          | 缺则停，**让用户本人执行 `npm run auth` 扫码**，Agent 不得替代 |

命令运行中报「需要登录 / 跳转到登录页」→ 停止，要求用户重新 `npm run auth`。

## 能力

| 命令                                           | 位置参数                        | 输出                                               |
| ---------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| `npm run auth`                                 | -                               | `.playwright/douyin-profile/`（用户本人扫码）      |
| `npm run works`                                | -                               | `comments-output/list-works.json`                  |
| `npm run comments:export -- "<作品标题>"`      | 作品标题                        | `comments-output/unreplied-comments.json`          |
| `npm run comments:interactive -- "<作品标题>"` | 作品标题；stdin 写入 JSONL 决策 | `comments-output/interactive-comments-result.json` |
| `npm run comments:reply -- <plan.json>`        | JSON 路径                       | `comments-output/reply-comments-result.json`       |

命令的详细 I/O 结构、字段硬约束见 `skills/douyin-creator/SKILL.md`。

`npm run` 的参数一定放在 `--` 之后，否则被 npm 吞掉。

### 逐条模型决策

`comments:interactive` 保持一个浏览器会话：发现一条未回复评论后，通过 stdout 输出 `comment_found` JSONL 事件，并暂停等待 stdin 决策；收到 `reply`、`skip` 或 `stop` 后执行并输出 `result`，再继续下一条。适合 OpenClaw 用后台 `exec` 配合 `process write` 驱动，避免先批量导出、一次性生成全部回复。

```bash
npm run --silent comments:interactive -- --mode smart --limit 10 "作品完整标题"
```

每个 `comment_found.requestId` 必须原样写回，例如：

```json
{ "requestId": "...", "action": "reply", "replyMessage": "回复正文", "reason": "简短依据" }
```

浏览器默认可见。用 `--preview` 只验证逐条决策而不输入或发送；完整协议见 `npm run comments:interactive -- --help`。批量导出/回复命令继续保留，适合人工预审或更低 token 成本的场景。

### 回复去重保护

回复流程会同时检查数据库、独立追加式台账和网页上的回复标记。独立台账位于
`comments-output/reply-ledger.jsonl`（可用环境变量 `REPLY_LEDGER_PATH` 改路径）；发送前会先同步落盘，
即使 SQLite 数据库丢失、抖音网页又没有显示旧回复，也会保守跳过，避免自动重复发送。

请把这个台账和 `data/douyin-creator.db` 一起纳入备份，不要在回复任务之间删除它。

## 硬约束

- 不绕过登录、验证码、平台风控
- 复用 `.playwright/douyin-profile`，**不要清空或替换**登录态目录
- 页面结构变化导致命令失败时，让用户先人工核查，**不要改 `src/` 代码去"修复"**
- 不生成引流、外链、联系方式、敏感词等违规内容
- Agent 绝不替用户扫码登录
