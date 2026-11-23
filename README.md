# IELTS 口语教练 · 实时语音 + 全生态 MCP（v2.2.0）

打开网页就能练雅思口语：**像打电话一样和考官对话**，实时听、实时接话，随时可以打断；
语法纠错和升级表达在后台安静生成，不打断你开口。

**v2.2.0 新增「DeepSeek 纯语音」模式：只有一个 DeepSeek Key 也能开麦。** 浏览器原生语音识别
负责听你说话并实时上字幕 → 服务端用 `deepseek-chat` 流式生成考官回复 → 微软 Edge Neural TTS
免费朗读（英音 Sonia / 美音 Jenny，中文自动换音色）。没有百炼 / Gemini / OpenAI 的实时语音 Key
也能直接开练；各家 Key 怎么拿、免费额度多少，见第二节。

v2.1.0 的「网页实时语音 + 外部 AI 工具」闭环继续可用（豆包桌面端 / DeepSeek Harness /
OpenAI Codex CLI / Claude Code / Cursor，通过 **MCP + Skill**）：

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

浏览器打开 <http://localhost:3000> → 点「获取 API Key」或设置 → 填自己的 API Key（只存在你浏览器）
或朋友分享的访问口令 → 开始对话。

**只有 DeepSeek Key？** 设置 → 服务商选「**DeepSeek 纯语音（仅需 DeepSeek Key）**」→ 粘贴 Key →
选考官口音（**英音考官 Sonia** / **美音考官 Jenny**）→ 开始对话即可开麦，不需要任何实时语音 Key。
通话中想用中文提问，点顶部 `🎤 识别：英文 / 中文` 切换；识别不可用（国内 Chrome 常见）就用底部
自动展开的打字输入框继续，流程不会卡死。

健康检查：`curl http://localhost:3000/health` 应返回 `version: "2.2.0"`。

想用手机试：在电脑上执行 `npx cloudflared tunnel --url http://localhost:3000`，手机打开生成的
https 链接即可（临时链接，关掉就失效；非 HTTPS 的局域网 IP 会被浏览器拒绝使用麦克风）。

## 二、如何获取 API Key（含免费额度）

先选模式，再按入口拿 Key。所有 Key 都只存在你浏览器的 localStorage（服务端不落盘）；不想自己
申请，也可以找部署好的站长要一个「访问口令」。设置里也有同一份折叠指南（「还没有 API Key？
各家获取方式与免费额度」），首页的「获取 API Key」按钮可直接打开。

| 模式 | 需要什么 Key | 考官声音怎么来 | 延迟（体感） | 费用 | 网络要求 | 适合谁 |
| --- | --- | --- | --- | --- | --- | --- |
| **DeepSeek 纯语音**（v2.2.0 新） | 1 个 DeepSeek Key | 微软 Edge Neural TTS 免费合成（英音 Sonia / 美音 Jenny，中文自动换 Xiaoxiao） | 约 1.5–3 秒：识别停顿提交 + 文本往返 + 首句朗读 | 只花 DeepSeek 文本 token，朗读免费 | 能访问 `api.deepseek.com` 与微软 TTS；浏览器语音识别本身也需要联网 | 手里只有 DeepSeek Key、想一个 Key 全搞定 |
| **阿里云百炼 Qwen-Omni** | `DASHSCOPE_API_KEY` | 端到端实时语音，直接出声 | **< 1 秒** | 按百炼文本 / 音频计费，通常有免费额度 | 国内直连 | 要最快、人在国内 |
| **Google Gemini Live** | `GEMINI_API_KEY` | 端到端实时语音 | 约 1 秒级 | 有免绑卡免费档 | 需能访问 Google | 海外 / 不想绑卡 |
| **OpenAI Realtime / 兼容中转** | `OPENAI_API_KEY` 或中转站 Key | 端到端实时语音 | 约 1 秒级 | 按 OpenAI / 中转站价目 | 能访问对应 endpoint | 已有 OpenAI 账号或中转站 |

