# IELTS 口语教练前端重设计

版本：2.0.0  
技术栈：React 18 + TypeScript strict + Vite 5 + 纯 CSS  
运行边界：dsh 右侧栏 iframe（380–600px）与独立浏览器全屏；仅访问本地 daemon，不依赖 CDN、在线字体或第三方 UI 库。

## 1. 设计结论：单列课堂，而不是后台面板

界面以“考官说一句、学生答一段、老师就地纠错”为主线。考官、学生、纠错卡和语音操作共享同一条纵向阅读轴，学生不需要在多个面板之间寻找当前任务。

- 考官内容固定在每轮开头，使用 Elena 身份、英文问题和重听入口。
- 学生回答靠右，保留原始转写的空格、标点及未评分句尾；发音分数只给单词着色。
- 中文纠错卡紧跟对应回答，默认只展示最重要的一句纠错，详细内容按需展开。
- 底部 VoiceDock 始终回答三个问题：现在发生什么、我唯一能做什么、其他操作在哪里。
- 顶部只保留“记忆 / 题单 / 报告”三个轻入口，其余能力进入抽屉，不与课堂争夺注意力。
- 红色、黄色、绿色仅用于发音单词；普通错误不使用红色错误码，而提供可执行的修复步骤。

这种结构同时适合窄侧栏和宽屏：窄屏自然形成单列，宽屏只把阅读列限制在 760px，不把课堂拉成稀疏的多列仪表盘。

## 2. 信息架构

### 2.1 首屏 Gate

1. 一张开课卡：考官、课程标题、隐私说明。
2. 主操作“开始语音连麦上课”：同一次用户手势内解锁麦克风与音频播放。
3. 次入口“查看往期课程与报告”：只浏览历史，不请求麦克风。
4. 失败时就地显示权限、iframe、新标签页、本地 daemon 或 WAV 格式修复建议。

正常入口在没有点击主操作前不会调用 `getUserMedia`。`?preview=1` 仅用于开发验收时跳过 Gate，不注入生产假数据。

### 2.2 课堂页

- 顶栏：Elena 身份、当前 Part、记忆、题单、报告。
- 课堂流：Part 2 计时器、考官气泡、学生气泡、纠错卡、卡壳提示、识别/批改过场、错误指引。
- 底部 Dock：状态文案、波形、录音计时、唯一主操作、“更多”。
- 覆盖层：发音底部抽屉、记忆/题单/历史侧抽屉、报告视图。

### 2.3 “更多”菜单

只收纳“自动接话 / 暂停麦克风 / 重听考官问题 / 结束本课”。结束本课必须二次确认，避免误触。

## 3. 组件树

```text
App
├── StartGate
│   └── HistoryDrawer
├── Topbar（App 内的轻量导航）
├── Part2Timer
├── ChatStream
│   ├── ExaminerBubble
│   │   └── VoiceWave
│   ├── LearnerBubble
│   ├── CorrectionCard
│   ├── StuckPanel（App 内的候选词区）
│   ├── PendingLearner（App 内的识别/批改过场）
│   └── ErrorGuide（App 内的错误修复卡）
├── VoiceDock
│   ├── VoiceWave
│   └── MoreMenu / EndConfirmation
├── PhonemeDrawer
├── HistoryDrawer
├── MemoryDrawer
├── PlanBar（题单抽屉）
└── LessonReportView
```

基础模块：

```text
api.ts                 本地 REST、TTS、WAV multipart、课程创建
types.ts               Session / Turn / Plan / Context / Report / VAD / WS 契约
audio/pcmRecorder.ts   AudioWorklet、重采样、16bit WAV、资源清理
audio/liveSession.ts   32ms int16 实时帧、VAD、静音兜底、连续 Part 2 录音
styles/tokens.css      主题、字号、间距、圆角、阴影、动效 token
styles/app.css         布局、组件、响应式、抽屉与状态样式
```

## 4. 完整状态表

