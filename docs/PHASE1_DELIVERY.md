# Phase 1 交付说明（给 Gemini / 设计方的复核文档）

> 本文档由开发侧（DeepSeek Harness 主程）在完成 **Phase 1** 后编写，用于交接给设计方复核。
> 阅读者假定**没有**本次对话上下文；所有结论都附可复现的命令或文件位置。
> 交付范围：**仅 Phase 1**。Phase 2（GOP 音素纠音）与 Phase 3（dsh Cordis 插件）**未实现**，按 BUILD_PLAN 要求等待 Phase 1 验收通过。

---

## 0. 一句话结论

Phase 1 的 MVP 通路已在本机（Windows 10 + RTX 4070 SUPER）**真实跑通**：
本地 Whisper 转写 → 流利度指标 → 你的 LLM 出纠错 → Kokoro 播报 → SQLite 记忆 → 课后报告落盘。
22 个自动化测试全绿，MCP Server 已被 dsh 成功加载（10 个工具可调用），伴生面板已构建并渲染正常。

**唯一没有做真人验证的环节**：真人对着麦克风说话。我用 Kokoro 合成"学习者回答"的 16kHz WAV 走真实上传接口，验证了 ASR→状态机→纠错入库→报告全链路，但麦克风采集与听感需要你亲自试。

---

## 1. 交付物清单

工作目录：E:\雅思口语插件开发（原始蓝图文件已整体复制进来，未改动）

```text
ielts-coach-plugin/
├── pyproject.toml                 1.2 KB  依赖 + CLI 入口 (ielts-daemon / ielts-mcp)
├── IMPLEMENTATION.md             10.2 KB  Phase 1 实现说明（含踩坑记录）
├── docs/
│   ├── PHASE1_DELIVERY.md               ← 本文档
│   └── ui-screenshot.png           165 KB  伴生面板实拍（无头 Edge 截图）
├── daemon/                               核心守护进程（FastAPI，127.0.0.1:8765）
│   ├── config.py                 16.6 KB  路径/端口/硬件探测/espeak 自检/HF 镜像/ASCII TEMP
│   ├── db.py                     23.4 KB  7 张表 CRUD + 长期记忆聚合 + 报告
│   ├── main.py                   31.3 KB  REST + WebSocket + 静态面板托管
│   ├── state_machine.py          11.9 KB  会话状态机 + 40s 安全长轮询
│   ├── audio/processor.py        13.1 KB  16k WAV 校验/重采样/能量 VAD/静音裁剪
│   ├── audio/asr.py              12.3 KB  Faster-Whisper 常驻 + 流利度(WPM/停顿/虚词)
│   ├── audio/tts.py               8.9 KB  Kokoro-82M 常驻 + 文本哈希缓存
│   └── static/                           web_src 构建产物（index.html + assets）
├── mcp_bridge/server.py          16.9 KB  MCP stdio 桥：10 个工具 + daemon 自动拉起
├── web_src/                              React 18 + Vite 5 + TS（源码）
│   └── src/{App.tsx, api.ts, types.ts, styles.css,
│            audio/pcmRecorder.ts, components/{ExaminerPanel,TurnCard,MemorySidebar,LessonReportView}.tsx}
├── tests/                                22 个测试（见第 9 节）
├── scripts/
│   ├── install.py                 8.9 KB  一键注册 MCP + Skill（dsh/Claude/Cursor）
│   ├── selftest_audio.py          1.9 KB  Kokoro→WAV→Whisper 往返自检
│   ├── e2e_real.py                6.9 KB  真模型端到端（自启 8799 端口 daemon）
│   ├── bench_tts.py               1.1 KB  Kokoro cuda/cpu 基准
│   └── smoke_mcp_stdio.py         2.6 KB  用 MCP 官方 client 走 stdio 握手
└── database/schema.sql            6.4 KB  原样使用，未改动
```

规模：Python 约 **4,228 行**，前端（ts/tsx/css）约 **2,313 行**。

