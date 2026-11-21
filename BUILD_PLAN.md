# 分阶段开发与验收计划 (`BUILD_PLAN.md`)

> 本项目严格按 **Phase 1 → Phase 2 → Phase 3** 迭代推进。每完成一个 Phase 必须通过对应的验收测试，再进入下一阶段，避免一次性堆砌导致音频/模型/协议问题纠缠在一起。

---

## Phase 1：MVP 通路跑通（对话 + 即时语法纠错 + 课后报告 + 本地记忆）

**目标**：让用户在 `dsh` 里单开一个任务就能真正开口练雅思：考官用本地 Kokoro 发声提问，网页录音采集后用本地 Faster-Whisper 转写，用户的底层智能体给出**即时语法/表达纠错卡片**，全部对话和错题存入 SQLite 长期记忆，点击结束生成**完整学习报告**。

### 任务拆解
1. **工程脚手架与环境探测 (`pyproject.toml`, `daemon/config.py`)**
   - 使用 `uv` 初始化 Python 3.11+ 环境。
   - 实现硬件探测（优先 `cuda` > `mps` > `cpu`）与目录初始化（`~/.ielts-coach/audio`, `~/.ielts-coach/reports`, `~/.ielts-coach/ielts_coach.db`）。
   - 安装依赖：`fastapi`, `uvicorn`, `websockets`, `faster-whisper`, `kokoro>=0.9.4`, `soundfile`, `mcp[cli]`, `httpx`, `pytest`。
   - 检查系统依赖 `espeak-ng` 是否安装，未安装时给出清晰安装提示或自动指引。
2. **数据库与长期记忆层 (`daemon/db.py`)**
   - 读取 `database/schema.sql` 自动建表（幂等）。
   - 实现所有表的 CRUD 与聚合查询（`get_learner_context`, `get_lesson_aggregation`, `upsert_memory_note`, `save_lesson_report`）。
3. **本地音频基座 (`daemon/audio/asr.py`, `daemon/audio/tts.py`, `daemon/audio/processor.py`)**
   - `asr.py`：常驻加载 `faster-whisper`（CUDA 默认 `large-v3-turbo`，CPU/MPS 默认 `medium.en` 或可配置），输出文本、`wpm`、停顿位置数组。
   - `tts.py`：常驻加载 `Kokoro-82M`（支持 `uk` / `us` 切换），输出 24kHz WAV 并做文本哈希缓存。
4. **核心 Daemon 与状态机 (`daemon/main.py`, `daemon/state_machine.py`)**
   - 提供 REST + WebSocket 服务（默认 `127.0.0.1:8765`）。
   - 实现安全不超时的 `wait_for_turn` 事件机制（单次等待上限 40 秒，区分 `waiting_for_learner` / `recording_in_progress` / `learner_replied` / `lesson_ended_by_user`）。
5. **伴生 Web 前端 MVP (`web_src/` → 构建至 `daemon/static/`)**
   - 实现 16kHz Mono PCM WAV 浏览器录音机（`AudioWorklet` / `AudioContext`，不依赖 `ffmpeg`）。
   - 实现考官语音播放、Part 2 计时器、即时纠错卡片流（原句 vs 语法修正 vs 7.5+ 升级句）、结束课程与报告展示页。
6. **MCP Bridge 与 Skill 注册 (`mcp_bridge/server.py`)**
   - 使用 `FastMCP` 实现 `DESIGN_SPEC.md` 第 5 节全部 8 个 MCP 工具。
   - 实现 Daemon 自动探测与后台拉起逻辑（避免每个 MCP 会话重复加载大模型）。
   - 生成适配 `dsh` / Claude Code / Cursor 的一键安装配置脚本。

### Phase 1 验收标准
- [ ] `pytest tests/test_db.py tests/test_asr_fluency.py tests/test_mcp_e2e.py` 全部通过。
- [ ] 在 `dsh` 中安装该 MCP Server 和 `skills/ielts-speaking-coach/SKILL.md` 后，单开一个任务说“开始练雅思 Part 1”，自动拉起 `http://127.0.0.1:8765`。
- [ ] 浏览器完成至少 3 轮语音对话，每轮都能在 3~5 秒内看到右侧即时纠错卡片并听到下一题语音。
- [ ] 点击“结束本课”，成功生成并保存 `.md` 学习报告，且再次新开任务时，智能体能回忆起上次记下的个人事实与语法错题。

---

## Phase 2：声学发音评估引擎 + 连麦式即时问答界面改版

**目标**：补全“不挑底层文本模型的真发音纠正”（精准定位错词、替换音素与重音问题），并升级为免手动按停的**连麦式即时问答交互流**（配合 `silero-vad` 自动接话）。