| 状态 | 进入条件 | 屏幕表现 | 主操作 / 退出 |
|---|---|---|---|
| `gate` | 初次进入或尚未授权 | 单张开课卡，无课堂噪音 | 一键授权后进入考官播放或 `idle` |
| `idle` | 等待学生开始、手动模式、录音取消 | “轮到你了” | 点击或空格进入 `listening` |
| `examiner_speaking` | 新题或重听开始 | Elena 波形动效、问题、重听 | 播完按模式进入 `listening`；Part 2 进入 `prep` |
| `listening` | 麦克风和实时 VAD 已启动 | 音量波形、计时、“正在听你说” | VAD 停顿、手动提交或空格进入 `submitting` |
| `submitting` | WAV 上传与识别中 | 学生话立即上屏，短过渡 | 收到转写后进入 `thinking`；最长约 650ms 后视觉切到 `thinking` |
| `thinking` | 等待智能体批改 | 回答下方“批改中”，不清空课堂 | `feedback` / `turn_ready` 后刷新纠错卡 |
| `ended` | 二次确认结束或服务端 `lesson_ended` | 报告入口、重开新局 | 查看报告或创建新课程 |
| Part 2 `prep` | 收到 Part 2 题卡并播完 | 60 秒进度环、准备提示、“立即开讲” | 首次开口、跳过或倒计时结束进入 `speak` |
| Part 2 `speak` | 准备结束或学生提前开口 | 120 秒进度环，连续录音 | 倒计时结束或手动提交 |
| `stuck` | 服务端/本地兜底 VAD 发出 `stuck` | 柔和提示和 2–3 个候选词 chip | 点词调用本地 TTS 示范音；恢复说话后收起 |
| 麦克风错误 | 拒绝、无设备、非安全上下文等 | 权限/iframe/新标签页修复步骤 | 修复后重试 |
| 网络错误 | 本地 API 或连接失败 | 检查 `127.0.0.1:8765` daemon 的提示 | daemon 恢复后重试 |
| 音频错误 | 后端拒绝音频或返回 400 | 16kHz / 单声道 / 16bit WAV 提示 | 重新录音 |
| 播放错误 | 浏览器阻止音频播放 | 明确播放解锁/重听建议 | 用户手势内重试 |

`submitting` 的 650ms 仅是视觉过场上限，不是对真实 ASR 或批改耗时“2 秒内完成”的承诺。

## 5. 关键交互流

### 5.1 一键连麦与自动接话

1. 用户点击开课按钮。
2. 在用户手势内请求一次麦克风并释放测试轨道，同时恢复 AudioContext、播放空 buffer 解锁音频。
3. 播放当前考官题；播放结束自动开麦。
4. 普通轮次使用服务端 VAD 的 1.8 秒停顿判定，也始终保留“我说完了”和空格手动提交。
5. 自动接话可在“更多”中切换为手动；暂停麦克风会取消当前录制并通知后端。

### 5.2 录音、VAD 与上传

1. `POST recording_start` 通知 daemon 开始录制。
2. AudioWorklet 输出 Float32，单声道重采样到 16000Hz。
3. 每 512 samples 组成一帧，即 32ms；转为 little-endian int16 后通过 `/ws/live/{sessionId}` 发送。
4. 同时保留 PCM 片段；停止时手写 44 字节 WAV header，封装 16kHz、单声道、16bit PCM。
5. multipart 字段 `file` 上传到 `/api/sessions/{id}/audio`，不使用 MediaRecorder。
6. 取消、录音失败或语音不足会调用 `recording_cancel`；所有轨道、Worklet、WebSocket 和 AudioContext 均清理。

AudioWorklet 不可用时沿用 Web Audio  fallback；实时 VAD 不可用时使用本地 RMS 静音检测兜底。

### 5.3 Part 2

1. 考官题播完即建立 60 秒准备 deadline；自动模式同时开麦监听首次开口。
2. 准备阶段采用连续录音，不因普通停顿提交。
3. 首次 `speech_started`、点击“立即开讲”或准备倒计时结束，都切换到 120 秒作答 deadline。
4. 切换时调用 `markStart()` 丢弃准备阶段静音，重置作答计时；连续录音不会重开或丢失 WebSocket。
5. 作答阶段不会因普通停顿提前结束，120 秒到点或用户手动提交才上传。
6. 连续模式通过现有 `/ws/live` `config` 消息把服务端停顿阈值临时设为 3 秒，使 2.5 秒卡壳事件有机会先于断句出现。

### 5.4 发音与纠错

- 点击任一彩色单词，打开底部发音抽屉，即完成第 1 步。
- 第 2 步可点“听我的原声”或“听标准示范”。没有学生音频 URL 时原声按钮明确禁用，不伪造播放成功。
- 抽屉展示 IPA、逐音素 GOP、可能误读和标准示范。
- 纠错卡默认显示 praise、corrected sentence 与示范音；展开后显示 grammar mistakes、upgraded sentence、pronunciation tips 和 weak phonemes。

