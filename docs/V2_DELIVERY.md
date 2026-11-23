# v2.0.0 交付说明（实时语音网页版）

## 一、已真实验证

| 项目 | 证据 |
| --- | --- |
| 依赖安装 | npm install 0 报错 |
| 类型检查 | npm run typecheck：shared / server / web 全部 0 报错 |
| 前端构建 | vite build 通过，产物 190 KB（gzip 62 KB） |
| 网关构建 | tsc --noEmit 通过 |
| 单元/协议测试 | npm test：12 项全绿 |
| 生产服务 | node server/src/index.ts（tsx）：/health 返回 v2.0.0 |
| 静态页面 | GET / 200，JS/CSS 资源 200 |
| 网关鉴权 | 无 Key 时返回 no_credentials 与中文提示；未知帧返回错误 |
| 端到端转发 | 用本地假上游跑通：session_ready → user_speech_started → user_transcript_delta(replace) → user_transcript_final → examiner_transcript_delta，二进制音频 960 字节原样转发，上游收到 input_audio_buffer.append |
| 三家协议映射 | Qwen：text+stash 合并为 replace；Gemini：responseModalities 只含 AUDIO 且转录字段在 setup 顶层；OpenAI：16k→24k 升采样后长度 1.5 倍、speech_started 正确映射 |
| 课表规划 | 全真模考生成 part1→part2→part3，题卡含 You should say: |

## 二、尚未实测（必须知道）

1. **真实厂商 Key 未实测**：本机没有任何百炼 / Gemini / OpenAI 的实时语音 Key，因此
   真实外网 WSS 连通性、真实音色、真实打断延迟都没有跑过。
   已用本地假上游验证协议映射与全链路转发，但不是真实厂商。
2. **真机 iPhone Safari / Android** 未实测：音频解锁、AudioWorklet 重采样、PWA 安装
   需要在真机浏览器上验证。
3. **回声防护**：外放模式下「考官说话时自动闭麦」逻辑已实现，但真实外放回声强度未实测。
4. **副轨精批 / 报告**：需要文本模型 Key 才会真正调用；无 Key 时接口返回 502，前端会显示提示，不影响主通话。

## 三、3 分钟部署

1. 上传仓库到 Render / Zeabur，选 Docker。
2. 环境变量填：
   - ACCESS_CODE=ielts2026（可选，给朋友用口令）
   - DASHSCOPE_API_KEY=sk-...（国内推荐）
   - 或 GEMINI_API_KEY=... / OPENAI_API_KEY=...
3. 部署完打开网址 → 设置里填口令或 Key → 开始连麦。

本地：双击 start-local.bat（Windows）或 ./start-local.sh。

## 四、已知边界

- 浏览器必须允许麦克风；非 HTTPS 的局域网 IP 会被浏览器拒绝（localhost 除外，或用 cloudflared 临时域名）。
- 中断播放依赖服务端 user_speech_started 事件；若某中转站不返回该事件，可用「打断」按钮手动清空。
- 课程只存本地 IndexedDB，换设备不同步（可导出 JSON 手动迁移）。
---

## v2.0.1 修复记录（2026-11-23）

### 修复的真实联调 Bug

1. **开场白丢失**：适配器现在等上游握手成功后才返回句柄，网关把握手中收到的控制帧排队回放，
   前端在 session_ready 之后才发开场指令 —— 慢网络下第一题不再静默。
