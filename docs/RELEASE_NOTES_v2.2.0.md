# IELTS 口语教练 v2.2.0

**只需要一个 DeepSeek API Key，就能在网页里开麦练雅思口语。** 浏览器原生语音识别听你说话并
实时上字幕，DeepSeek 流式生成考官回复，微软 Edge Neural TTS 免费把考官的声音读出来
（英音 Sonia / 美音 Jenny，中文自动换音色）。没有百炼 / Gemini / OpenAI 的实时语音 Key，
也能完整走完「对话 → 逐句精批 → 四维报告」。

## 新增

- **DeepSeek 纯语音模式（新服务商，设置里排第一）**：1 个 DeepSeek Key 全搞定 ——
  - 听写：浏览器原生 `SpeechRecognition`，逐字上屏；Safari / Chrome 自动断段重启时做
    「已提交前缀 + 本段结果」拼接，尽量不断字；
  - 回复：服务端 `POST /api/voice/deepseek-turn` 以 SSE 流式调用 `deepseek-chat`，考官字幕逐字出现；
  - 朗读：`POST /api/voice/tts` 走微软 Edge Neural TTS，中文提问自动换 `Xiaoxiao` 音色，
    前端用已解锁的 `AudioContext` 播放，规避 Safari / iOS 自动播放拦截；
  - 提交：自由模式约 1.35–1.75 秒停顿自动提交；手动模式 / Part 2 独白不自动截断，点「我说完了」才提交；
  - 打断：点「打断」立即停朗读、中止 SSE、马上开麦；考官播报期间自动暂停识别防回声。
- **打字兜底**：浏览器不支持语音识别，或国内 Chrome 报 `network` 错误时，底部自动展开打字输入框
  （顶部同时给出中文提示与建议），流程绝不卡死。
- **TTS 兜底**：Edge TTS 偶发不可用返回 503 时，前端自动回退浏览器 `window.speechSynthesis`
  系统朗读，不影响继续对话。
- **识别语言切换**：通话中顶部 `🎤 识别：英文 / 中文` 一键切换，方便用中文向考官提问。
- **考官口音**：设置里可选「英音考官 Sonia」/「美音考官 Jenny」，中文内容自动使用中文音色。
- **API Key 获取指南**：设置内新增「还没有 API Key？各家获取方式与免费额度」折叠卡片，
  附 DeepSeek / 百炼 / Gemini / OpenAI 官方直达链接；首页新增「获取 API Key」按钮；
  README 新增《如何获取 API Key（含免费额度）》一节，对比各模式的延迟、费用、网络要求，
  并给出「30 秒选哪种模式」建议。
- **依赖**：新增 `@andresaya/edge-tts`（纯 JS，无 Python / 原生依赖，`npm install` 即装）。

## 修复（v2.1.0 走查发现的 3 个缺陷）

- **历史课详情补齐逐句精批**：回看单节历史课，每条用户字幕下会渲染已写回的 `TurnFeedback`
  （红绿修正句、Band 8 升级句、语法错因、教练点评），四维报告补齐 `top_mistakes` 与
  `upgraded_sentences`；本地与服务端课程合并时，只写回精批、还没出报告的课程也能立刻显示。
- **`save_turn_feedback` 放宽外层校验**：`items` 元素由 `z.strictObject` 改为 `z.object`，
  豆包 / Codex / dsh 等外部 LLM 多传 `turnIndex` 之类的附带字段不再导致整包被拒收。
- **多用户模式下浏览器同步携带口令**：`MULTI_USER_MODE=true` 部署时，课程同步与记忆接口按需
  附带 `Authorization: Bearer <accessCode>`，输过访问口令的访客也能正常同步历史与长期记忆。

## 升级步骤

1. `git pull` 拉取 v2.2.0；
2. `npm install`（新增 `@andresaya/edge-tts`；已有 `node_modules` 也建议跑一次以补齐 lock 中条目）；
3. `npm run build`（`web/dist` 需要重建）；
4. **硬刷新浏览器**（macOS `Cmd+Shift+R` / Windows `Ctrl+F5`），避免旧前端缓存；
5. 设置 → 服务商选 **「DeepSeek 纯语音（仅需 DeepSeek Key）」** → 填 Key → 选口音 → 开始对话。
   已有 localStorage 设置（Key / 口令 / 模式）原样保留，不用重新填；
6. 云端用户：重新部署镜像即可，**无需新增环境变量** —— 纯语音模式复用 `DEEPSEEK_API_KEY`，
   朗读走微软 Edge TTS（免费、无 Key）。

## 验收

- `npm run typecheck` / `npm run build` / `npm test` 全部通过：8 个测试文件 / **85 项全绿**，
  含 DeepSeek 鉴权、SSE 流式路由（本地假上游）、Edge TTS 文本处理、`save_turn_feedback` 回归。
- 真实进程 E2E smoke 21/21：`/health` 报 2.2.0、`POST /api/voice/deepseek-turn` 流式协议与鉴权、
  **真实 Edge TTS 合成**（英音 / 美音 / 中文三种音色）、`ACCESS_CODE` 共享模式、MCP 7 工具回归。
- 完整数字与证据见 `docs/V2_DELIVERY.md` 的「v2.2.0 交付说明」。
- 文档与打包已复核：版本 `2.2.0`（4 个 `package.json` + `package-lock.json` 的 5 处 workspace
  version），README / `.env.example` / docs 均 UTF-8 无 BOM，README 官方入口链接实测可达。
- **未实测**：真实 DeepSeek / 百炼 / Gemini / OpenAI Key、真实浏览器 `SpeechRecognition` 与真麦克风、
  真机 iPhone Safari / Android 的 `AudioContext` 解锁与 TTS 播放、`docker build` 与云平台部署。
  详见 `docs/V2_DELIVERY.md`。

## 已知边界

- DeepSeek 纯语音是「浏览器识别 + 文本模型 + TTS」拼出来的语音体验，体感延迟约 1.5–3 秒，
  不是端到端实时语音；想要 < 1 秒请用百炼 / Gemini / OpenAI 实时模式。
- 需能访问 `api.deepseek.com` 与微软 TTS 服务；Chrome 语音识别在国内网络下可能不可用
  （换 Safari，或直接用底部打字输入），Firefox 不支持 `SpeechRecognition`。
- Safari 自动断段重启的拼接是 best-effort，极长句仍可能偶发断字。
- Edge TTS 偶发失败会自动回退系统朗读（音色变化，不影响对话继续）。
- 单机模式数据仍在本机 `store.json`；多用户隔离、MCP 等 v2.1.0 行为不变。
