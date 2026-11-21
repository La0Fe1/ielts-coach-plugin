# IELTS Speaking Coach Plugin — 完整架构与工程详细设计 (`DESIGN_SPEC.md`)

> 本文档面向 **DeepSeek Harness (`dsh`)** 及开发代理编写，定义了插件的完整系统框架、模块边界、算法细节、接口契约、数据库结构及前端交互规范。

---

## 1. 产品目标与核心约束

1. **宿主兼容性**：优先深度兼容 **DeepSeek Harness (`dsh`)**，同时通过标准 **MCP (`stdio`) + `SKILL.md` + 本地 Web 伴生页**，无缝挂载到 Claude Code、Cursor、Antigravity 等其它开发工具中，支持用户“单开一个对话任务”随时唤起。
2. **复用用户绑定的底层智能体**：对话推理、考官追问、语法纠错、地道表达升级、课后报告总结均由用户自己绑定的模型完成（DeepSeek / Claude / GPT / Gemini / 本地 Ollama 均可），插件不内置额外 LLM API Key 计费层。
3. **不挑模型的“真发音纠正”**：由于纯文本大模型看不到音素和重音细节，插件内置**本地声学感知层（ASR + 音素强制对齐 + GOP 发音评分）**，把发音缺陷转译为结构化 JSON 喂给用户的底层智能体。
4. **即时纠错 + 课后学习报告**：
   - **课中**：每回答一轮，**立即（~2-3秒内）**在伴生界面展示语法修改、7.5+ 表达升级、标红错音单词（支持“我的录音 vs 标准示范”点击对比回放），并支持考官口头轻提示（可切换开关）。
   - **课后**：点击结束或口头结束时，自动汇总全课数据与历史曲线，生成结构化评分（FC / LR / GRA / PR）+ 错题本 + 发音诊断榜 + 下节课处方，并写入本地持久化记忆。
5. **本地体积无限制**：优先保证识别准确率、音素精度和 TTS 自然度，使用高精度本地模型（模型权重约 2~4 GB），并常驻后台守护进程避免重复加载。

---

## 2. 总体架构（四层解耦）

```text
┌────────────────────────────────────────────────────────────────────┐
│  宿主层 (Host Agent Runtime)                                       │
│  DeepSeek Harness (`dsh`) / Cursor / Claude Code / Antigravity     │
│  - 加载 skills/ielts-speaking-coach/SKILL.md                       │
│  - 绑定用户自己的 LLM (DeepSeek / Claude / etc.)                   │
│  - Phase 3 可选: dsh Cordis 原生 UI 插件嵌合                       │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ MCP (stdio JSON-RPC)
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  协议桥接层 (`mcp_bridge/server.py` - FastMCP stdio)               │
│  - 轻量进程，启动时检查 127.0.0.1:8765/health                       │
│  - 若 Daemon 未启动则自动后台拉起；所有 MCP 工具转发至 Daemon      │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ HTTP + WebSocket (127.0.0.1:8765)
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  核心本地守护进程 (`daemon/` - Python FastAPI + PyTorch)           │
│  - 模型常驻内存: Silero VAD + Faster-Whisper + Wav2Vec2 GOP + Kokoro│
│  - 音频与会话状态机 (等待录音 -> 语音识别 -> 声学打分 -> 推流播报)  │
│  - SQLite 持久化 (~/.ielts-coach/ielts_coach.db)                   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ WebSocket + Audio Blob
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│  本地 Web 伴生交互层 (`web/` - 127.0.0.1:8765)                     │
│  - 浏览器直采 16kHz Mono PCM/WAV（避开跨平台 ffmpeg/webm 编解码坑） │
│  - 实时波形 + VAD 静音自动停录 / 手动点击结束                       │
│  - 左侧：考官对话与 Part 2 题卡倒计时                              │
│  - 右侧：每轮即时纠错卡片 + 音素红黄绿高亮 + 个人/示范对比回放      │
│  - 课后视图：四维雷达/柱状图 + Markdown 学习报告导出                │
└────────────────────────────────────────────────────────────────────┘
```

