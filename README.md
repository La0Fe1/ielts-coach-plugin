# IELTS 口语教练 · 实时语音 + 全生态 MCP（v2.1.0）

打开网页就能练雅思口语：**像打电话一样和考官对话**，实时听、实时接话，随时可以打断；
语法纠错和升级表达在后台安静生成，不打断你开口。

v2.1.0 把「网页实时语音」和「外部 AI 工具（豆包桌面端 / DeepSeek Harness / OpenAI Codex CLI /
Claude Code / Cursor）」用 **MCP + Skill** 串成闭环：

- **课前**：AI 工具读你的历史弱点 → 定制题单 → 拉起实时语音网页（`/?lesson=<id>`）
- **课后**：AI 工具读完整实时字幕 → 逐句红绿精批 + Band 8 升级 + 四维报告 → 写回课程与长期记忆
- 外部 AI 工具做精批**不花语音服务商的钱**（免费外部精批模式）

其他：手机 / iPad / 电脑浏览器都能用，可「添加到主屏幕」当 App；零 Python、零原生依赖。

---

## 一、5 分钟快速开始（本地）

前置：安装 [Node.js LTS](https://nodejs.org/zh-cn)（**20 以上**），然后在仓库根目录：

```bash
npm install                      # 装依赖
cp .env.example .env             # Windows 用: copy .env.example .env
npm run dev                      # 前端 5173 + 网关 3000
```

或者更省事：

- **Windows**：双击 `start-local.bat`（自动装依赖 / 构建 / 打开浏览器）
- **macOS / Linux**：`./start-local.sh`

浏览器打开 <http://localhost:3000> → 点设置 → 填自己的 API Key（只存在你浏览器）或朋友分享的
访问口令 → 开始对话。健康检查：`curl http://localhost:3000/health` 应返回 `version: "2.1.0"`。

想用手机试：在电脑上执行 `npx cloudflared tunnel --url http://localhost:3000`，手机打开生成的
https 链接即可（临时链接，关掉就失效；非 HTTPS 的局域网 IP 会被浏览器拒绝使用麦克风）。

## 二、MCP 全生态接入

### 0. 先理解两种传输方式

| 场景 | 传输 | 客户端填什么 |
| --- | --- | --- |
| 本机自用（先跑通这个） | **STDIO** | 指向本仓库的 `ielts-mcp.bat` / `ielts-mcp.sh`，由 AI 工具拉起 |
| 已部署到云端 / 多设备 | **Streamable HTTP** | `https://你的域名/mcp` + `Authorization: Bearer <token>` |

- MCP HTTP 端点和网页挂在**同一个服务端口**上：默认 `http://127.0.0.1:3000/mcp`。
- 鉴权：配置了 `MCP_TOKEN`（未配置时回退读 `ACCESS_CODE`）后，`/mcp` 必须带
  `Authorization: Bearer <token>`，也兼容 `?token=<token>`；**没有配置 Token 时只放行本机
  127.0.0.1 / localhost**，公网访问直接 401。
- 7 个工具：`get_learner_context`、`create_lesson`、`list_lessons`、`get_lesson_transcript`、
  `save_turn_feedback`、`save_lesson_report`、`upsert_memory`。
- `create_lesson` 返回 `{ lessonId, url, serverRunning, browserOpened, plan }`，其中 `url` 就是
  浏览器深链 `http://127.0.0.1:3000/?lesson=<id>`。

### 1. 一键接入（推荐）

| 系统 | 操作 |
| --- | --- |
| Windows | 双击 **`连接我的AI工具.bat`** |
| macOS / Linux | 终端执行 **`./连接我的AI工具.sh`** |

预览模式（不改任何文件）：`node scripts/connect-agent.mjs --dry-run`
接远程部署：`node scripts/connect-agent.mjs --url https://你的域名/mcp --token 你的token`

脚本会自动：

1. **DeepSeek Harness**：往 `~/.dsh/profiles/*/cordis.patch.yml` 幂等插入 `mcp-ielts-coach`
   （已存在则跳过），stdio 模式写 `cmd` + `/c` + `ielts-mcp.bat`（Windows 上 MCP 客户端不能
   直接执行 .bat），远程模式写 `transport: streamable-http`；
2. **OpenAI Codex CLI**：存在 `~/.codex/` 时，向 `~/.codex/config.toml` 追加合法的
   `[mcp_servers.ielts-coach]` 段（远程模式写 `url` + `bearer_token_env_var`）；
3. **Claude Code / Claude Desktop / Cursor**：安全合并 `~/.claude.json`、
   `claude_desktop_config.json`、`~/.cursor/mcp.json` 里的 `mcpServers["ielts-coach"]`，其它键原样保留；
4. 复制 Skill 到 `~/.dsh/skills`、`~/.codex/skills`、`~/.claude/skills`、`~/.cursor/skills`、
   `~/.agents/skills`；
5. 修改任何已存在文件前，先备份 `<文件>.bak-YYYYMMDD-HHMMSS`；最后打印**豆包桌面端 2 步手填卡片**。

脚本完全幂等，可反复运行；`--dry-run` 只列计划、不写文件。

### 2. 各客户端手动配置（复制即用）

**豆包桌面端**（没有可自动写入的配置文件，2 步手动）：

1. 插件 → 添加自定义连接器（MCP）
   - 推荐 **Streamable HTTP**：地址填 `http://127.0.0.1:3000/mcp`（部署后换成
     `https://你的域名/mcp`）；若服务端设了 `MCP_TOKEN`，请求头填 `Authorization: Bearer <token>`
   - 备选 **STDIO**：Windows 填 `cmd /c "E:\雅思口语插件开发\ielts-mcp.bat"`；
     macOS/Linux 填 `/绝对路径/ielts-mcp.sh`；环境变量 `IELTS_COACH_DATA_DIR` 可留空
2. 技能 → 上传技能 → 选择文件夹 `skills/ielts-speaking-coach`

**DeepSeek Harness**：编辑 `~/.dsh/profiles/<你的profile>/cordis.patch.yml`，在文件末尾追加：

```yaml
- insert:
    - id: mcp-ielts-coach
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ielts-coach
        transport: stdio
        command: 'cmd'                       # macOS/Linux: command 直接填 ielts-mcp.sh 绝对路径
        args:
          - '/c'
          - 'E:\雅思口语插件开发\ielts-mcp.bat'
        env:
          IELTS_COACH_DATA_DIR: 'C:\Users\<你>\.ielts-coach'
        cwd: 'E:\雅思口语插件开发'
        failOnStartupError: true
```

远程部署时把 `transport` 换成 `streamable-http`，用 `url: 'https://你的域名/mcp'` 代替
`command/args/env/cwd`，需要时再加：

```yaml
        headers:
          Authorization: 'Bearer <你的 token>'
```

**OpenAI Codex CLI**：编辑 `~/.codex/config.toml`，追加：

```toml
[mcp_servers.ielts-coach]
command = 'cmd'
args = ['/c', 'E:\雅思口语插件开发\ielts-mcp.bat']
env = { IELTS_COACH_DATA_DIR = 'C:\Users\<你>\.ielts-coach' }
```

远程：`url = 'https://你的域名/mcp'` + `bearer_token_env_var = 'MCP_TOKEN'`（并先设置该环境变量）。

**Claude Code / Claude Desktop**：编辑 `~/.claude.json`（Desktop 是 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "ielts-coach": {
      "command": "cmd",
      "args": ["/c", "E:\\雅思口语插件开发\\ielts-mcp.bat"],
      "env": { "IELTS_COACH_DATA_DIR": "C:\\Users\\<你>\\.ielts-coach" }
    }
  }
}
```

远程模式：

```json
{
  "mcpServers": {
    "ielts-coach": {
      "type": "http",
      "url": "https://你的域名/mcp",
      "headers": { "Authorization": "Bearer 你的token" }
    }
  }
}
```

**Cursor**：编辑 `~/.cursor/mcp.json`，格式与上面 Claude 的 JSON 完全相同。

> macOS / Linux 下用 STDIO 时，记得给包装脚本可执行权限：`chmod +x ielts-mcp.sh`。
> 普通 STDIO 配置里的命令就是该脚本绝对路径；若客户端只吃解释器命令，可用
> `bash /绝对路径/ielts-mcp.sh`。

### 3. 验证接入成功

在 AI 工具里说：

- 「开始练雅思口语 Part 1，目标 7 分」→ 应调用 `get_learner_context` + `create_lesson`，
  然后给你网页链接（本机会自动弹出浏览器）
- 「复盘刚才那节雅思课，出四维报告」→ 应调用 `get_lesson_transcript` → 精批 → 写回

## 三、AI 定制课：`/?lesson=<id>` 每一步发生了什么

1. AI 工具调 `get_learner_context`：拿到最近 5 节课摘要 + 全部长期记忆 + 本机网页服务状态；
2. 调 `create_lesson`：按弱点生成题单，写入共享课程存储（`status: planned`），返回
   `{ lessonId, url, serverRunning, browserOpened, plan }`；
3. **零手动重启**：本机 STDIO 模式下，如果网页服务没在跑，工具会先探 `http://127.0.0.1:<PORT>/health`，
   没起就后台拉起网页服务（最多等 8 秒），然后打开默认浏览器；`serverRunning / browserOpened`
   告诉客户端真实结果；