2. **自带 Key 时精批/报告全失效**：/api/coach/* 现在接收并优先使用浏览器传入的 Key，
   支持独立的精批 Key/地址/模型；没有凭证时返回 401，**不再伪造 6.0 分报告**。
3. **服务端 Key 被盗刷**：服务端配置了 Key 但未设置 ACCESS_CODE 时，默认拒绝无自带 Key 的请求
   （access_code_not_configured），除非显式设置 ALLOW_PUBLIC_HOST_KEY=true。
4. **Gemini 字幕蒸发/顺序颠倒/切模式断连**：只保留 ?key= 参数；用户字幕在考官开口前先落盘；
   考官字幕用累加器在 turnComplete 时发出非空文本；中途不再发送非法 realtimeInputConfig。
5. **React 旧闭包**：模式/阶段/外放开关全部走 ref，通话中切换立即生效；断线能弹出提示。
6. **外放尾音被反录**：PcmPlayer 增加 onIdle（最后一个音频真正播完 +220ms），
   外放模式等尾音播完才解除上行静音。
7. **Part 2 直接开课不出题卡**：首题是 cue card 时，session_ready 后立即显示题卡 + 60 秒准备（保持闭麦）。

### 补齐的交互

- 历史课与长期记忆抽屉（列表、回看字幕/报告、导出/导入 JSON）；开课时自动带最近 5 条记忆进考官提示。
- 盲听模式点单条考官字幕可临时偷看。
- 点任意用户字幕查看那一轮的精批；手机端自动拉起底部抽屉。
- 草稿字幕兜底：服务端 1.2 秒没给 delta 时，用浏览器识别显示浅色实时草稿。
- 设置弹窗分「自带 API Key / 朋友访问口令」两个 Tab，支持自定义模型、Workspace ID、精批专用 Key，以及「测试连接」。

### 自动化测试

- 新增 server/tests/gateway.test.ts 5 项：开场指令竞态、精批 BYOK、未设口令拒绝服务端 Key、
  无凭证不返回假报告、Gemini 字幕顺序。
- 全量：17 项通过（npm test）。

### 仍未实测

- 真实厂商 Key 的外网连通与音色（本地假上游验证过协议）。
- 真机 iPhone Safari / Android 的音频解锁与 PWA 安装。

---

# v2.1.0 交付说明（全生态 MCP 协同，2026-11-23）

## 一、本版范围

1. **全生态 MCP 服务端**：`server/src/mcp-core.ts` 注册 7 个工具
   （`get_learner_context` / `create_lesson` / `list_lessons` / `get_lesson_transcript` /
   `save_turn_feedback` / `save_lesson_report` / `upsert_memory`），双传输：
   - Streamable HTTP：`POST/GET/DELETE /mcp`，与网页同端口（默认 `http://127.0.0.1:3000/mcp`），
     鉴权 `MCP_TOKEN`（回退 `ACCESS_CODE`）`Authorization: Bearer` 或 `?token=`；未配置 Token 时仅放行本机；
   - STDIO：`server/src/mcp-stdio.ts`，stdout 只允许 JSON-RPC，诊断全部 stderr。
2. **共享存储**：`server/src/store.ts` 写 `${IELTS_COACH_DATA_DIR:-~/.ielts-coach}/store.json`
   （临时文件 + rename 原子落盘）；网页端与 MCP 工具共用，`/?lesson=<id>` 直接载入 AI 定制课表。
3. **零手动重启**：本机 STDIO 下载 `create_lesson` 会探测 `/health`，网页服务没起则后台拉起
   （最多 8 秒）再打开浏览器，返回 `{ lessonId, url, serverRunning, browserOpened, plan }`。
4. **一键接入 + Skill**：`scripts/connect-agent.mjs`（纯 Node >=20、零依赖、幂等、`--dry-run`、
   `--url`/`--token`/`--home`）适配 DeepSeek Harness / OpenAI Codex CLI / Claude Code + Desktop /
   Cursor / 豆包桌面端；`skills/ielts-speaking-coach/SKILL.md` 为中文优先双语操作规范；
   根目录 `连接我的AI工具.bat/.sh` 双击即用。
5. **免费外部精批模式**：设置里新增「交给外部 AI 工具（豆包 / dsh / Codex）」，通话中不调用网页精批接口，
   练完由外部 AI 读完整字幕产出逐句红绿 + Band 8 升级 + 四维报告并写回。
6. **多用户隔离**：`MULTI_USER_MODE=true` 时公网普通访客只写各自浏览器 IndexedDB，不污染共享
   `store.json`；课程列表 / 记忆接口需要 Token，单节课可由猜不到的 `?lesson=<id>` 深链访问。
7. **打包**：版本统一 `2.1.0`（root/shared/server/web + package-lock）、Dockerfile 运行时镜像复制
   `skills/`、`scripts/`、`ielts-mcp.bat/.sh`，compose/render 补齐 `MCP_TOKEN` / `MULTI_USER_MODE` /
   `IELTS_COACH_DATA_DIR` 等 env plumbing；`.gitignore` 忽略 `*.bak-*` 与 `store.json`。

> v2.0.1 的 4 个细节修复由并行任务在 `web/src`、`server/src` 完成，本文件只记录跨模块验收结果；
> 细节以 `docs/RELEASE_NOTES_v2.1.0.md` 为准。

## 二、本机已真实验证（2026-11-23，可复现）

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 版本号 | `node -e "JSON.parse(...)"` 读取 root/shared/server/web `package.json` + `package-lock.json` | 5 处 version 全部 `2.1.0`；workspace link 与 mcp/zod 依赖条目完好 |
| 类型检查 | `npm run typecheck` | shared / server / web 依次 `tsc --noEmit` 全部通过，exit 0 |
| 生产构建 | `npm run build` | web：`tsc --noEmit && vite build` 通过（44 模块，`dist/assets/index-*.js` 208.98 KB / gzip 68.02 KB）；server：`tsc --noEmit` 通过；exit 0 |
| 自动化测试 | `npm test`（vitest） | 7 个测试文件 / **56 项全部通过**，含 MCP HTTP 全生命周期、STDIO 真实子进程（stdout 无杂音）、`connect-agent --dry-run` 契约 |
| 一键接入 dry-run 契约 | `node scripts/connect-agent.mjs --dry-run --home <tmp>` | exit 0；stdout 含 `codex` / `cursor` / `豆包` / `dry-run`；tmp home 前后逐文件 hash 不变（未写文件） |
| 一键接入远程模式 | `node scripts/connect-agent.mjs --dry-run --url https://example.com/mcp --token tok` | exit 0，输出 Streamable HTTP 模式，token 不回显 |
| 配置合并正确性 | 假 home 预置 dsh/codex/claude/cursor 配置后实跑，再用 Python `yaml.safe_load` / `tomllib` 重解析 | YAML、TOML、JSON 均解析通过；原配置条目与其它 `mcpServers` 键保留；Windows 路径经 YAML 单引号 / TOML 字面量字符串后原样保留；二次运行无新备份、无文件变化（幂等）；坏 JSON 只跳过不覆盖 |
| 备份 | 实跑统计 | 每个被修改的既有文件生成 `<file>.bak-YYYYMMDD-HHMMSS` |
| `ielts-mcp.bat` STDIO | 从 `C:\Windows`（任意 cwd）用 `cmd /c` 启动，喂 `initialize` / `tools/list` / `create_lesson` | stdout 3 行全部是合法 JSON-RPC；stderr 仅诊断；7 个工具齐全；`create_lesson` 返回 `lessonId/url/serverRunning/browserOpened/plan`；`IELTS_COACH_DATA_DIR` 透传生效（store.json 写到指定目录） |
| `ielts-mcp.bat` 缺失依赖 | 复制到无 `node_modules` 的目录启动 | exit 1，stdout 为空，stderr 明确提示缺依赖并让执行 `npm install` |
| `连接我的AI工具.bat` | `cmd /c` 带 `--dry-run --home <tmp>` 实跑（CRLF + UTF-8 中文） | exit 0，无解析杂音，中文正常输出 |
| `start-local.bat` | 替换启动命令后 `cmd /c` 解析实测（CRLF） | exit 0，无 `not recognized` 杂音，「网页 / MCP / ?lesson」提示行正常输出 |
| 静态配置 | Python PyYAML + JSON.parse | `docker-compose.yml`、`render.yaml` 解析通过且含新 env / 持久卷；`Dockerfile` 静态检查含 skills/scripts/wrappers 的 COPY、数据目录与 `/health` healthcheck |
| 文本编码 | 字节级检查 | `.env.example`、`README.md`、docs、scripts、skill、包装脚本均 UTF-8 **无 BOM**；`.bat` 为 CRLF（Windows 安全），`.sh` 为 LF |

## 三、尚未实测（如实标注）

1. **真实厂商 Key 未实测**：本机没有百炼 / Gemini / OpenAI / DeepSeek 的真实外网 Key，因此真实语音通话、
   真实音色、打断延迟、真实外部精批质量都没有跑过；协议与转发仍以 v2.0.1 的本地假上游验证为准。
2. **真实 AI 客户端 GUI 未实测**：豆包桌面端、DeepSeek Harness、Codex CLI、Claude Code/Desktop、Cursor
   的图形界面安装步骤没有在真机上逐步点过；验证的是脚本产出的配置格式（YAML/TOML/JSON 重新解析）
   + 本机 STDIO 真实 JSON-RPC。各客户端版本差异可能带来界面文案不同。
3. **真机 iPhone Safari / Android 未实测**：麦克风解锁、AudioWorklet、PWA 安装仍需真机验证。
4. **Docker 镜像未在本机构建**：`docker build` 未执行（避免占用大量时间/带宽），Dockerfile 仅做静态检查，
   镜像运行留待部署时验证。
5. **macOS / Linux 的 `ielts-mcp.sh` 未在真机运行**：本机无 bash，只做了代码走查（绝对脚本路径、
   仅 stderr 诊断、缺依赖报错）；建议在目标机执行一次 `bash ielts-mcp.sh` 自查。
6. **`npm run build`**：并行任务结束后执行通过（vite + tsc 均 0 报错）；lead 在最终合并改动
   （MCP schema 容错、`connect-agent.mjs` 空 patch 文件处理、`.gitattributes` / `.dockerignore`）
   之后又复跑了一次，同样 0 报错（见第四节）。
7. 云端实际部署（Render / Zeabur / VPS）未实测，多用户隔离与远程 MCP 的生产环境行为待部署后验证。

## 四、Lead 最终验收（收尾复跑，2026-11-23，可复现）

> 以下数字是 lead 在**最终合并改动之后**重新执行的，不是并行任务中途的结果。

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | exit 0（shared + server + web 全部 `tsc --noEmit` 通过） |
| 生产构建 | `npm run build` | exit 0（vite 44 模块，JS 208.98 KB / gzip 68.02 KB；server `tsc --noEmit`） |
| 自动化测试 | `npm test` | 7 个文件 / **56 项全部通过**（含 STDIO 真实子进程、MCP HTTP、store、auth、sync） |
| 真实进程 E2E（44 项断言全过） | 独立 Node 脚本拉起真实 `server/src/index.ts` 进程（PORT 3981/3982/3983 + 临时 `IELTS_COACH_DATA_DIR`），走真实 HTTP | `/health` 返回 `version 2.1.0`；`GET /` 返回构建后的网页；`POST /mcp` 真实 `initialize` + `tools/list` 返回 7 工具；`create_lesson` → `serverRunning=true`/`browserOpened=false`；浏览器式 `POST /api/lessons/:id/sync` 两次，`startedAt` 不被覆写、字幕落盘；`get_lesson_transcript` 读到 2 行；`save_turn_feedback`（含 LLM 多余字段）写回成功；`save_lesson_report` 置 `completed`；`upsert_memory` / `GET /api/memory` / `DELETE /api/memory/:id` 正常；`get_learner_context` 同时返回 completed 课程 + 记忆 + 本地服务状态 |
| MCP Token 鉴权（真实套接字） | 启动 `MCP_TOKEN=smoke-token` 的进程 | 无 Token / 错 Token → `POST /mcp` 401；`Authorization: Bearer smoke-token` → initialize 成功；`?token=smoke-token` → initialize 成功；`/health` 含 `hasMcpToken` 但不泄露 token |
| 多用户模式 | `MULTI_USER_MODE=true` 进程 | 本机回环仍可读写（设计如此）；非回环矩阵由 `server/tests/sync.test.ts` 3 项覆盖（公网列表/记忆 401，单节课 `?lesson=<id>` 能力链接放行） |
| `ielts-mcp.bat` 真实 STDIO | 从 `C:\Windows` 用 `cmd /c` 拉起，喂 `initialize` / `tools/list` / `create_lesson` | stdout 3 行全部合法 JSON-RPC（无杂音）；7 工具；`create_lesson` 写入 `IELTS_COACH_DATA_DIR` 指定目录 |
| `connect-agent.mjs` 假 home 实跑 | 预置 dsh（内容为 `[]`）/codex/claude/cursor 配置后实跑 + 二次运行 | dsh patch 正确 `- insert:` + `@deepseek-ai/dsh-mcp-client` + `cmd /c` 包装；codex 原 `model` 保留；claude 既有 server 保留；4 个 `.bak-YYYYMMDD-HHMMSS`；两次运行幂等；生成物用 PyYAML / `tomllib` / `JSON.parse` 重新解析通过；SKILL.md 复制到 `~/.dsh/skills` 与 `~/.agents/skills` |
| 文本编码与换行 | 字节级检查 | 所有交付文本 UTF-8 无 BOM；`.bat` CRLF、`.sh` LF（新增 `.gitattributes` 固化，避免 Windows 检出后被改成 LF） |

**本轮由 lead 直接补的收尾项**：`.gitattributes`（`.bat` 必须 CRLF，防止 cmd 解析中文报错）、
`.dockerignore`（避免把宿主机 node_modules / .venv / 日志当作 Docker 构建上下文）、
MCP 写回 schema 对 LLM 多余字段容错（拒绝整包写入会丢失用户精批）、
`connect-agent.mjs` 处理 dsh patch 文件为 `[]` 或空文件的边界。

**仍未验证**：真实厂商 Key / 真实语音通话、真实 AI 客户端 GUI 点击、真机 Safari/Android、
`docker build` 与云平台部署、macOS/Linux 的 `ielts-mcp.sh` 实际执行（如上第三节）。

---

# v2.2.0 交付说明（DeepSeek 纯语音模式，2026-11-23）

## 一、本版范围

1. **DeepSeek 纯语音模式**（新服务商 `deepseek`）：只要 1 个 DeepSeek Key 就能开麦，不再需要
   百炼 / Gemini / OpenAI 的实时语音 Key。
   - **听写**：浏览器原生 `SpeechRecognition`（`continuous` + `interimResults`），通话中可切换
     英文 / 中文识别；Safari / Chrome 自动断段重启时用「已提交前缀 + 本段 final + interim」拼接，
     尽量不断字。
   - **提交**：自由模式约 1.35–1.75 秒停顿自动提交；手动模式 / Part 2 独白不自动截断，
     点「我说完了」才提交。
   - **考官回复**：`POST /api/voice/deepseek-turn` 以 SSE 流式调用 `deepseek-chat`
     （`delta` / `done` / `error` 帧），支持自带 Key、`ACCESS_CODE` 共享与 `endpointUrl`
     自定义中转；客户端断开即中止上游请求。
   - **考官语音**：`POST /api/voice/tts` 用微软 Edge Neural TTS（`@andresaya/edge-tts`）合成 MP3，
     英音 `en-GB-SoniaNeural` / 美音 `en-US-JennyNeural`，中文占比高时自动换 `zh-CN-XiaoxiaoNeural`；
     前端用已解锁的 `AudioContext.decodeAudioData` 播放，规避 Safari / iOS 自动播放拦截。
   - **兜底**：TTS 失败返回 503，前端自动回退 `window.speechSynthesis`；浏览器不支持识别或识别报
     `network` 错误时自动展开底部打字输入框；考官播报期间暂停识别防回声；点「打断」立即停朗读 /
     中止 SSE 并开麦。
2. **设置与 API Key 指南**：服务商首位新增「DeepSeek 纯语音（仅需 DeepSeek Key）」（模型预设
   `deepseek-chat` / `deepseek-reasoner`）与考官口音（英音 Sonia / 美音 Jenny）；设置内新增
   「还没有 API Key？各家获取方式与免费额度」折叠指南；首页新增「获取 API Key」按钮；
   README 新增第二节《如何获取 API Key（含免费额度）》。
3. **修复 v2.1.0 走查发现的 3 个缺陷**（实现细节以 `docs/RELEASE_NOTES_v2.2.0.md` 为准）：
   - 历史课详情补齐逐句精批卡片（红绿修正 / Band 8 升级句 / 错因 / 点评）与四维报告的
     `top_mistakes`、`upgraded_sentences` 渲染；本地与服务端课程合并时，只写回精批、
     还没出报告的课程也能立刻显示；
   - `save_turn_feedback` 的 `items` 由 `z.strictObject` 放宽为 `z.object`，容忍豆包 / Codex / dsh
     多传 `turnIndex` 等字段，不再整包拒收；
   - 浏览器同步在 `MULTI_USER_MODE=true` 部署下按需携带 `Authorization: Bearer <accessCode>`
     （课程同步 / 记忆接口）。
4. **打包与文档**：`@andresaya/edge-tts@^1.9.1` 加入 server 依赖（lock 已含该条目及其依赖）；
   版本统一 `2.2.0` —— root / shared / server / web 四个 `package.json` 的 `version`，以及
   `package-lock.json` 的 `version`、`packages[""].version`、`packages["shared"]`、
   `packages["server"]`、`packages["web"]` 共 5 处；`.env.example` 补充 DeepSeek 说明。
   **没有新增环境变量**：纯语音模式复用 `DEEPSEEK_API_KEY`，朗读走微软 Edge TTS（免费、无 Key）。

## 二、交付文档整理时复核过的事实（不代替 lead 最终验收）

| 项目 | 方法 | 结果 |
| --- | --- | --- |
| 版本号 | `node` + `JSON.parse` 读取 4 个 `package.json` 与 `package-lock.json` | 9 处 version 中 4 个 package.json + lock 的 5 个 workspace 字段均为 `2.2.0`；`@andresaya/edge-tts@1.9.1` 条目与其 `commander` / `ws` 依赖完好；第三方包自带的 `2.1.0`（content-type / type-is）未误改 |
| 文本编码 | 防 BOM 字节检查 | `README.md`、`.env.example`、`docs/V2_DELIVERY.md`、`docs/RELEASE_NOTES_v2.2.0.md`、`package*.json` 均 UTF-8 无 BOM |
| README 官方入口 | 逐个 HTTP 访问 | DeepSeek 开放平台 200；百炼控制台 200；Gemini AI Studio 跳转 `accounts.google.com` 登录（正常）；OpenAI 平台 403 Cloudflare 人机拦截（正常，非 404） |
| Edge Neural TTS | 真实微软服务调用（实现期间记录） | 可合成 MP3（英音 / 美音 / 中文自动音色） |
| DeepSeek SSE 路由 | 本地假 OpenAI SSE 上游（实现期间记录） | 流式 `delta` / `done` 与鉴权拦截跑通；**真实 DeepSeek 端点未实测** |

## 三、已知限制（如实标注，发布前请读完）

1. **真实 DeepSeek Key 未实测**：本机没有可用的真实 DeepSeek Key；`deepseek-chat` 的流式输出、
   计费、内容质量与真实端点连通性都没有跑过，SSE 只对本地假上游验证到「协议与鉴权正确」。
2. **真实浏览器语音识别 / 真麦克风未实测**：本机是无头开发环境，`SpeechRecognition` 的英 / 中文
   识别效果、自动断段重启拼接、回声防护、自动 / 手动提交的停顿阈值都未在真实 Chrome / Safari 上跑过；
   实现依据浏览器行为规范，需真机复核。
3. **Safari 断段拼接为 best-effort**：Safari 会在静音 / 超时后结束识别会话，代码在每次 `onend` 后
   带累积前缀重启；极长句或频繁重启时仍可能偶发断字 / 丢尾字。
4. **延迟**：DeepSeek 纯语音不是端到端实时语音，体感延迟 = 识别停顿提交（约 1.35–1.75 秒）+
   DeepSeek 文本往返 + 首句 TTS 合成播放，预计 1.5–3 秒；不要拿它与百炼 / Gemini / OpenAI 的
   < 1 秒端到端模式对比。
5. **依赖网络**：需能访问 `api.deepseek.com` 与微软 TTS 服务；**Chrome 的语音识别服务在国内网络下
   可能报 `network` 错误**（此时可换 Safari 或使用打字输入兜底）；Firefox 不支持 `SpeechRecognition`。
6. **TTS 稳定性**：Edge TTS 是微软 Edge 朗读服务的轻量封装，偶发 503 / 限流时会自动回退浏览器
   `speechSynthesis`（音色变为系统音）；长时间高频调用未做压力测试。
7. **真机 iPhone Safari / Android 未实测**：沿用 v2.0 / v2.1 的未实测项 —— 麦克风解锁、
   `AudioContext` 解锁播放、PWA 安装仍需真机验证。
8. **沿用 v2.1.0 的未实测项**：真实百炼 / Gemini / OpenAI Key 的外网连通与音色、真实 AI 客户端 GUI、
   `docker build` 与云平台部署、macOS / Linux 的 `.sh` 包装脚本，均未在本版重新验证。
9. **TTS 端点未鉴权**：`POST /api/voice/tts` 按规格是给网页直接调用的免费朗读接口（不消耗用户 Key），
   公网部署时第三方也可直接调用（微软侧会限流）。介意的话请在反向代理 / CDN 层加同源或频率限制。

## 四、验收结果（lead 最终复跑，2026-11-23，可复现）

> 以下数字是 lead 在**合并全部并行改动之后**重新执行的，不是并行任务中途的数字。

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 版本号 | `node` 读取 4 个 `package.json` + `package-lock.json` 的 5 处 workspace version | root / shared / server / web 全部 `2.2.0`；lock 的 5 处 workspace version 同为 `2.2.0`；`@andresaya/edge-tts@1.9.1` 条目完好 |
| 类型检查 | `npm run typecheck` | exit 0（shared + server + web 全部 `tsc --noEmit` 通过） |
| 生产构建 | `npm run build` | exit 0（vite 45 模块，`dist/assets/index-*.js` 233.77 KB / gzip 75.35 KB，CSS 13.38 KB；server `tsc --noEmit` 通过） |
| 自动化测试 | `npm test` | **8 个测试文件 / 85 项全部通过**（v2.1.0 的 56 项全绿 + deepseek 鉴权 9 项 + 纯语音 19 项 + `save_turn_feedback` 回归 1 项）；含真实 STDIO 子进程、MCP HTTP 全链路、SSE 假上游、TTS 文本处理 |
| 真实进程 E2E smoke（21 项断言全过） | 独立 Node 脚本拉起真实 `server/src/index.ts`（端口 3991/3992 + 临时数据目录） | `/health` 与 `/api/status` 均报 `2.2.0`；`GET /` 正常；`POST /api/voice/deepseek-turn` 对本地假 OpenAI SSE 上游：`delta` 顺序拼接、`done` 全文一致、上游收到 `Bearer <BYOK key>`、`model/temperature 0.65/max_tokens 260/stream true`、system prompt 为首条消息、400/401（`no_credentials`）拦截正确；`POST /api/voice/tts` **真实调用微软 Edge TTS**：英音 31,968 B / 美音 46,656 B / 中文 50,976 B，均 `audio/mpeg` 且 MP3 帧头正确；空文本 400；`provider: deepseek` 的每轮精批复用同一 Key 并命中配置的 `/chat/completions` 中转；`ACCESS_CODE` 模式用服务端 `DEEPSEEK_API_KEY` 且错口令 401；MCP 报 `2.2.0`、7 工具、`create_lesson` 正常、`save_turn_feedback` 带 `turnIndex` 等多余字段仍成功写回 |
| Edge TTS 限流回退 | 真实调用（实现期间与复跑中观察） | 微软偶发 429 时路由返回 503 JSON，前端按设计回退 `speechSynthesis`；间隔 1.2 秒复跑 3 种音色均成功 |
| `git diff --check` | 干净工作树检查 | exit 0（已修掉 `styles.css` 末尾多余空行） |
| 文本编码 / 换行 | 字节级检查 | 所有交付文本 UTF-8 无 BOM；新增 `.ts/.md/.json` LF；`.bat` CRLF / `.sh` LF（`.gitattributes` 固化） |

**本轮由 lead 直接补的收尾项**：修掉 `styles.css` EOF 多余空行；`Dockerfile` / `render.yaml`
版本注释统一到 v2.2.0 并注明 `@andresaya/edge-tts` 随 `node_modules` 打包、无需系统级 TTS 依赖；
README 增加依赖许可提示（`@andresaya/edge-tts` 为 GPL-3.0-only，二次分发需评估）。

**仍未验证**：真实 DeepSeek / 百炼 / Gemini / OpenAI Key、真实浏览器 SpeechRecognition 与真麦克风、
真机 Safari / Android 的 TTS 解锁、`docker build` 与云平台部署（同上第三节）。
---

# v2.2.1 修复记录（DeepSeek 纯语音「思考停顿被打断」，2026-11-23）

## 一、真实问题与定位

用户在 v2.2.0 真机试跑时反馈：一个问题还没答完，只是先答一句再稍作思考，就被考官打断并让他扩展。
用本机 `~/.ielts-coach/store.json` 里那一节课的真实时间线定位：

| 时间 | 事件 |
| --- | --- |
| 17:14:25.148 | 考官开场并问第 1 题 |
| 17:14:59.830 | 用户字幕定稿：`you are more or less`（明显是半句话） |
| 17:15:00.458 | 考官开始回复（间隔 **628 ms**），内容为「tell me a bit more…」 |

结论：**不是识别错误、不是网络问题，而是自动提交的停顿阈值太短** —— v2.2.0 的
`1.35–1.75s` 停顿就会提交，而人思考时停 2 秒很常见；提交后考官立即接话，体感就是被打断。

## 二、修复内容

1. `web/src/realtime/deepseekSession.ts`：auto 模式改为「两段式 endpointing」——
   停顿达到阈值后**先进入 grace 缓冲窗口**，窗口内任何新识别词（interim 或 final）都会取消提交并继续累积；
   窗口结束仍无新词才真正提交。缓冲区在静音、暂停、手动提交、打断、标记说话等所有路径都会清理。
2. 三档「接话速度」（`RealtimeSettings.pauseTolerance`，默认 `standard`）：
   - `fast`：停顿 1.5–1.75s + 缓冲 0.7s（≈ 2.2–2.45s）
   - `standard`：停顿 2.5–2.9s + 缓冲 0.95s（≈ 3.45–3.85s，默认）
   - `patient`：停顿 3.5–4.0s + 缓冲 1.2s（≈ 4.7–5.2s）
3. `web/src/components/SettingsSheet.tsx`：DeepSeek 面板新增「接话速度」芯片与说明；
   `web/src/App.tsx` 把选择传入控制器。手动模式 / Part 2 逻辑完全不变。
4. 版本号统一 `2.2.1`（root / shared / server / web + package-lock 5 处 workspace version），
   `APP_VERSION` 与 MCP server version 同步；测试中的版本断言同步更新。

## 三、验收（lead 复跑）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` → exit 0（shared / server / web 全过） |
| 生产构建 | `npm run build` → exit 0（web 45 模块，`index-CP-thinS.js` 235.47 KB / gzip 75.85 KB；server tsc 通过） |
| 自动化测试 | `npm test` → 8 个文件 / 85 项照样全绿（版本断言更新为 2.2.1） |
| 真机复测 | **未做**：3.45–3.85 秒停顿的实际体感需要用户戴耳机再跑一轮确认；真机 Safari / Android 未测 |

**说明**：这是补丁版，服务端业务逻辑未变；主要是前端 endpointing 与设置项。
---

# v2.2.2 改进记录（整段完成度断句 + 5 秒硬上限，2026-11-23）

## 一、背景

v2.2.1 只是把停顿阈值放宽到约 3.5 秒；用户继续反馈：第一句话本身就是完整的，
但停下来想第二句时仍会被提前提交。结论：只看「句末标点 / 句子完整」不够，
要判断**整段回答的完成度**。

## 二、实现

1. `shared/src/ielts.ts` 新增纯函数 `assessUtterance(text)`（浏览器与服务端测试共用）：
   统计词数（英文词 + 中文字符）、句子数；检测结尾是否为
   - 口头填充 / 连接词 / 未完成短语（`well / and / but / because / so / you know / kind of / 嗯 / 然后 / 所以…`）；
   - 介词 / 冠词 / 所有格等开放结尾（`a / the / of / to / my / that…`）；
   - 逗号 / 省略号 / 破折号；
   - 只有一句短句（< 14 词且 ≤1 句）也算「可能没说完」。
   判定 `likelyComplete` = 至少两句且 ≥8 词，或整段 ≥14 词，且收尾干净。
2. `web/src/realtime/deepseekSession.ts`：auto 模式改为「三阶段」——
   - 软停顿（标准档 2.6–3.0s）触发 `assessUtterance`；
   - 完成 → 进入 grace 缓冲（约 1.1s）后提交；
   - 未完成 → 等到硬上限（标准档 5s，从最后一个识别词起算）仍无新词才提交；
   - 期间任何新词都会取消待提交并重置硬上限计时。
3. 「接话速度」三档改为控制硬上限：快速约 3.5s / 标准约 5s（默认）/ 耐心约 6.5s。
4. 新增 `server/tests/endpointing.test.ts` 8 项覆盖：两句话说完整、单句不提交、
   填充词/连接词/介词尾巴、中文尾巴、逗号/省略号、空输入等。

## 三、验收（lead 复跑）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` → exit 0（shared / server / web） |
| 自动化测试 | `npm test` → **9 个文件 / 93 项全绿**（新增 endpointing 8 项） |
| 生产构建 | `npm run build` → exit 0（web 前端重建；server tsc 通过） |
| 真机体感 | **未做**：5 秒硬上限 / 填充词识别的实际体感需要用户戴耳机再跑一轮；真机 Safari / Android 未测 |

**说明**：这是启发式断句（填充词 + 连接词 + 句子数 + 词数），不是语义模型；极端口语仍可能误判，
因此保留手动模式（点「我说完了」）作为完全可控的兜底。
---

# v2.2.3 修复记录（Edge TTS 429 限流导致「突然没声音」，2026-11-23）

## 一、真实问题与定位

用户在 v2.2.2 试跑时反馈「为什么没声音了」。服务端日志抓到：

```
[ielts-v2] Edge TTS 失败: Unexpected server response: 429
```

即微软 Edge 朗读服务对突发请求返回 429（限流）。v2.2.2 及以前：
- 前端按句拆 TTS，**一句一个请求 + 2 个并发预取**，考官回 2–3 句时 1 秒内打出 3 个请求，极易触发 429；
- 路由返回 503，前端回退 `speechSynthesis`，但那次回退没有真正发声；
- 结果就是「有字幕、没声音」。

## 二、修复内容

1. 服务端 `server/src/deepseek-voice.ts`：
   - 全局串行队列：所有 Edge TTS 合成依次执行，杜绝并发突发；
   - 429 / 限流自动重试 3 次（退避 0.7s / 1.4s），仍失败才 503；
   - 128 条 LRU 音频缓存（同一句重复朗读直接命中内存）。
2. 前端 `web/src/realtime/deepseekSession.ts`：
   - 「≤420 字符一块」合成，通常一次朗读只发 1 个请求；预取并发 2 → 1；
   - 回退浏览器朗读时顶部提示一次「已自动切换为浏览器朗读」；
   - 在点击手势里预解锁 `speechSynthesis`，并先 `cancel()/resume()` 清理朗读队列；
   - 手动模式、断句、Part 2 等逻辑不变。
3. 版本统一 `2.2.3`（4 个 package.json + lock 5 处 + APP_VERSION + MCP server version）。

## 三、验收（lead 复跑）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` → exit 0 |
| 自动化测试 | `npm test` → **9 个文件 / 93 项全绿** |
| 生产构建 | `npm run build` → exit 0（web 45 模块，新 bundle `index-DWvq1uKp.js` 239.08 KB / gzip 77.34 KB） |
| 真实 Edge TTS | 单次 `POST /api/voice/tts` → 200 / `audio/mpeg` / 约 0.9s；重启后快速连续 4 次请求经串行 + 重试全部 200（见下） |
| 真机连续上课限流概率 | **未实测**：需长时间真实上课观察；限流时的回退提示与浏览器朗读音色真机未验证 |

**说明**：429 是外部服务的限流，本项目不能保证永远不触发；目标改为「触发时既不静音、也能继续上课」，
排查入口在服务端 stderr 的 `[ielts-v2] Edge TTS 失败` 日志。
---

# v2.2.4 诊断增强记录（声音自检页 + TTS 计数器，2026-11-23）

## 一、背景

v2.2.3 修复了 Edge TTS 429 限流的根因后，用户仍反馈「还是没声音」。本机用无头 Edge（CDP）实测真实页面：
`/api/voice/tts` 200、`decodeAudioData` 成功（3.5s / 48kHz / 单声道 / 峰值 0.41）、
`AudioBufferSourceNode` 正常 ended、无 JS 报错 —— **浏览器端音频链路正常**，需要把排查前移到用户真实环境。

## 二、新增诊断能力

1. `web/public/sound-check.html`：声音自检页 `/sound-check.html`
   - 环境检查（AudioContext / sampleRate / speechSynthesis / voices / bundle / 服务端版本与 TTS 计数）；
   - 真实 Edge 朗读播放（HTTP 状态 / 字节数 / 解码时长 / 峰值 / 播放结果）；
   - 浏览器朗读兜底通道测试；
   - 页面顶部会显示服务端版本，用于确认是否加载到新版。
2. 服务端 `/api/status` 增加 `tts` 计数器与 `[tts] ok ...` 日志，便于确认「浏览器有没有请求音频、成功没有」。
3. 版本统一 `2.2.4`。

## 三、验收（lead 复跑）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` → exit 0 |
| 自动化测试 | `npm test` → 9 个文件 / 93 项全绿 |
| 生产构建 | `npm run build` → exit 0（`web/dist/sound-check.html` 已生成） |
| 自检页 | 真实服务下 `GET /sound-check.html` 200；无头 Edge 实测真实页面音频链路全绿 |
| 真实用户设备 | **待用户点自检页确认**（系统音量 / 输出设备 / 标签页静音无法从服务端判断） |
---

## 封版状态（2026-11-23）

**v2.2.4 已封版**：`main` 最新提交即封版提交，封版标记 tag 为 `freeze-2026-11-23`；
GitHub Release：https://github.com/La0Fe1/ielts-coach-plugin/releases/tag/v2.2.4 。
本文件记录的是封版前 lead 的最终复跑结果；未实测项均已在各版本文档中如实标注。

---

# v2.2.5 安全补丁记录（Key 隔离 + 本地监听，2026-11-23）

## 一、背景

用户询问：「有没有做本地适配，别到时候别人用的是我的 apikey」。核查结论：
Key 本身只存浏览器 localStorage / 服务端 .env（从未提交），但发现两处可被「知道口令的人」利用的缺口：

1. 服务端 Key（ACCESS_CODE 模式）会被发送到客户端指定的 `endpointUrl`（DeepSeek 纯语音轮）或
   `coachBaseUrl`（DeepSeek 精批），可被转发窃取；
2. 服务默认监听 `0.0.0.0`，同一 Wi-Fi 的其他人可以打开页面（用不了浏览器里的 Key，但可白嫖 TTS）。

## 二、修复

1. `server/src/index.ts`：新增并导出 `endpointForCredential(source, endpointUrl)` —— 只有
   `byok` 凭证允许自定义 endpoint，`server` 凭证一律返回 `undefined`；HTTP SSE 语音轮与 WebSocket
   实时语音都改用它，并在忽略自定义地址时打一条 warn。
2. `server/src/auth.ts`：`deepseekCoachConfig` 使用服务端 `DEEPSEEK_API_KEY` 时强制
   `DEEPSEEK_BASE_URL` + `DEEPSEEK_MODEL`，忽略客户端 `coachBaseUrl`/`coachModel`。
3. `HOST` 环境变量：默认 `0.0.0.0`；`start-local.bat`/`start-local.sh` 自动设置
   `HOST=127.0.0.1`；`.env.example` 增加说明。
4. 启动日志打印监听地址、Key 来源、ACCESS_CODE / MULTI_USER_MODE / MCP_TOKEN 状态与数据目录
   （仅布尔/文本状态，绝不打印 Key）。
5. 版本统一 `2.2.5`（4 个 package.json + lock 5 处 + APP_VERSION + MCP server version + 测试断言）。

## 三、验收（lead 复跑）

| 项目 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` → exit 0 |
| 自动化测试 | `npm test` → **10 个测试文件 / 98 项全绿**（新增 security 5 项；deepseek-voice 的 host-key 测试改为断言「自定义中转被忽略、只请求官方地址」） |
| 生产构建 | `npm run build` → exit 0（前端 45 模块，bundle 未变；server tsc 通过） |
| 启动日志 | 本机以 `HOST=127.0.0.1` 启动 → 日志显示 `bind=127.0.0.1 (local only)`、`未设置 ACCESS_CODE`、`MULTI_USER_MODE=false`、`MCP_TOKEN=未设置` |
| Key 扫描 | 全部 tracked 文件无 key-like 字符串；`.env` 从未被 Git 跟踪；`store.json` 无 apiKey 字段 |
| 外部设备验证 | **未实测**：另一台设备/公网访问 127.0.0.1 应失败（依赖 Node 绑定语义 + 启动日志确认） |

**封版状态**：v2.2.5 为新的封版版本，`freeze-2026-11-23` 标记更新到 v2.2.5 提交；
v2.2.4 的 Release 顶部已标注「已被 v2.2.5 安全补丁取代」。