### 5.5 报告与重开

1. “更多 → 结束本课 → 确认”调用真实结束接口。
2. 报告区先显示生成中占位，不弹模态框打断课堂。
3. `/ws/{sessionId}` 收到 `report` 后拉取报告并自动更新。
4. 报告展示四维分数、错题账本、发音榜和下节处方，可下载 Markdown。
5. “重开新局”使用仓库已有的 `POST /api/sessions`，继承当前 Part、主题与反馈风格，重新生成计划。

## 6. 数据契约映射

| 契约 | 前端消费者 |
|---|---|
| `GET /api/sessions/{id}/bootstrap` | 首屏 Session、State、Turn、Profile、Context、Report、Plan |
| `GET /api/sessions/{id}/turns` | `turn_ready` / `feedback` 后刷新对话与纠错 |
| `POST /api/sessions/{id}/audio` | transcript、WPM、pauses、pronunciation、stuck、turn_id |
| `recording_start` / `recording_cancel` | 录音生命周期与取消收尾 |
| `POST /api/sessions/{id}/end` | 结束课程与报告流程 |
| `GET /api/learner/context` | 记忆抽屉、长期弱点与处方 |
| `GET /api/sessions/{id}/report` | 报告占位到正式报告 |
| `GET /api/sessions?limit=20` | 历史课程与切换 |
| `GET /api/tts/word`、`GET /api/tts/say` | 单词、候选词和句子示范音 |
| `/ws/{sessionId}` | hello/state/examiner_turn/turn_ready/feedback/lesson_ended/report/ping |
| `/ws/live/{sessionId}` | 32ms int16 上行与 VAD 事件下行 |

`Turn` 中原样保留 `long_pauses_json`、`grammar_feedback_json`、`pronunciation_json` 及其嵌套字段；`LessonPlan` 保留 questions、review、focus、rationale 和首课标记。字段名未改成另一套前端模型。

## 7. 视觉系统

### 7.1 字体与排版

- 系统字体栈：`-apple-system / BlinkMacSystemFont / Segoe UI / PingFang SC / Microsoft YaHei`。
- 五级字号：12 / 13 / 15 / 18 / 24px。
- 正文行高 1.6，长英文与中文均允许安全断词。
- 考官问题 18px，正文 15px，辅助信息 12–13px，页面标题 24px。

### 7.2 色彩

浅色：

- 背景 `#f5f4f0`，表面 `#fcfbf8`，正文 `#242720`，次级文字 `#60665c`。
- 主色 `#4b5f92`，不使用渐变、霓虹或玻璃拟态。
- 发音绿 `#1f6845`、黄 `#76530e`、红 `#9b3737`，只作用于单词与对应分数。

深色通过 `prefers-color-scheme: dark` 切换：

- 背景 `#151713`，表面 `#1d201b`，正文 `#f0f1ec`，次级文字 `#b7bcb1`。
- 深色发音色与回答底色分别调整，不能只把浅色 token 反相。

### 7.3 间距、圆角与层级

- 8pt 基础间距：8 / 16 / 24 / 32px，辅以 4px 微调。
- 两级主圆角：12px 与 20px。
- 两级阴影：普通浮层与底部 Dock；边框优先于厚重阴影。
- 动效仅用于新气泡进入、纠错展开和考官波形，180–200ms；尊重 `prefers-reduced-motion`。

## 8. 响应式与可访问性

- 课堂阅读列最大 760px；380px 下保持单列，不依赖桌面窗口宽度。
- 480px 以下缩小顶栏与 Dock 留白，主操作和“更多”保持单行，按钮不换行。
- Dock 宽度使用 `calc(100% - 16px)`，学生卡和纠错卡保留缩进但不固定像素宽度。
- `embed=1` 只收紧嵌入边距，不访问 `window.top` 的 DOM。
- 所有主要操作使用原生 button；抽屉使用 dialog 语义、关闭按钮和 Escape；纠错展开维护 `aria-expanded`。
- 状态文本使用 `aria-live`，键盘焦点有明显 outline；空格在输入框、抽屉和报告打开时不会劫持。

## 9. 构建与运行

```bash
cd web_src
npm i
npm run build
```

构建命令为 `tsc -b && vite build`，输出到 `../daemon/static`，HTML 与资源均使用 `./assets/...` 相对路径。开发服务器代理和运行时的 REST / WebSocket 地址均指向本地服务，不引入云端 API。