---

## 2. 验收结果（对照 BUILD_PLAN → Phase 1 验收标准）

| BUILD_PLAN 验收项 | 结果 | 证据 |
| :--- | :--- | :--- |
| pytest tests/test_db.py tests/test_asr_fluency.py tests/test_mcp_e2e.py 全通过 | ✅ | 22 passed（8 + 9 + 5） |
| dsh 安装 MCP Server 与 SKILL.md 后，单开任务说"开始练雅思 Part 1"自动拉起 8765 | ✅ | dsh 已加载 ielts-coach，10 个 mcp__ielts-coach__* 工具可见；daemon_status 返回 ok:true |
| 浏览器完成 ≥3 轮语音对话，每轮 3~5 秒内出右侧纠错卡片 + 听到下一题 | ✅ 机械链路 | ASR 0.66–0.88s + TTS 0.11–0.14s；纠错卡片在 WS 上先于 TTS 推送。**真人麦克风未测** |
| 点"结束本课"生成并保存 .md 报告；新开任务能回忆上次事实/错题 | ✅ | ~/.ielts-coach/reports/20261120-123426-s1-Hometown.md 已生成；get_learner_context 返回 has_history:true |

---

## 3. 本机环境与适配（重要：跨机复现要看这节）

| 项目 | 实测 |
| :--- | :--- |
| OS | Windows 10 Pro 19045 (AMD64) |
| GPU | NVIDIA RTX 4070 SUPER 12 GB / 驱动 595.97 / CUDA 12.6 |
| Python | 3.12.10（独立 venv .venv，未污染系统 conda） |
| Node | v24.19.0 / npm 11.17.0 |
| espeak-ng | 1.52.0（winget 安装） |
| 关键包 | torch 2.9.1+cu126、torchaudio 2.9.1+cu126、faster-whisper 1.2.1、ctranslate2 4.9.0、kokoro 0.9.4、spacy 3.8.18、en-core-web-sm 3.8.0、mcp 2.3.0、fastapi 0.165.0、uvicorn 0.54.0、numpy 2.5.5、soundfile 0.14.0、httpx 0.28.1、pytest 9.2.0 |
| 模型体积 | Whisper large-v3-turbo 1.55 GB 常驻 ~/.ielts-coach/models/；Kokoro-82M 约 330 MB 在 HF 缓存 |
| ffmpeg | **未安装且不需要**（全程 16kHz PCM WAV） |

适配中必须记录的 6 个坑（代码里都已固化，换机同样生效）：

1. **PyPI 的 Windows torch 是 CPU 版** → 改从阿里云 pytorch-wheels 镜像装 torch-2.9.1+cu126，cuda.is_available() 为 True。
2. **中文用户名让 PyTorch 抛 UnicodeDecodeError**：torch 在 %TEMP%\torch\kernels 建缓存失败时打印含 GBK 中文路径的警告，pybind11 按 UTF-8 解码失败，异常错落在无关的 torch.abs() 上。→ config.ensure_ascii_tempdir() 在加载模型前把 TEMP/TMP 指向纯 ASCII 目录。
3. **Kokoro 英文 G2P 强依赖 spaCy 模型**：misaki.en.G2P 会调 spacy.cli.download('en_core_web_sm')，该命令依赖 raw.githubusercontent.com。→ 预装 en-core-web-sm-3.8.0 wheel；缺失时 TTS 抛带安装命令的明确错误。
4. **faster-whisper 与新版 PyAV 不兼容**：av.open(..., metadata_errors=...) 已被移除。→ ASR 用标准库 wave 读 16k WAV 后直接传 numpy 数组给 Whisper，**彻底绕开 PyAV/ffmpeg**。
5. **huggingface.co 不可直连** → daemon 启动探测连通性，失败自动设 HF_ENDPOINT=https://hf-mirror.com。
6. **MCP SDK 2.x 把 FastMCP 改名 MCPServer** → mcp_bridge/server.py 同时兼容 mcp.server.mcpserver.MCPServer(2.x) 与 mcp.server.fastmcp.FastMCP(1.x)。