4. 你打开 `http://127.0.0.1:3000/?lesson=<id>`：页面直接加载 AI 的 `plan`、`partMode`、
   `reviewFocus` 和历史记忆，**不再随机抽题**，点「开始对话」即按定制课表上课；
5. 练习中双方字幕实时写入浏览器，并异步 `POST /api/lessons/<id>/sync` 到共享存储；
6. 练完回到 AI 工具说「复盘」，工具读取完整字幕 → 精批 → `save_turn_feedback` /
   `save_lesson_report` / `upsert_memory` 写回；
7. 网页历史里立刻能看到逐句精批和四维报告；下节课 `get_learner_context` 会自动带上这些弱点。

## 四、免费外部精批模式（v2.1.0 新）

网页默认每轮精批会调用文本模型（要花 Key 的钱）。设置 → **精批方式** 里新增
「**交给外部 AI 工具（豆包 / dsh / Codex）免费精批**」：

- 通话全程**不再调用**网页精批接口，字幕照常落盘；
- 结束后页面给出一键复制的复盘指令；
- 把指令粘到豆包 / dsh / Codex（已接入 MCP + Skill），它读完整字幕产出：
  **逐句红绿对比修改 + Band 8 升级表达 + 四维报告**，再通过 MCP 写回课程；
- 全程只花你外部 AI 工具自己的额度，语音服务商的钱一分不多花。