> 表中「免费额度」是各厂商常见政策，会随时调整，最终以官方控制台显示为准；本项目不代收任何费用。

### 官方入口与获取步骤

**DeepSeek（单 Key 通吃，最省心）** — 入口：<https://platform.deepseek.com/api_keys>

1. 注册 / 登录 DeepSeek 开放平台；
2. 左侧「API Keys」→「创建 API Key」，复制 `sk-` 开头的字符串（只显示一次）；
3. 网页设置 → 服务商选「DeepSeek 纯语音」→ 粘贴 Key →「测试连接」→ 保存。
   语音识别用浏览器自带能力、朗读由微软 Edge 免费合成，所以**有且只有这一个 Key 就够了**，
   精批与四维报告也复用它。

**阿里云百炼 Qwen-Omni（国内直连 · 端到端 < 1 秒）** — 入口：<https://bailian.console.aliyun.com/>

1. 支付宝 / 淘宝扫码登录并完成实名认证（新用户通常有 100 万 Token 免费额度，可开「免费额度用完即停」，以控制台为准）；
2. 控制台右上角「API-KEY」→ 创建并复制；
3. 网页设置 → 服务商选「阿里云百炼 Qwen-Omni」→ 粘贴 Key。华北2（北京）地域延迟最低。

**Google Gemini Live（海外 · 免绑卡免费档）** — 入口：<https://aistudio.google.com/apikey>

1. 登录 Google 账号，打开 AI Studio；
2. 点「Create API key」生成（免费档无需绑卡，额度以官方为准）；
3. 网页设置 → 服务商选「Google Gemini Live」→ 粘贴 Key。需要能访问 Google。

**OpenAI / 兼容中转站** — 入口：<https://platform.openai.com/api-keys>

1. 登录 OpenAI 平台创建 API Key；用中转站则按中转站文档拿 Key；
2. 网页设置 → 服务商选「OpenAI Realtime」→ 填 Key；中转站在高级选项填**自定义 endpoint**
   （如 `https://你的中转站/v1`），兼容 OneAPI / NewAPI。

### 30 秒决定选哪种

- **手里只有 DeepSeek Key / 不想再多申请** → **DeepSeek 纯语音**：1 个 Key 搞定开麦 + 实时字幕 +
  免费考官朗读，延迟约 1.5–3 秒，练口语够用；
- **要最快、人在国内** → **百炼 Qwen-Omni**：端到端实时，< 1 秒；
- **海外 / 不想绑卡** → **Gemini Live**；
- **已有 OpenAI 或中转站额度** → **OpenAI Realtime / 兼容中转**；
- **想让外部 AI 工具做免费深度精批** → 上面任一模式都行，再按第三节接 MCP（v2.1.0 能力，与模式无关）。

## 三、MCP 全生态接入

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

## 四、AI 定制课：`/?lesson=<id>` 每一步发生了什么

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

## 五、免费外部精批模式（v2.1.0 新）

网页默认每轮精批会调用文本模型（要花 Key 的钱）。设置 → **精批方式** 里新增
「**交给外部 AI 工具（豆包 / dsh / Codex）免费精批**」：

- 通话全程**不再调用**网页精批接口，字幕照常落盘；
- 结束后页面给出一键复制的复盘指令；
- 把指令粘到豆包 / dsh / Codex（已接入 MCP + Skill），它读完整字幕产出：
  **逐句红绿对比修改 + Band 8 升级表达 + 四维报告**，再通过 MCP 写回课程；
- 全程只花你外部 AI 工具自己的额度，语音服务商的钱一分不多花。

> DeepSeek 纯语音模式下，网页精批 / 四维报告**直接复用同一个 DeepSeek Key**，不需要另配精批 Key。