---

## 4. 与 DESIGN_SPEC 的差异（请重点复核）

> 下面每一条都是"设计文档没写死 / 现场只能这样做"的地方，列出替代方案供你决策。

| # | 设计文档说法 | 实际实现 | 原因 / 建议 |
| :--- | :--- | :--- | :--- |
| D1 | §5 标题写"7 个核心工具"，表格列了 **8** 个 | 实现 8 个 + 2 个附加（end_lesson、daemon_status），**共 10 个** | 数字自相矛盾；附加两个工具是 agent 停课/排障必需。**建议**：在 SKILL.md 补一句这两个工具的用法（我未改 SKILL，保持原样交付） |
| D2 | 语音活动检测用 silero-vad | 用**能量阈值 VAD**（20ms 帧 RMS + 自适应阈值 + 0.25s 静音切分） | Phase 1 无额外模型依赖即可测、可复现；Silero 建议 Phase 2 作为可选项增强，不作强依赖 |
| D3 | pronunciation 字段（Phase 1） | 明确返回 null + pronunciation_note 说明 | 遵循 SKILL.md「never hallucinate pronunciation data」；报告里 PR 标 N/A (Phase 1) |
| D4 | CUDA 默认 large-v3-turbo | 实际模型仓库 mobiuslabsgmbh/faster-whisper-large-v3-turbo（faster-whisper 1.2.1 无内置别名），并带 medium.en → small.en → base.en 三级回退 | 别名不存在会直接加载失败；回退保证小显存/离线也能跑 |
| D5 | §3.2 audio/processor.py 负责"VAD 切分" | 额外提供 trim_bounds/trim_silence/speech_segments/process_upload，并在上传时做**峰值归一化（最大 8 倍增益）** | 实测手机/耳麦电平差异大，不归一化会让 Whisper 漏词 |
| D6 | §3.2 daemon/audio/pronunciation.py | **未创建**（Phase 2 专属） | 避免空壳文件误导；Phase 2 接入点见第 11 节 |
| D7 | MCP 工具"单次阻塞 ≤40s" | 服务端二次截断：min(请求值, IELTS_COACH_MAX_WAIT=40)，MCP 侧再截一次 | 双保险，防止 agent 传 300s 导致客户端超时 |
| D8 | 状态集 waiting_for_learner / recording_in_progress / learner_replied / lesson_ended_by_user | 内部多出 idle、processing 两态，对外**映射**为 waiting_for_learner / recording_in_progress | processing（ASR 中）对外报 recording_in_progress，语义仍是"继续等"，不破坏 SKILL 的续等逻辑 |
| D9 | Phase 3 才提 dsh 插件 | Phase 1 的注册走的是**现有 dsh MCP 插件机制**：往 ~/.dsh/profiles/{desktop,web}/cordis.patch.yml 追加 @deepseek-ai/dsh-mcp-client 条目（与机器上已装的 sysplorer MCP 同构），不是 mcp.json | 本机 dsh 是 Cordis/YAML 配置体系；已实测被 dsh 热加载成功 |
| D10 | 报告"导出到 ~/.ielts-coach/reports/" | 文件名 YYYYmmdd-HHMMSS-s<session_id>-<slug>.md，并在 DB lesson_reports 存 markdown + json + 路径 | 便于按时间排序与去重 |
| D11 | feedback_style 两种模式 | 只落库到 learner_profile/sessions，**口头纠错与否由 SKILL 决定**（agent 遵守约定） | Phase 1 不在 daemon 层强制改写文本；**建议**：若要强约束，可在 respond_with_feedback_and_wait 里按模式裁剪 examiner_text 中的纠错句（需你确认是否值得） |

---

## 5. MCP 工具契约（实际签名，10 个）

核心 8 个（对应 DESIGN_SPEC §5）：