### 为什么采用 `FastMCP stdio 桥 + 单例 Daemon`？
1. 如果 MCP 进程直接加载 3GB 的 Whisper + Wav2Vec2 + Kokoro，用户每单开一个新对话任务就会重新冷启动加载 10 秒甚至 OOM。
2. 拆分后，`ielts-daemon` 在后台常驻（可设空闲 30 分钟自动释放显存或按需休眠），而每次开新任务拉起的 `mcp_bridge` 是毫秒级启动的纯代理进程。

---

## 3. 技术栈与目录结构设计

### 3.1 推荐技术栈（跨 Windows / macOS / Linux）

| 模块 | 选型 | 说明 |
| :--- | :--- | :--- |
| 运行环境 | Python 3.11+ (`uv` 管理) | 统一管理 PyTorch / CUDA / MPS / CPU 环境 |
| Web / API 服务 | `fastapi` + `uvicorn` + `websockets` | 提供 REST API、WebSocket 实时推送及静态前端托管 |
| MCP SDK | `mcp` (`FastMCP`, stdio 传输) | 标准 MCP 协议，所有 AI 开发软件通用 |
| 硬件加速检测 | 自动探测 `cuda` > `mps` > `cpu` | Windows/Linux N卡走 CUDA (`float16`)，Mac M系列走 MPS/CPU (`int8`/`float32`) |
| 语音活动检测 (VAD) | `silero-vad` | 检测用户何时停止说话（支持可调静音阈值如 1.8s，且提供“手动点发送”防误切） |
| 语音转文字 (ASR) | `faster-whisper` (`large-v3-turbo` 或 `medium.en`) | 体积无限制优先用 `large-v3-turbo`（CUDA 下极快，CPU/Mac 可用 `distil-large-v3` 或 `medium.en` `int8`）并开启 `word_timestamps=True` |
| 音素与发音评分 (Phase 2) | `transformers` (`facebook/wav2vec2-xlsr-53-espeak-cv-ft` 或 `wav2vec2-lv-60-espeak-cv-ft`) + `torchaudio` / `ctc-forced-aligner` + `phonemizer` (`espeak-ng`) / `g2p_en` | 获取音素级帧概率与强制对齐，计算 **GOP (Goodness of Pronunciation)** 与单词重音偏离 |
| 本地 TTS 考官播报 | `kokoro >= 0.9.4` (`hexgrad/Kokoro-82M`) + `soundfile` | 支持英音（`bf_emma`, `bm_george`）与美音（`af_heart`, `am_michael`），24kHz 自然语音，推理快于实时 |
| 数据库 | SQLite 3 (`WAL` 模式) | 本地单文件 `~/.ielts-coach/ielts_coach.db`，零运维 |
| 前端界面 | React + Vite + TypeScript（打包后由 FastAPI 直接托管静态文件）或零构建 Alpine/Tailwind + Web Audio API | 打包进 `daemon/static/`，用户无需额外开前端 dev server |

### 3.2 推荐项目目录结构