| 精批方式 | 何时出结果 | 花费 | 适合 |
| --- | --- | --- | --- |
| 网页自动（同主服务商） | 说完一句马上出 | 按主服务商文本价 | 想要实时反馈 |
| 独立 DeepSeek / 自定义模型 | 说完一句马上出 | DeepSeek 很便宜 | 想省钱又要实时 |
| 交给外部 AI 工具 | 练完统一精批 | 用你外部工具额度 | 最省钱、要深度复盘 |

## 六、部署到云端（给朋友用）

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
| `DASHSCOPE_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` | 实时语音 / DeepSeek 纯语音 / 精批服务商 Key，至少配一个（纯语音模式只认 `DEEPSEEK_API_KEY`） |
| `ACCESS_CODE` | 朋友输口令即可用你的额度（不设则不对外开放服务端 Key） |
| `ALLOW_PUBLIC_HOST_KEY` | 只有确实要把服务端 Key 公开给任何人时才设 `true` |
| `MCP_TOKEN` | 保护 `/mcp` 与同步接口；云端**务必设置**，AI 工具用 `Authorization: Bearer <token>` |
| `MULTI_USER_MODE` | `true` = 公网多用户隔离（见下）；单机自用保持 `false` |
| `IELTS_COACH_DATA_DIR` | 共享数据目录，默认 `~/.ielts-coach`。**云端请指向持久卷**（如 `/data`），否则重启丢课程 |
| `PUBLIC_BASE_URL` | `create_lesson` 返回的网页地址前缀，云端填 `https://你的域名` |
| `PORT` | 服务端口，默认 `3000` |

DeepSeek 纯语音模式**不需要新增环境变量**：文本调用复用 `DEEPSEEK_API_KEY`，朗读走微软 Edge
Neural TTS（免费、无需 Key），浏览器语音识别在客户端完成。要用中转站，在网页设置的高级选项里
填自定义 endpoint 即可，不用改服务端配置。

- **多用户隔离（`MULTI_USER_MODE=true`）**：公网普通访客的课程只留在自己浏览器 IndexedDB，
  不会写进服务端共享 `store.json`；课程列表 / 长期记忆接口需要 `MCP_TOKEN`；单节课仍可通过
  猜不到的 `?lesson=<id>` 深链访问（链接本身就是访问凭证）。
- **云端接入 MCP**：部署后所有 AI 工具都可以用远程 Streamable HTTP
  `https://你的域名/mcp` + `Authorization: Bearer $MCP_TOKEN`，客户端机器不需要装 Node.js。
  这也是推荐给朋友用的方式。
- **安全清单**：设 `MCP_TOKEN`、`ACCESS_CODE` 别用弱口令、数据目录挂持久卷、按需设
  `MULTI_USER_MODE=true`。
- **TTS 端点注意**：`POST /api/voice/tts` 是给网页调用的免费朗读接口（无需 Key、不依赖用户凭证）。
  公网长期开放时，别人也可能直接拿它当免费 TTS 代理（微软侧会限流），介意的话可在反向代理 / CDN
  层对该路径做同源或频率限制，或只在需要 DeepSeek 纯语音时开放。

## 七、支持哪些语音服务商

| 服务商 | 适用 | 说明 |
| --- | --- | --- |
| **DeepSeek 纯语音**（v2.2.0 新） | 已有 DeepSeek Key | 浏览器识别 + DeepSeek 流式文本 + 微软 Edge 免费朗读；延迟约 1.5–3 秒，只花文本 token |
| 阿里云百炼 Qwen-Omni-Realtime | 国内 | 端到端实时、延迟 < 1 秒、中文支持好，推荐国内用户 |
| Google Gemini Live | 海外 | 音色自然，需要能访问 Google |
| OpenAI Realtime | 海外 / 中转 | 支持自定义 endpoint，兼容 OneAPI/NewAPI |

设置里可以填**自定义 endpoint**，用中转站或 Cloudflare Worker 反代都行。