| 工具 | 参数 | 返回要点 |
| :--- | :--- | :--- |
| get_learner_context | — | profile / top_grammar_weaknesses(5) / top_weak_phonemes(5) / part2_stories / personal_facts / last_lesson_plan / band_history / has_history |
| start_lesson | part_mode, topic_hint, feedback_style, target_band, open_browser=True, accent | session_id, companion_url, profile, daemon{url,version,device}, next_step |
| respond_with_feedback_and_wait | session_id, examiner_text, part, turn_id_for_feedback, feedback_payload, timeout_sec=40, accent | status + 转写/流利度/发音(Phase1=null) + examiner{audio_url,...} + feedback_saved |
| wait_for_learner_turn | session_id, timeout_sec=40 | 同上，用于超时续等 |
| push_turn_feedback | session_id, feedback_payload, turn_id | 单独推纠错卡片（收尾用） |
| update_learner_memory | memory_items[] (memory_type, memory_key, title, content, mastery_delta) | 写入 memory_notes，重复项 frequency+1、mastery 累加 |
| get_lesson_aggregation | session_id | 轮次明细、WPM 均值、停顿总数、语法分类/模式频次、发音问题、历史 band |
| save_lesson_report | session_id, bands_json{overall,fc,lr,gra,pr}, report_markdown, next_lesson_plan | 写 DB + 导出 .md + WS 推前端切报告视图 |

附加 2 个（我方新增，需你确认是否保留）：

- end_lesson(session_id, reason)：等价于网页红按钮，用于用户口头说"停"。
- daemon_status()：返回 daemon 健康、模型是否加载、伴生 URL，排障用。

### 返回状态语义（SKILL.md 的续等逻辑依赖它）

```text
learner_replied        学习者已回答 → 读 transcript / wpm / pauses 出纠错
waiting_for_learner    还没开始录音 → 静默续等（不要输出聊天内容）
recording_in_progress  正在录音 / 正在 ASR → 静默续等
lesson_ended_by_user   用户结束 → 出报告
```

---

## 6. 每轮数据流（为什么只花 1 次 LLM 推理 + 1 次 MCP 调用）

```text
Agent(LLM)                MCP Bridge                 Daemon                      Browser
   |                          |                        |                            |
   |-- respond_with_feedback_and_wait(examiner_text, feedback_payload) --------->|
   |                          |-- POST /examiner_turn->| ①存上一轮纠错(DB)          |
   |                          |                        | ②WS 推 feedback 卡片 ----->| 右侧卡片(先到)
   |                          |                        | ③Kokoro 合成 24k WAV ----->| 自动播放
   |                          |                        | ④状态=waiting_for_learner  |
   |                          |-- GET /wait (≤40s) --->|                            |
   |                          |                        |<-- POST /audio (16k WAV) --| 学习者录音
   |                          |                        | ⑤Whisper 转写+流利度       |
   |                          |<-- learner_replied ----| ⑥状态=learner_replied      |
   |<-- transcript/wpm/pauses-|                        |                            |
```

关键顺序：**纠错卡片(②)先于 TTS(③)推送**，所以视觉反馈不受语音合成耗时影响。

---

## 7. HTTP / WebSocket 接口（前端与 MCP 共用）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | /health | 健康 + 模型状态 + DB 统计 |
| GET | /api/doctor | 环境自检（硬件/包版本/espeak/uv/node） |
| POST | /api/sessions | 建课程（返回 companion_url） |
| GET | /api/sessions/{id}/bootstrap | 面板首屏（session/state/turns/profile/context/report） |
| POST | /api/sessions/{id}/examiner_turn | MCP 调用：存纠错+建新轮+TTS+进入等待 |
| GET | /api/internal/sessions/{id}/wait?timeout_sec= | MCP 长轮询（服务端截断 ≤40s） |
| POST | /api/sessions/{id}/recording_start 与 recording_cancel | 录音状态机 |
| POST | /api/sessions/{id}/audio | 上传 16k WAV（multipart 或裸 body），同步返回转写结果 |
| POST | /api/sessions/{id}/feedback | 单独推卡片 |
| POST | /api/sessions/{id}/end | 结束课程，释放所有等待 |
| POST/GET | /api/sessions/{id}/report | 保存 / 读取报告 |
| GET | /api/tts/word?text=&accent= 与 /api/tts/say?text=&accent= | 单词 / 整句示范音（带磁盘缓存） |
| WS | /ws/{session_id} | 事件：hello/state/examiner_turn/turn_ready/feedback/lesson_ended/report/ping |