| 精批方式 | 何时出结果 | 花费 | 适合 |
| --- | --- | --- | --- |
| 网页自动（同主服务商） | 说完一句马上出 | 按主服务商文本价 | 想要实时反馈 |
| 独立 DeepSeek / 自定义模型 | 说完一句马上出 | DeepSeek 很便宜 | 想省钱又要实时 |
| 交给外部 AI 工具 | 练完统一精批 | 用你外部工具额度 | 最省钱、要深度复盘 |

## 五、部署到云端（给朋友用）

**Docker（最通用）**

```bash
cp .env.example .env    # 填好 Key / ACCESS_CODE / MCP_TOKEN，见下
docker compose up -d --build
```

**Render**：上传仓库 → New Web Service → Runtime 选 Docker → 按 `render.yaml` 填环境变量。
**Zeabur**：直接部署仓库，构建/启动配置见 `zeabur.json`。
**任意服务器**：`docker build -t ielts-coach . && docker run -p 3000:3000 --env-file .env ielts-coach`

关键环境变量（完整见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `DASHSCOPE_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | 实时语音 / 精批服务商 Key，至少配一个 |
| `ACCESS_CODE` | 朋友输口令即可用你的额度（不设则不对外开放服务端 Key） |
| `ALLOW_PUBLIC_HOST_KEY` | 只有确实要把服务端 Key 公开给任何人时才设 `true` |
| `MCP_TOKEN` | 保护 `/mcp` 与同步接口；云端**务必设置**，AI 工具用 `Authorization: Bearer <token>` |
| `MULTI_USER_MODE` | `true` = 公网多用户隔离（见下）；单机自用保持 `false` |
| `IELTS_COACH_DATA_DIR` | 共享数据目录，默认 `~/.ielts-coach`。**云端请指向持久卷**（如 `/data`），否则重启丢课程 |
| `PUBLIC_BASE_URL` | `create_lesson` 返回的网页地址前缀，云端填 `https://你的域名` |
| `PORT` | 服务端口，默认 `3000` |

- **多用户隔离（`MULTI_USER_MODE=true`）**：公网普通访客的课程只留在自己浏览器 IndexedDB，
  不会写进服务端共享 `store.json`；课程列表 / 长期记忆接口需要 `MCP_TOKEN`；单节课仍可通过
  猜不到的 `?lesson=<id>` 深链访问（链接本身就是访问凭证）。
- **云端接入 MCP**：部署后所有 AI 工具都可以用远程 Streamable HTTP
  `https://你的域名/mcp` + `Authorization: Bearer $MCP_TOKEN`，客户端机器不需要装 Node.js。
  这也是推荐给朋友用的方式。
- **安全清单**：设 `MCP_TOKEN`、`ACCESS_CODE` 别用弱口令、数据目录挂持久卷、按需设
  `MULTI_USER_MODE=true`。

## 六、支持哪些语音服务商

| 服务商 | 适用 | 说明 |
| --- | --- | --- |
| 阿里云百炼 Qwen-Omni-Realtime | 国内 | 延迟低、中文支持好，推荐国内用户 |
| Google Gemini Live | 海外 | 音色自然，需要能访问 Google |
| OpenAI Realtime | 海外 / 中转 | 支持自定义 endpoint，兼容 OneAPI/NewAPI |

