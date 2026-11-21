# 交给主力机 `dsh` 开发的分段提示词 (`DSH_HANDOFF_PROMPTS.md`)

> 你只需要把本文件夹复制到主力机，在终端或 `dsh web` 里进入该目录打开一个会话，按顺序复制下面 3 段提示词发给 `dsh` 即可。**每做完一个 Phase，先自己打开网页试说两句确认能用，再发下一段！**

---

## 第一步：让 `dsh` 开发 Phase 1（MVP 完整可对话版）

把下面整段话复制发给 `dsh`：

```text
请先完整阅读当前仓库里的 README.md、DESIGN_SPEC.md、BUILD_PLAN.md、database/schema.sql 和 skills/ielts-speaking-coach/SKILL.md。

现在请你作为主程，严格按照 DESIGN_SPEC.md 和 BUILD_PLAN.md 的【Phase 1】要求，结合当前电脑的操作系统（Windows/macOS/Linux）和硬件环境（CUDA/MPS/CPU），从零实现 Phase 1 的全部代码与自动化测试。

开发要求：
1. 环境探测：自动检测当前机器的 Python、uv/pip、GPU/MPS/CPU、Node.js（用于编译 web_src）和 espeak-ng 情况；如果缺少 espeak-ng 或 uv 等系统工具，先明确告诉我或帮我安装好再继续。
2. 目录与代码：严格按 DESIGN_SPEC.md 第 3.2 节的目录结构实现 daemon/、mcp_bridge/、web_src/（并打包输出到 daemon/static/）和 tests/。
3. 录音兼容：伴生网页前端必须使用 Web Audio API 直接采集并导出 16kHz 单声道 PCM WAV，禁止依赖浏览器 MediaRecorder 的 webm/mp4 转码，确保跨平台零 ffmpeg 报错。
4. 及时纠错与防超时：MCP Bridge 的 respond_with_feedback_and_wait 和 wait_for_learner_turn 单次最多阻塞 40 秒，严禁触发 MCP 客户端超时；伴生网页支持每次回答后 2~5 秒内弹出右侧即时纠错卡片，并支持“结束本课并生成报告”。
5. 验证与安装：编写并运行 Phase 1 的 pytest 单元测试与端到端测试；最后帮我把 ielts-coach MCP Server 和 skills/ielts-speaking-coach/SKILL.md 注册安装到本机的 dsh 配置中，并告诉我如何在 dsh 里新开任务开始第一次口语练习。
```

---

## 第二步：Phase 1 复核拍板 + UI 改版 + Phase 2（真·发音音素纠正引擎）

> 如果你已经在主力机拿到了 `docs/PHASE1_DELIVERY.md`，推荐直接使用更完整的 **[PHASE1_REVIEW_AND_PHASE2_HANDOFF.md](./PHASE1_REVIEW_AND_PHASE2_HANDOFF.md)**（里面已经包含对 D1 / D2 / D11 的拍板、连麦式即时问答界面改版要求和 Phase 2 指令）。

Phase 1 交付后，把下面整段话发给 `dsh`：

```text
请先阅读 DESIGN_SPEC.md（含第 4.1、第 5、第 6 节的更新）、BUILD_PLAN.md【Phase 2】和 skills/ielts-speaking-coach/SKILL.md，结合 docs/PHASE1_DELIVERY.md 按以下要求一并完成交互改版与 Phase 2 开发：

1. 决策拍板：
   - D1：保留全部 10 个 MCP 工具（含 end_lesson 与 daemon_status），同步更新你的 SKILL.md 与 DESIGN_SPEC.md。
   - D2：引入 silero-vad 作为默认“自由连麦自动停录”核心 VAD（保留手动按键切换开关）。
   - D11：不在 daemon 层硬切 examiner_text，维持 SKILL.md 约束。
   - Part 2 计时先 1 分钟准备（带“立即开讲”按钮），开口后自动切 2 分钟作答；顶部加轻量往期课程/报告抽屉；不做开机自启。

2. 前端连麦式即时问答改版（web_src/ 重新打包至 daemon/static/）：
   - 首屏提供“开始语音连麦上课”一键按钮，点击一次同时解锁浏览器音频自动播放与麦克风权限，消除“浏览器阻止自动播放”黄字。
   - 默认自动接话闭环：考官语音播完自动开麦，配合 silero-vad 自然停顿（~1.8s）后自动发送。
   - 主界面改为居中聊天对话气泡流，纠错卡与单词发音标色紧凑挂在对应学习者气泡下方，底部固定极简声波状态栏、静音、重说与结束本课按钮。

3. Phase 2 声学发音引擎（按 PHASE1_DELIVERY.md 第 11 节接入点）：
   - 实现 daemon/audio/pronunciation.py：Wav2Vec2 音素识别（如 facebook/wav2vec2-xlsr-53-espeak-cv-ft）+ G2P（phonemizer/g2p_en）+ 强制对齐与 GOP 评分，模型预热常驻内存并与 faster-whisper 并行运行，结果写入数据库并透传给 agent。
   - 升级 PhonemeDrawer 与气泡纠错条：展示绿/黄/红单词热力标色，点击单词可看音标技巧并对比播放“我的原声片段”与“Kokoro 标准示范音”。
   - 编写 tests/test_gop_pronunciation.py 并确保全部 pytest 回归通过，汇报耗时与结果，我将亲自戴麦试说验收。
```

---

## 第三步：最后让 `dsh` 把插件原生嵌进 DeepSeek Harness (`dsh web`)

Phase 2 测试通过后，在 `dsh` 里发这段话：

```text
请阅读 DESIGN_SPEC.md 第 7 节和 BUILD_PLAN.md 的【Phase 3】要求，使用 DeepSeek Harness 的插件开发规范（如内置的 cordis-plugin-development 能力），在 dsh_plugin/ 目录下为本项目封装一个原生的 dsh Cordis Bundle 插件：
1. 让用户可以在 dsh web（http://127.0.0.1:3080）的界面中直接打开或侧边嵌入我们的雅思口语伴生面板（http://127.0.0.1:8765），不用单独跳去外部浏览器标签页。
2. 保留原有的 MCP stdio 入口和独立浏览器访问能力，确保 Cursor / Claude Code / Antigravity 等其它工具依然兼容可用。
3. 提供一键安装脚本（自动安装 dsh bundle、MCP 配置和全局 ~/.dsh/skills/），实际安装并在本地验证启动无报错后告诉我最终使用方法。
```