```text
ielts-coach-plugin/
├── README.md                        # 使用指南
├── DESIGN_SPEC.md                   # 本设计文档
├── BUILD_PLAN.md                    # 分阶段开发与验收清单
├── pyproject.toml                   # Python 依赖与 CLI 入口 (ielts-daemon, ielts-mcp)
├── database/
│   └── schema.sql                   # SQLite 建表脚本
├── skills/
│   └── ielts-speaking-coach/
│       └── SKILL.md                 # Agent 行为规范与雅思评分准则
├── prompts/
│   └── DSH_HANDOFF_PROMPTS.md       # 给主力机 dsh 的分步开发提示词
├── daemon/                          # [Phase 1 & 2 实现] 核心后端守护进程
│   ├── __init__.py
│   ├── config.py                    # 路径 (~/.ielts-coach)、端口、硬件自检配置
│   ├── db.py                        # SQLite 连接池、初始化与 CRUD 封装
│   ├── main.py                      # FastAPI + WebSocket 服务入口 & 生命周期管理
│   ├── state_machine.py             # 会话状态、Long-Poll Turn 协调器 (Event/Queue)
│   ├── audio/
│   │   ├── processor.py             # 16kHz PCM 校验、VAD 切分、音频保存
│   │   ├── asr.py                   # faster-whisper 转写 + WPM + 停顿检测
│   │   ├── pronunciation.py         # [Phase 2] G2P + Wav2Vec2 强制对齐 + GOP 评分
│   │   └── tts.py                   # Kokoro-82M 语音合成与磁盘缓存
│   └── static/                      # 编译后的伴生 Web UI 静态资源
├── mcp_bridge/                      # [Phase 1 实现] MCP Server 入口
│   ├── __init__.py
│   └── server.py                    # FastMCP stdio 工具定义 + Daemon 自动拉起
├── web_src/                         # [Phase 1 & 2 实现] 前端源码 (React+Vite+TS)
│   ├── package.json
│   └── src/
│       ├── audio/pcmRecorder.ts     # Web Audio API 直采 16kHz Mono WAV
│       ├── components/
│       │   ├── ExaminerPanel.tsx    # 考官状态、音频播放、Part 2 2分钟/1分钟计时器
│       │   ├── TurnCard.tsx         # 即时纠错卡片 (原句/纠错/7.5+升级/发音高亮)
│       │   ├── PhonemeDrawer.tsx    # [Phase 2] 单词音标拆解 + 我的录音/标准音对比
│       │   ├── MemorySidebar.tsx    # 本地长期记忆面板 (高频语法错/弱音素/Part 2素材)
│       │   └── LessonReportView.tsx # 课后四维成绩单与报告展示/导出
│       └── App.tsx
├── dsh_plugin/                      # [Phase 3 实现] DeepSeek Harness 原生 Cordis 插件
│   ├── package.json                 # 含 "dsh" bundle 声明
│   ├── cordis.patch.yml
│   └── src/
└── tests/
    ├── test_db.py
    ├── test_asr_fluency.py
    ├── test_gop_pronunciation.py    # [Phase 2]
    └── test_mcp_e2e.py              # 模拟一轮完整对话与课后报告
```

---

## 4. 核心模块详细设计

### 4.1 浏览器端零兼容性踩坑录音 (`web_src/src/audio/pcmRecorder.ts`)
不同浏览器的 `MediaRecorder` 默认编码各异（Chrome 输出 `webm/opus`，Safari 输出 `mp4/aac`），在 Windows/Mac 上极其容易因缺少 `ffmpeg` 解码器而报错。
**强制方案**：
- 使用 Web Audio API (`AudioContext` + `AudioWorkletNode`) 直接采集麦克风原始 PCM 浮点流，在浏览器端下采样为 **16,000 Hz, 单声道, 16-bit PCM WAV** 后通过 HTTP `POST /api/sessions/{id}/audio` 或 WebSocket 二进制帧发给后端。
- **优势**：Python 后端用标准库 `wave` / `soundfile` 即可零依赖直接读取，完全摆脱 `ffmpeg` 跨平台噩梦。
- **录音触发模式（连麦自动接话优先，兼顾手动兜底）**：
  1. **一键连麦授权**：开课首屏提供醒目的 **`🎙️ 开始语音连麦上课`** 入口，用户点击这一次同时解锁浏览器音频自动播放权限与麦克风权限，彻底消除“浏览器阻止自动播放”阻塞。
  2. **自由连麦模式（默认）**：考官 TTS 播报完毕后，麦克风自动开启收音；基于 **`silero-vad`** 检测人声起止，用户说完自然停顿约 **1.8 秒** 自动切段提交（Phase 1 可先用能量阈值兜底，Phase 2 强制升级为 `silero-vad`）。
  3. **手动按键模式（底部小开关可切换）**：适合 Part 2 长篇思考或环境嘈杂时使用，避免思考停顿被切段。