### 任务拆解
1. **G2P 与音素强制对齐 (`daemon/audio/pronunciation.py`)**
   - 接入 `facebook/wav2vec2-xlsr-53-espeak-cv-ft`（或 `facebook/wav2vec2-lv-60-espeak-cv-ft`）与 `phonemizer` (`espeak-ng`) / `g2p_en`。
   - 基于 `torchaudio.functional.forced_align`（或 `ctc-forced-aligner`）提取帧级对齐区间 `[t_start, t_end]`。
   - 实现音素级 **GOP (Goodness of Pronunciation)** 计算、竞争音素识别（找出实际发成了哪个音）及 0~100 映射。
2. **接入实时管线与 Silero VAD 自动断句**
   - 升级 `daemon/audio/processor.py` 与前端语音流检测：引入 `silero-vad` 作为默认“自由连麦模式”的静音断句核心（停顿 ~1.8s 自动提交，保留手动模式兜底开关）。
   - 在用户提交 `.wav` 后并行运行 `asr.py` 与 `pronunciation.py`（`asyncio.gather`），把结果写入 `turns.pronunciation_json`、`turns.pronunciation_score` 与 `pronunciation_issues` 表，并透传给智能体。
3. **连麦式即时问答前端改版与发音交互 (`web_src/`)**
   - **一键连麦开课**：进入页只点一次 `开始语音连麦上课`，同步解锁浏览器音频自动播放与麦克风权限，消除“浏览器阻止自动播放”黄字提示。
   - **对话气泡流 + 底部连麦栏**：居中对话流（左考官气泡 / 右学习者气泡），把即时纠错条与单词红/黄/绿发音热力标色紧凑内嵌在对应学习者气泡下方；考官播报完自动亮麦收音。
   - **发音对比弹窗 (`PhonemeDrawer.tsx`)**：点击任意红/黄单词显示音标与发音部位提示，支持按时间戳截取播放**“我的原声片段”**，旁边点击播放**“Kokoro 标准示范音”**。
   - **实用细节**：Part 2 收到题卡先走 1 分钟准备倒计时（带“立即开讲”跳过按钮），开说后自动切 2 分钟作答计时；顶部加轻量级“往期课程/报告”抽屉。
   - 课后报告纳入真实的 `PR`（发音）评分维度与累计音素弱点榜。

### Phase 2 验收标准
- [ ] `pytest tests/test_gop_pronunciation.py` 及全量 `tests/` 回归通过：故意把 `"think"` 读成 `"sink"` 或漏掉词尾清辅音时，引擎能稳定检出低分单词与对应异常音素。
- [ ] 单轮整体声学处理耗时（ASR + GOP）在 GPU 下 < 2s、在 CPU/Apple Silicon 下 < 4.5s。
- [ ] 真人戴麦实测通过：一键开课后考官自动发声 → 自动亮麦收音 → 说完自然停顿自动提交 → 气泡下方即时出纠错与红黄绿单词标注 → 点击单词可听原声与标准音对比。

---

## Phase 3：DeepSeek Harness (`dsh`) 原生 Cordis 插件深度整合

**目标**：让 `dsh` 用户无需跳出 `dsh web` 主界面即可在标签页/侧边栏内完成全部口语训练，同时保留 MCP 能力以便兼容其它开发工具。

### 任务拆解
1. **启用 `dsh` Creator Mode 编写 Cordis Bundle (`dsh_plugin/`)**
   - 利用 `dsh` 内置的 `cordis-plugin-development` 技能，编写符合 `dsh` 规范的 `package.json`（含 `"dsh"` 字段）和 `cordis.patch.yml`。
   - 将 `http://127.0.0.1:8765` 的语音伴生面板挂载为 `dsh web` 中的原生扩展视图 / 快捷入口。
2. **一键注册脚本 (`scripts/install_dsh.py` 或 `.sh` / `.ps1`)**
   - 自动将 `skills/ielts-speaking-coach/SKILL.md` 软链或复制到 `~/.dsh/skills/`（及 `~/.agents/skills/`）。
   - 自动生成或更新 `dsh` 的 MCP 配置与 Cordis Bundle 安装命令（`dsh plugin --profile web add ...`）。

### Phase 3 验收标准
- [ ] 在 `dsh web` 中直接通过原生插件入口开启雅思口语任务，无需手动切换外部窗口或手动输入 URL。
- [ ] 其它非 `dsh` 工具（如 Claude Code / Cursor / Antigravity）仍可通过同一份 `mcp_bridge` + `SKILL.md` 正常运行 Phase 1 & Phase 2 全部功能。