设置里可以填**自定义 endpoint**，用中转站或 Cloudflare Worker 反代都行。

## 七、怎么用（练的时候）

- **自由对话**：随时开口就能打断考官；外放时考官说话会先闭麦，等尾音播完再解麦，点「打断」即可插话。
- **手动控场**：说完点「我说完了」再提交，适合嘈杂环境。
- **Part 2**：自动切手动模式，60 秒准备（不开麦）+ 2 分钟独白，绝不打断你。
- **字幕**：双方逐字滚动；可以开「盲听」练听力。
- **精批**：每说完一句，右侧（手机上是底部抽屉）出现 ✨ 精批：修正、Band 8 升级句、错因；
  选「免费外部精批」时改为练完统一精批。
- **报告**：结束后生成四维评分 + Top 错题 + 可背诵的升级句，存进浏览器本地与共享存储，可导出 JSON。

## 八、隐私

- 自带 Key 只存在你浏览器的 localStorage，服务端**不落盘、不打日志**。
- 站长模式下 Key 只在服务器内存里用于建立连接，前端拿不到；未设访问口令时默认不对外开放。
- 单机模式（默认）：课程写在本机 `~/.ielts-coach/store.json`（或 `IELTS_COACH_DATA_DIR`），
  网页与 MCP 工具共享。
- 多用户模式（`MULTI_USER_MODE=true`）：公网普通访客数据只存各自浏览器 IndexedDB，不污染服务端
  `store.json`；只有携带 `MCP_TOKEN` 或本机客户端能读写共享存储。
- 语音与文本精批请求直接发往你配置的服务商，不经过任何第三方中转。

## 九、常见问题（Troubleshooting）

| 现象 | 处理 |
| --- | --- |
| 页面 404 / 白屏「web build missing」 | 先 `npm run build`；`start-local.bat` 会自动构建 |
| 麦克风打不开 / 没有声音 | 浏览器只允许 HTTPS 或 localhost 使用麦克风；手机测试用 cloudflared 临时域名 |
| 端口被占用 | `.env` 里改 `PORT=3001`，网页与 MCP 会一起换端口 |
| 豆包连接失败 / 401 | 确认地址是 `…/mcp` 且服务在运行；设了 `MCP_TOKEN` 就要在请求头填 `Authorization: Bearer <token>` |
| DeepSeek Harness 里插件启动失败 | 确认 `ielts-mcp.bat` 绝对路径正确、本机 `node_modules` 已安装；Windows 必须经 `cmd /c` 调用（一键脚本已处理好）；可用 `node scripts/connect-agent.mjs --dry-run` 预览配置 |
| Codex / Claude / Cursor 没识别到 ielts-coach | 检查配置段是否被写进正确文件、JSON/TOML 是否合法，然后重启对应客户端 |
| `create_lesson` 没自动弹浏览器 | 云端/远程部署不会开浏览器，直接用返回的 `url`；本机被 `openBrowser:false` 关掉了也会不弹 |
| 多用户模式下网页看不到 AI 新建的课 | 确认 `MULTI_USER_MODE` 是否符合预期；公网访客需通过 `?lesson=<id>` 链接进入，跨用户列表需要 `MCP_TOKEN` |
| 课程/记忆重启后消失 | 云端没给 `IELTS_COACH_DATA_DIR` 挂持久卷 |
| `npm install` 很慢 | `npm config set registry https://registry.npmmirror.com` |
| Node 版本报错 | 必须 Node 20+：`node -v` |

## 十、开发

```bash
npm install
npm run dev        # 前端 5173 + 网关 3000
npm run typecheck
npm test           # server 的协议 / 网关 / MCP 测试
npm run build && npm start
```

目录：`shared/`（协议与雅思 Prompt）、`server/`（网关、三家实时语音适配器、MCP 与共享存储）、
`web/`（React PWA）、`skills/`（全生态 Skill）、`scripts/`（一键接入脚本）。

单独调试 MCP：

```bash
node scripts/connect-agent.mjs --dry-run     # 预览各客户端配置
node node_modules/tsx/dist/cli.mjs server/src/mcp-stdio.ts   # 手工跑 STDIO（stdout 只允许 JSON-RPC）
```

交付与验证记录见 `docs/V2_DELIVERY.md`，本版变更见 `docs/RELEASE_NOTES_v2.1.0.md`。

## 十一、旧版本

v1（本地 Python / Whisper / 桌面窗口）保留在分支 `archive/v1-local-python`，不再维护。