### 4.2 ASR 与流利度计算 (`daemon/audio/asr.py`)
接收用户本轮 `.wav` 后执行：
1. **Faster-Whisper 推理**：
   - `language="en"`, `word_timestamps=True`, `vad_filter=True`。
   - 返回完整文本 `transcript` 及每个词的 `{word, start, end, probability}`。
2. **流利度指标计算（供 FC 评分与即时反馈）**：
   - `duration_sec`: 有效发声总时长（扣除首尾大段静音）。
   - `wpm`: `(word_count / duration_sec) * 60`（雅思流畅参考区间通常在 110–150 WPM）。
   - `pauses`: 遍历相邻单词间隙 `next.start - prev.end`：
     - 若间隙 `>= 0.8s`，记为一次明显停顿（Hesitation），记录 `{"after_word": prev.word, "duration_sec": round(gap, 2)}`。
   - `filler_words`: 统计 `"um"`, `"uh"`, `"er"`, `"like"`, `"you know"` 等犹豫词次数。

### 4.3 Phase 2：声学发音评估与 GOP 算法 (`daemon/audio/pronunciation.py`)
这是解决“纯文本模型听不到发音错误”的核心引擎。流程如下：

1. **目标音素序列生成 (G2P)**：
   - 将 ASR 识别出的 `transcript` 按词切分，通过 `g2p_en`（生成 ARPAbet）或 `phonemizer` (`espeak-ng`, 生成 IPA) 转换为标准音素序列，例如：
     `"think"` → `["θ", "ɪ", "ŋ", "k"]`。
   - 注：若用户实际说错了词导致 ASR 误识别（例如想说 *think* 但读成了 *sink*），可在对齐时同时检查该词所在时间窗的真实解码音素流，识别出用户发成了 `/s/`。

2. **音素级声学后验矩阵与强制对齐**：
   - 加载 `facebook/wav2vec2-xlsr-53-espeak-cv-ft`（输出维度直接对应 IPA 音素词表）。
   - 对 16kHz 音频前向推理得到帧级对数概率矩阵 `log_probs` `[T, V]`（每帧 20ms）。
   - 使用 `torchaudio.functional.forced_align`（或 `ctc-forced-aligner`）将目标音素序列对齐到帧区间 `[t_start, t_end]`。

3. **计算音素 GOP（Goodness of Pronunciation）分数**：
   - 对每个音素 $p$ 在对齐区间 $[t_1, t_2]$ 上：
     $$\text{GOP}(p) = \frac{1}{t_2 - t_1 + 1} \sum_{t=t_1}^{t_2} \left( \log P(p \mid O_t) - \max_{q \neq p} \log P(q \mid O_t) \right)$$
   - 若某帧最强竞争音素 $q^*$ 显著高于目标音素 $p$（即 $\text{GOP}(p) < -1.5$），记录为**疑似替换音素**（例如目标 `θ`，实际最强音素 `s`）。
   - 将原生 GOP 映射到易读的 **0~100 分**（通过 Sigmoid 映射并利用 `speechocean762` 样本做阈值校准）：
     - `>= 80`: 绿色（清晰地道）
     - `60 ~ 79`: 黄色（可懂但略带口音/不够饱满）
     - `< 60`: 红色（需重点纠正）

4. **输出给智能体的结构化发音 JSON**：
   ```json
   {
     "overall_score": 74.5,
     "flagged_words": [
       {
         "word": "think",
         "word_score": 48,
         "expected_ipa": "θɪŋk",
         "audio_start_sec": 2.14,
         "audio_end_sec": 2.52,
         "issues": [
           {
             "phoneme": "θ",
             "likely_pronounced_as": "s",
             "gop_score": -2.7,
             "issue_type": "phoneme_distortion"
           }
         ]
       }
     ],
     "weak_phonemes": [
       {"phoneme": "θ", "avg_score": 48, "count": 2, "examples": ["think", "something"]}
     ]
   }
   ```
   - **重要**：由于记录了 `audio_start_sec` 和 `audio_end_sec`，前端网页可以直接裁剪播放用户原声中 `"think"` 那 0.38 秒片段，旁边放一个 Kokoro 合成的 `"think"` 标准英/美音按钮，实现一键听音对比！