---

## 8. 数据库使用情况（schema.sql 未改动）

7 张表全部用上（Phase 1 部分字段留待 Phase 2）：

- learner_profile：目标分、口音、反馈模式（面板可切，PATCH /api/profile）
- sessions：开课时插入；save_lesson_report 时写 status=completed、四维 band、ended_at
- turns：每轮考官问题 + 学习者音频路径/转写/WPM/停顿 JSON/纠错文本/grammar_feedback_json
- grammar_mistakes：每条纠错按 error_pattern 归一化入库，用于"顽疾榜"
- pronunciation_issues：**表已建、Phase 1 不写入**（Phase 2 填）
- memory_notes：weakness_grammar / weakness_phoneme / personal_fact / part2_story / next_lesson_plan，UNIQUE(memory_type,memory_key) + frequency/mastery
- lesson_reports：markdown + json + 文件路径，session_id UNIQUE

---

## 9. 测试清单（22 个，全绿）

命令：python -m pytest tests -q（在项目根、激活 .venv 后）

tests/test_db.py（8）
test_schema_is_created_idempotently / test_default_profile / test_session_and_turn_lifecycle /
test_grammar_mistakes_are_tracked_by_pattern / test_memory_notes_upsert_increments_frequency /
test_learner_context_aggregates_everything / test_lesson_aggregation_and_report / test_database_survives_new_instance

tests/test_asr_fluency.py（9）
test_compute_fluency_basic_metrics / test_compute_fluency_counts_filler_words /
test_compute_fluency_handles_empty_and_silent_input / test_wav_bytes_roundtrip /
test_rejects_non_wav_containers / test_resample_changes_sample_count_not_pitch_identity /
test_trim_and_segments_find_speech_region / test_process_upload_normalises_and_persists /
test_asr_service_stub_produces_fluency_payload

tests/test_mcp_e2e.py（5，起真实 uvicorn + 走 MCP Bridge 函数）
test_health_and_context / test_full_lesson_roundtrip_with_report /
test_learner_can_end_lesson_and_waiter_unblocks / test_audio_validation_rejects_webm /
test_static_companion_ui_is_served

端到端测试用 IELTS_COACH_STUB_MODELS=1 的确定性假模型（ASR 固定文本、TTS 提示音），因此**不需要下载 1.5 GB 权重也能在 CI 跑**。

---

## 10. 实测性能（RTX 4070 SUPER，均为真模型）

| 环节 | 实测 | 备注 |
| :--- | :--- | :--- |
| daemon 启动 | 2.5 s | 模型后台预热，HTTP 立即可用 |
| ASR（large-v3-turbo fp16） | **0.66 / 0.69 / 0.88 s** | 同一段 17.77 s、54 词音频重复 3 次 |
| TTS（Kokoro-82M） | **0.11 / 0.13 / 0.14 s** | 2.9 / 3.9 / 6.0 s 音频，预热后 |
| 冷启动（仅首次） | 7~10 s | 之后常驻，不重复加载 |
| 模型显存占用 | 约 2 GB | 与 Windows 桌面共存无压力 |

一轮对话端到端 ≈ ASR 0.7s + 你的 LLM 推理 + TTS 0.15s。

---

## 11. Phase 2 接入点（给下一阶段开发直接照做）