DeepSeek 纯语音的边界（选之前先看清）：

- 语音识别用浏览器自带的 `SpeechRecognition`：Chrome / Edge / Safari 支持，**Firefox 不支持**；
  Chrome 的识别服务在国内网络下可能报 `network` 错误（Mac / iPhone 用 Safari 更稳，或直接打字）；
- 考官语音由微软 Edge Neural TTS 合成（免费、无需 Key），偶尔不可用时自动回退浏览器
  `speechSynthesis` 朗读，音色会变成系统音；
- 识别停顿约 1.35–1.75 秒自动提交（手动模式 / Part 2 不自动截断，点「我说完了」才提交），
  所以体感延迟会高于端到端实时语音。

## 八、怎么用（练的时候）

- **自由对话**：随时开口就能打断考官；外放时考官说话会先闭麦，等尾音播完再解麦，点「打断」即可插话。
- **手动控场**：说完点「我说完了」再提交，适合嘈杂环境。
- **Part 2**：自动切手动模式，60 秒准备（不开麦）+ 2 分钟独白，绝不打断你。
- **字幕**：双方逐字滚动；可以开「盲听」练听力。
- **纯语音模式（DeepSeek）**：顶部可切 `🎤 识别：英文 / 中文`；浏览器不支持识别或识别报错时，
  底部自动出现打字输入框兜底；考官朗读失败会自动回退系统朗读；点「打断」立即停朗读并开麦。
- **精批**：每说完一句，右侧（手机上是底部抽屉）出现 ✨ 精批：修正、Band 8 升级句、错因；
  选「免费外部精批」时改为练完统一精批。
- **报告**：结束后生成四维评分 + Top 错题 + 可背诵的升级句，存进浏览器本地与共享存储，可导出 JSON。

## 九、隐私

- 自带 Key 只存在你浏览器的 localStorage，服务端**不落盘、不打日志**。
- 站长模式下 Key 只在服务器内存里用于建立连接，前端拿不到；未设访问口令时默认不对外开放。
- 单机模式（默认）：课程写在本机 `~/.ielts-coach/store.json`（或 `IELTS_COACH_DATA_DIR`），
  网页与 MCP 工具共享。
- 多用户模式（`MULTI_USER_MODE=true`）：公网普通访客数据只存各自浏览器 IndexedDB，不污染服务端
  `store.json`；只有携带 `MCP_TOKEN` 或本机客户端能读写共享存储。
- 语音与文本精批请求直接发往你配置的服务商，不经过任何第三方中转。
- **DeepSeek 纯语音模式**：音频不经过本项目服务器 —— 识别由浏览器 `SpeechRecognition` 完成
  （Chrome 会把音频发往 Google 的语音服务、Safari 发往 Apple 的语音服务），服务端只收到最终
  识别文本用于调用 DeepSeek；考官朗读音频由微软 Edge TTS 合成后直接返回浏览器。

## 十、常见问题（Troubleshooting）