### 4.4 本地 TTS 考官播报 (`daemon/audio/tts.py`)
- 使用 `kokoro` (`KPipeline`) 常驻加载：
  - 英音模式 (`accent='uk'`): `lang_code='b'`, 默认音色 `bf_emma` 或 `bm_george`。
  - 美音模式 (`accent='us'`): `lang_code='a'`, 默认音色 `af_heart` 或 `am_michael`。
- 按句子切分生成 `24kHz` WAV，存入 `~/.ielts-coach/audio/tts_cache/` 并推送 URL 给前端自动播放。
- 额外提供 `/api/tts/word?text=technology&accent=uk` 接口，供前端纠错卡片点击任意高亮单词即时发声示范（带本地缓存，二次点击 0ms 响应）。

---

## 5. MCP 工具契约（`mcp_bridge/server.py`）

为了让所有支持 MCP 的开发工具与 `SKILL.md` 顺畅配合，定义以下 **10 个工具（8 个核心 + 2 个辅助）**：

| 工具名 | 作用 | 关键参数与返回值 |
| :--- | :--- | :--- |
| `get_learner_context` | 开课前拉取长期记忆 | 无参数；返回 `profile`、Top 5 语法顽疾、Top 5 弱音素、Part 2 已有素材摘要、上节课处方 |
| `start_lesson` | 创建课程并拉起前端伴生页 | 入参：`part_mode`, `topic_hint`, `feedback_style`, `target_band`；自动打开浏览器（或通知 `dsh` 面板），返回 `session_id`, `companion_url` |
| `respond_with_feedback_and_wait` | **核心每轮工具（合并纠错+提问+等回复）** | 入参：`session_id`, `examiner_text`, `part`, `turn_id_for_feedback`(可选), `feedback_payload`(可选 JSON), `timeout_sec=40`。<br>行为：先存上一轮纠错并推 UI 卡片 -> 播放 `examiner_text` TTS -> 阻塞等待学生回复。<br>返回：`status` (`learner_replied` / `recording_in_progress` / `waiting_for_learner` / `lesson_ended_by_user`) + 转写、流利度、发音 JSON |
| `wait_for_learner_turn` | 超时续等辅助工具（防 MCP 60s 超时） | 入参：`session_id`, `timeout_sec=40`；当上一个工具返回 `waiting_for_learner` 或 `recording_in_progress` 时由 Agent 静默续调 |
| `push_turn_feedback` | 单独推送纠错卡片（用于结束前最后一句收尾） | 入参：`session_id`, `turn_id`, `feedback_payload` |
| `update_learner_memory` | 更新本地长期记忆 | 入参：`memory_items[]` (`memory_type`, `memory_key`, `title`, `content`, `mastery_delta`) |
| `get_lesson_aggregation` | 课后汇总全课指标与历史对比 | 入参：`session_id`；返回所有轮次明细、错题频次统计、发音平均分、历史曲线对比 |
| `save_lesson_report` | 保存并展示课后学习报告 | 入参：`session_id`, `bands_json`, `report_markdown`, `next_lesson_plan`；写入 DB + 导出 `~/.ielts-coach/reports/` + 触发前端切换到报告视图 |
| `end_lesson` | 辅助工具：Agent 侧主动结束课程 | 入参：`session_id`, `reason`；当用户通过语音说“下课/结束”时释放长轮询等待状态，等价于网页结束按钮 |
| `daemon_status` | 辅助工具：环境与守护进程自检 | 无参数；返回 daemon 运行状态、模型加载情况、硬件设备与伴生页 URL，用于排障 |