| 需要做的事 | 落到哪个文件/表 |
| :--- | :--- |
| 新建 PronunciationService，入口建议 score(wav_path: str, transcript: str, words: list[dict]) -> dict，输出结构照 DESIGN_SPEC §4.3 的 JSON | daemon/audio/pronunciation.py（新建） |
| 与 ASR 并行执行后写回 | daemon/main.py 的 upload_audio：现在 asr_result = await loop.run_in_executor(...)，改成 asyncio.gather(asr, pron) |
| 落库 | turns.pronunciation_json、turns.pronunciation_score、pronunciation_issues（表与索引已就绪） |
| 透传给 agent | daemon/main.py 里 payload["pronunciation"] 现在是 None，直接替换即可；MCP 层无需改动 |
| 前端热力标色 + 音标气泡 + 原声/示范对比 | web_src/src/components/TurnCard.tsx（已有原句/纠错/升级三栏），新建 PhonemeDrawer.tsx |
| 单词示范音 | GET /api/tts/word?text=&accent= **已实现**，Phase 2 直接复用 |
| 单词原声截取 | pronunciation_json 里带 audio_start_sec/audio_end_sec，前端用 AudioBuffer.slice 截取，或用已存的 learner_audio_url |
| PR 维度评分 | 报告模板第 4 节；bands_json.pr 现在传 null，Phase 2 传真实分 |

写完后建议回归：pytest tests 必须仍全绿（Phase 2 新增 tests/test_gop_pronunciation.py）。

---

## 12. 复现 / 使用命令

```powershell
cd E:\雅思口语插件开发

# 1) 跑测试（无需模型权重）
.\.venv\Scripts\python.exe -m pytest tests -q

# 2) 环境自检（硬件/端口/espeak/包版本）
.\.venv\Scripts\python.exe -m daemon.main --doctor

# 3) 真模型音频往返自检（TTS→WAV→ASR 词重合率）
.\.venv\Scripts\python.exe scripts\selftest_audio.py

# 4) 真模型端到端（自起 8799 端口，跑完整一轮并出报告）
.\.venv\Scripts\python.exe scripts\e2e_real.py

# 5) 启动守护进程（正常不需要，MCP 会自动拉起）
.\.venv\Scripts\python.exe -m daemon.main

# 6) 重新注册 MCP + Skill（幂等，会先备份 cordis.patch.yml）
.\.venv\Scripts\python.exe scripts\install.py

# 7) 前端改完后重新构建到 daemon/static
npm --prefix web_src install
npm --prefix web_src run build
```

伴生面板：http://127.0.0.1:8765/?session=<id>；数据目录 ~/.ielts-coach/。

---

## 13. 需要你决策的遗留问题（Open Questions）

1. **D1**：附加的 end_lesson / daemon_status 是否保留？若保留，是否要我补进 SKILL.md（我目前原样交付未改）。
2. **D11**：instant_card_only 模式是否要在 daemon 层强制剥离 examiner_text 里的纠错句？现在完全靠 agent 自觉。
3. **D2**：Phase 2 是否必须引入 Silero VAD，还是能量阈值 VAD 已够用（现在误切率低，且有手动模式兜底）。
4. **Part 2 计时器**：现在收到 Part 2 题目自动开始 1 分钟准备倒计时并可切换 2 分钟作答，是否需要改成"录音一按就自动进入 2 分钟计时"。
5. **多用户/多课程并发**：现在 daemon 支持多 session 并存，但面板一次只跟一个 ?session=；是否需要课程列表页。
6. **开机自启**：daemon 目前由 MCP 首次调用拉起（空闲常驻）。是否需要注册 Windows 计划任务/服务，避免用户第一次说话前等 7~10 秒预热。

---

## 14. 声明

- 未篡改 README.md / DESIGN_SPEC.md / BUILD_PLAN.md / database/schema.sql / skills 下 SKILL.md，全部原样。
- Phase 1 中所有"发音"结论均为 null 或纯节奏/WPM 分析，**没有伪造任何音素级数据**。
- 本机为真实运行环境，上述性能数字来自实际测量（脚本可复现），非估算。
