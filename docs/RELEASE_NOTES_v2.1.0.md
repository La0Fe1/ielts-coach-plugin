# IELTS 口语教练 v2.1.0

**网页继续负责实时语音考场；豆包 / DeepSeek Harness / Codex / Claude / Cursor 通过 MCP + Skill
当你的「课前规划师 + 课后精批老师」，全部结果写回同一门课和长期记忆。**

## 新增

- **全生态 MCP（7 个工具）**：`get_learner_context`、`create_lesson`、`list_lessons`、
  `get_lesson_transcript`、`save_turn_feedback`、`save_lesson_report`、`upsert_memory`。
  双传输：Streamable HTTP（与网页同端口的 `/mcp`）和 STDIO（`ielts-mcp.bat` / `ielts-mcp.sh`）。
- **一键接入**：Windows 双击 `连接我的AI工具.bat`，macOS/Linux 运行 `./连接我的AI工具.sh`。
  自动配置 DeepSeek Harness 的 `cordis.patch.yml`、Codex 的 `config.toml`、Claude / Cursor 的
  `mcpServers`，并复制 Skill；改文件前先备份 `.bak-YYYYMMDD-HHMMSS`，完全幂等。
  支持 `--dry-run` 预览、`--url https://你的域名/mcp --token …` 一键切远程。
- **通用 Skill**：`skills/ielts-speaking-coach/SKILL.md`，中文优先双语规范，规定两条主流程
  （开课 / 精批）、7 个工具的用法、四维报告格式和「字幕是唯一事实来源」等硬规则。
- **AI 定制课**：`create_lesson` 返回 `{ lessonId, url, serverRunning, browserOpened, plan }`；
  本机 STDIO 下会探测并按需后台拉起网页服务、自动打开浏览器；网页 `/?lesson=<id>` 直接载入
  AI 的课表与历史记忆，不再随机抽题。
- **课后免费精批模式**：设置里选「交给外部 AI 工具（豆包 / dsh / Codex）」，通话中不再调用
  网页精批接口（省 API 钱），练完在外部 AI 里说「复盘刚才那节雅思课」，逐句红绿 + Band 8 升级 +
  四维报告通过 MCP 写回，网页历史立即可见。
- **共享存储与多用户隔离**：课程/记忆写入 `${IELTS_COACH_DATA_DIR:-~/.ielts-coach}/store.json`，
  网页与 MCP 双向同步；`MULTI_USER_MODE=true` 时公网访客数据只留自己浏览器，不污染共享存储。
- **部署升级**：Dockerfile 运行时镜像带上 `skills/`、`scripts/`、`ielts-mcp.bat/.sh`；
  docker-compose / render.yaml 补齐 `MCP_TOKEN`、`MULTI_USER_MODE`、`IELTS_COACH_DATA_DIR`、
  `PUBLIC_BASE_URL` 等环境变量；数据目录可挂持久卷。

## 修复（v2.0.1 走查发现的暗坑）

- `full_mock` 从 Part 1 过渡到 Part 2 时自动弹出题卡 + 60 秒准备。
- 本地历史字幕不再漏存，`startedAt` 不再被覆写。
- 精批专用 Key 选「独立 DeepSeek」会自动带出正确地址/模型，不再把 Key 发到错误域名导致 401。
- `start_session` 早退时复位状态、路由顺序修正；历史抽屉支持删除单条长期记忆。

## 升级步骤

1. `git pull` 拉取 v2.1.0；
2. `npm install`（新增 `@modelcontextprotocol/sdk`、`zod` 依赖）；
3. `npm run build`（`web/dist` 需要重建）；
4. 重新运行一次 `连接我的AI工具.bat` / `./连接我的AI工具.sh`（幂等：已存在配置会跳过或安全更新）；
5. 云端用户：**务必设置 `MCP_TOKEN`**（保护 `/mcp` 与同步接口），给朋友用建议
   `MULTI_USER_MODE=true`，并把 `IELTS_COACH_DATA_DIR` 指到持久卷；`PUBLIC_BASE_URL` 填你的域名；
6. 只给朋友用过 v2.0.x 的话不用改前端习惯，只是多了 MCP 入口 `/mcp`。

## 验收

- `npm run typecheck`：shared / server / web 全部通过。
- `npm run build`：web（tsc + vite，产物 208.98 KB / gzip 68.02 KB）与 server tsc 均通过。
- `npm test`：7 个测试文件、**56 项全部通过**，含 MCP HTTP 全链路、STDIO 纯净 stdout、
  一键接入 `--dry-run` 契约。
- 一键接入：假 home 实测 YAML/TOML/JSON 重解析通过、路径原样保留、幂等、坏 JSON 不覆盖、备份文件名正确。
- `ielts-mcp.bat`：任意 cwd 启动时 stdout 只有 JSON-RPC；缺依赖时 stdout 为空、exit 1、stderr 明确提示。
- **未实测**：真实百炼/Gemini/OpenAI/DeepSeek Key、真实豆包/dsh/Codex/Claude/Cursor 客户端 GUI、
  真机 iPhone Safari / Android、Docker 镜像构建、macOS/Linux 的 `.sh` 包装脚本、
  云端实际部署。详见 `docs/V2_DELIVERY.md`。

## 已知边界

- 远程 Streamable HTTP 部署下 `create_lesson` 不会替你开浏览器，用返回的 `url` 打开即可；
  云端请用 `PUBLIC_BASE_URL` 指向公网域名。
- 多个实例/多台机器各自有独立 `store.json`，跨机器同步不在本版范围。
- Windows 上 MCP 客户端以 `shell:false` 启动进程，不能直接执行 `.bat`，请用
  `cmd /c "…\ielts-mcp.bat"`（一键脚本生成的配置已处理）。