> **关键设计说明（防超时、低延迟与模式约束）**：
> 1. 将“推送上一轮纠错”和“播报下一轮问题并等回答”合并进 `respond_with_feedback_and_wait`，每轮对话只需 **1 次 LLM 推理 + 1 次 MCP 调用**，把延迟压缩到极限。
> 2. 所有等待接口单次最长阻塞 **40 秒**，防止宿主机 MCP 客户端（通常 60s 超时）报超时错误；若用户在 Part 2 准备或长篇作答，返回 `recording_in_progress`，由 `SKILL.md` 引导 Agent 静默无缝续等。
> 3. **`instant_card_only` 模式约束边界**：不在 daemon 层用规则硬删 `examiner_text`（避免误切上下文破坏语气），统一由 `SKILL.md` 约束 Agent 遵循。

---

## 6. 连麦式即时问答流与课后报告 UI 规范 (`web_src/`)

> **核心交互原则**：摒弃“左控台手动录音 + 右表单列表”的语音输入法式体验，采用类似实时语音通话的**居中对话气泡流 + 自动接话闭环**，让用户专注与考官一问一答。

### 6.1 课中即时问答布局
- **顶部轻量栏**：
  - 课程信息（Part 1/2/3）、英音/美音切换、纠错风格切换（`即时语音+卡片` / `仅卡片·全真考官`）。
  - 轻量入口按钮：**`长期记忆`** 抽屉、**`往期课程/报告`** 抽屉、以及 **`结束本课并生成报告`** 按钮。
  - Part 2 题卡浮层：收到 Part 2 题目先进入 **1 分钟准备倒计时**（提供 **`立即开讲`** 跳过按钮），用户开始说话后自动切换为 **2 分钟作答计时条**。
- **居中主区域（即时问答气泡流）**：
  - **考官气泡（左对齐）**：实时显示考官口语文字，带语音播报动态波纹与一键重听图标。
  - **学习者气泡（右对齐）**：用户说完自动提交后立刻出现学习者气泡（先显示转写中动效，随后填入原话）。
  - **气泡内嵌即时纠错条（挂在每条学习者气泡正下方）**：
    - 默认紧凑展示 1 句亮点表扬 + 语法修改对比 + 7.5+ 地道升级（可展开详情），**不打断整体对话浏览节奏**。
    - **发音热力标色（Phase 2）**：原话单词按 GOP 分数标为 绿 / 黄 / 红；点击任意单词弹出气泡，显示国际音标 `/θɪŋk/`、发音动作提示，以及 **`[▶ 听我的原声]`** 和 **`[▶ 听标准音]`** 对比按钮。
- **底部固定连麦状态栏（Live Voice Dock）**：
  - 居中动态声波状态球：自动流转 **`考官正在说...`** → **`正在听你说（说完自动接话）`** → **`思考与批改中...`**。
  - 快捷微操作：`[暂停/静音]`、`[重说上一句]`、`[切回手动按键]`（供需要长时间停顿思考时使用）。

### 6.2 课后学习报告视图 (`LessonReportView`)
- 四维雷达图 / 分数卡片（Overall / FC / LR / GRA / PR）+ 与最近 5 次平均分的升降箭头。
- 可一键复制/下载的 `.md` 完整学习报告（含语法错题账本、Top 发音弱点词、下节课 3 个练习处方），并可从“往期课程”抽屉随时回看历史报告。

---

## 7. Phase 3：DeepSeek Harness (`dsh`) 原生插件适配

在 Phase 1 与 Phase 2 跑通后，利用 `dsh` 的 **Cordis** 插件体系和自带的 **Creator Mode**：
1. 在 `dsh_plugin/` 中创建 Cordis Bundle（在 `package.json` 中声明 `"dsh"` 字段，配合 `cordis.patch.yml`）。
2. 在 `dsh web`（默认 `http://127.0.0.1:3080`）的侧边或新标签页中直接内嵌 `http://127.0.0.1:8765` 的伴生交互视图，实现不跳出 `dsh` 界面的无缝体验。
3. 同时将 `skills/ielts-speaking-coach/SKILL.md` 注册到 `~/.dsh/skills/ielts-speaking-coach/SKILL.md`（以及 `~/.agents/skills/`），使所有新建任务都能直接唤醒雅思教练。