| 现象 | 处理 |
| --- | --- |
| 页面 404 / 白屏「web build missing」 | 先 `npm run build`；`start-local.bat` 会自动构建 |
| 麦克风打不开 / 没有声音 | 浏览器只允许 HTTPS 或 localhost 使用麦克风；手机测试用 cloudflared 临时域名 |
| 纯语音模式识别报 `network` / 一直不出字幕 | 国内 Chrome 的语音识别服务可能连不上：Mac / iPhone 换 **Safari**，或直接用底部**打字输入框**继续练；确认是 HTTPS / localhost 且已授权麦克风 |
| 纯语音模式提示「浏览器不支持语音识别」 | Firefox 不支持 `SpeechRecognition`；换 Chrome / Edge / Safari，或打字练习 |
| 纯语音模式没有考官声音 / 服务端 TTS 503 | 微软 Edge TTS 偶发不可用会自动回退浏览器朗读；仍无声就检查系统音量与静音；持续 503 看服务端日志 |
| DeepSeek 401 / 余额不足 | Key 没复制完整、账户没余额，或网络访问不了 `api.deepseek.com`；站长模式确认 `DEEPSEEK_API_KEY` 已配置 |
| DeepSeek 纯语音延迟 1.5–3 秒偏高 | 这是该模式的设计（识别停顿提交 + 文本往返 + 首句朗读）；要 < 1 秒请选百炼 / Gemini / OpenAI 端到端实时模式 |
| 历史课看不到外部 AI 写回的精批 | v2.2.0 已补逐句精批与报告 `top_mistakes` / `upgraded_sentences` 渲染；升级后**硬刷新**浏览器 |
| 端口被占用 | `.env` 里改 `PORT=3001`，网页与 MCP 会一起换端口 |
| 豆包连接失败 / 401 | 确认地址是 `…/mcp` 且服务在运行；设了 `MCP_TOKEN` 就要在请求头填 `Authorization: Bearer <token>` |
| DeepSeek Harness 里插件启动失败 | 确认 `ielts-mcp.bat` 绝对路径正确、本机 `node_modules` 已安装；Windows 必须经 `cmd /c` 调用（一键脚本已处理好）；可用 `node scripts/connect-agent.mjs --dry-run` 预览配置 |
| Codex / Claude / Cursor 没识别到 ielts-coach | 检查配置段是否被写进正确文件、JSON/TOML 是否合法，然后重启对应客户端 |
| `create_lesson` 没自动弹浏览器 | 云端/远程部署不会开浏览器，直接用返回的 `url`；本机被 `openBrowser:false` 关掉了也会不弹 |
| 多用户模式下网页看不到 AI 新建的课 | 确认 `MULTI_USER_MODE` 是否符合预期；公网访客需通过 `?lesson=<id>` 链接进入，跨用户列表需要 `MCP_TOKEN` |
| 课程/记忆重启后消失 | 云端没给 `IELTS_COACH_DATA_DIR` 挂持久卷 |
| `npm install` 很慢 | `npm config set registry https://registry.npmmirror.com` |
| Node 版本报错 | 必须 Node 20+：`node -v` |

## 十一、开发

```bash
npm install
npm run dev        # 前端 5173 + 网关 3000
npm run typecheck
npm test           # server 的协议 / 网关 / MCP / 纯语音路由测试
npm run build && npm start
```

目录：`shared/`（协议与雅思 Prompt）、`server/`（网关、三家实时语音适配器 + DeepSeek 纯语音路由 /
Edge Neural TTS、MCP 与共享存储）、`web/`（React PWA）、`skills/`（全生态 Skill）、
`scripts/`（一键接入脚本）。

单独调试 MCP：

```bash
node scripts/connect-agent.mjs --dry-run     # 预览各客户端配置
node node_modules/tsx/dist/cli.mjs server/src/mcp-stdio.ts   # 手工跑 STDIO（stdout 只允许 JSON-RPC）
```

交付与验证记录见 `docs/V2_DELIVERY.md`（含 v2.2.0 的本机实测证据与未实测清单），
本版变更见 `docs/RELEASE_NOTES_v2.2.0.md`。

**依赖许可提示**：本项目自身为 MIT；DeepSeek 纯语音的朗读依赖
[`@andresaya/edge-tts`](https://github.com/andresayac/edge-tts) 为 **GPL-3.0-only**
（微软 Edge 朗读服务的轻量封装，仅服务端调用）。个人自用无影响；若你要分发闭源镜像 / 商业产品，
请评估该依赖的 GPL 义务，或把 `/api/voice/tts` 换成自建 TTS 服务。MCP 相关依赖
（`@modelcontextprotocol/sdk`、`zod`）均为 MIT。

## 十二、旧版本

v1（本地 Python / Whisper / 桌面窗口）保留在分支 `archive/v1-local-python`，不再维护。
