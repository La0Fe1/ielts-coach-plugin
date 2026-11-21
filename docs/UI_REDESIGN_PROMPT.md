# 任务：重做「IELTS 口语教练」的前端界面（设计 + 可直接运行的代码）

> 把下面**整份**内容发给豆包。它不需要看任何旧代码也能产出；如果允许它读仓库，请把 `web_src/` 一并给它参考。

---

## 0. 你的角色与交付标准

你是**资深产品设计师 + 前端工程师**，要为本地雅思口语陪练插件重做界面。
**评判标准只有一句**：打开界面时，用户应该感觉"旁边坐着一个老师，正在听我说英语"，而不是"我在用一个后台管理面板"。

交付三样东西，缺一不可：

1. **design.md** — 信息架构、状态表、组件树、关键交互流程
2. **可运行的 React + TypeScript 代码**（+ 纯 CSS），按第 9 节的文件清单输出
3. **自检清单** — 逐条对照第 11 节，打勾并说明怎么满足的

---

## 1. 产品是什么（理解背景，别做成通用聊天）

- 一个**本地插件**：用户在 dsh / Cursor / Claude Code 里说"开始练雅思 Part 1"，本地守护进程（`127.0.0.1:8765`）负责出题、录音、语音识别、发音评分、语音播报、长期记忆。
- 用户是**备考雅思的中国学生**，一个人对着电脑练口语，通常在自习室/深夜，安静环境。
- 两个使用阵地，**同一套界面必须都成立**：
  - **dsh 右侧边栏 iframe**：宽 380–600px，高约 700–900px（主要场景）
  - **独立浏览器全屏**：1440–1920px 宽
- 一节课的节奏：考官用英文出题 → 学生说话 → 说完自动断句 → 2 秒内出**中文纠错卡**和**单词发音红黄绿** → 考官说下一题 → …… → 结束生成四维报告。

---

## 2. 现有界面的 8 个具体问题（你要解决的就是这些）

1. **没有"人"的存在感**：只有气泡和一个脉冲圆球，像个语音输入工具。
2. **层级混乱**：对话气泡、纠错卡、计划条、参数 chip 视觉权重接近，眼睛不知道该看哪里。
3. **颜色滥用**：红黄绿 + 紫 + 蓝 + 琥珀同时出现，chip 标签满天飞。
4. **底部 Dock 像工具条**：一排 5–6 个按钮，主次不分。
5. **空态/等待态/错误态敷衍**：基本是灰字，麦克风被拒时用户不知道怎么修。
6. **排版没有系统**：字号、行高、间距随手写，长句阅读疲劳。
7. **动效廉价**：缩放脉冲、无意义上浮，长时间使用会烦。
8. **只有深色**：对比度不足，没有浅色主题，不符合"白天练口语"的场景。

---

## 3. 硬约束（**不许改**，改了就不适配后端）

- 技术栈：**React 18 + TypeScript + Vite**，样式用**纯 CSS**（可用 CSS 变量）。
  **不要**引入 Tailwind、AntD、MUI、headless UI、任何 CDN、任何在线字体。
- 构建：Vite 输出到 `../daemon/static`（已有配置），资源用相对路径。
- 录音：**必须沿用 Web Audio API 采集**（AudioWorklet → 16000Hz 单声道 16bit PCM WAV）+ 服务端 VAD 自动断句。
  **禁止**换成 MediaRecorder（会产生 webm/mp4，后端不收）。
- 运行环境：可能跑在 **iframe 内**（不能假设能访问 `window.top`），**离线可用**（除本地 daemon），移动端 Safari 也能用。
- 第 8 节列出的**接口与字段一个都不能少**，也不要凭空发明后端能力。
---

## 4. 必须覆盖的状态机（每个状态都要有明确的视觉表达）

| 状态 | 含义 | 用户应看到 |
| :--- | :--- | :--- |
| `gate` | 还没开麦 | 一张"开始语音连麦上课"的卡，说明点一次同时授权麦克风与播放 |
| `idle` | 等考官出题 / 轮到你说但还没开麦 | 温和的等待提示，不转圈 |
| `examiner_speaking` | 考官正在说 | 明确的"正在说话"信号（声波/呼吸），文本同步显示 |
| `listening` | 正在收音 | 声波活跃 + 计时 + 一句"说完自动接话" |
| `submitting` | 上传+识别 | 极短过渡（<1s），不要闪白 |
| `thinking` | 等智能体批改 | 你的话已经上屏，下方显示"批改中" |
| `ended` | 本课结束 | 报告入口 + 重开新局 |
| Part2 `prep` / `speak` | 1 分钟准备 / 2 分钟作答 | 倒计时进度环 + 「立即开讲」 |
| `stuck` | 卡壳提示 | 气泡下出现候选词 chip |
| 错误 | 麦克风被拒 / 网络失败 / 音频格式错 | 可操作的修复指引，不是错误码 |

---

## 5. 信息架构（建议，允许你优化但要有理由）

- **主区 = 单列对话流**，居中最大宽度 720–820px：
  - 考官：左对齐，带**人像位**（可放字母头像/圆形插画）、名字、说话态光环
  - 学生：右对齐，气泡里是转写文本，**逐词红黄绿**
  - 纠错：**挂在该学生气泡正下方**的折叠卡，默认一行摘要（亮点 + 修正后句子），点开才看错题/发音/升级句
- **顶部**：极简一行——课程/话题 + 三个轻入口（长期记忆 / 题单 / 报告）
- **底部**：**一条"声音条"**（不是按钮堆）= 状态 + 主操作 + 次要操作收进一个"更多"
- **报告**：全屏覆盖层，四维分数 + 错题账本 + 发音榜 + 下节处方，可下载 .md

---

## 6. 视觉要求（这是重点，请给出具体 token）

- **气质**：安静、专注、有人情味。参考"语言学习 App 的沉浸感 + 播客播放器的克制"，不要参考后台管理、不要 Duolingo 的花哨。
- **色彩**：1 个品牌强调色 + 2 个语义色（好 / 需改进）。**红黄绿只允许出现在单词发音上**，其他地方禁用。
- **层级**：所有视觉元素控制在 3 层（背景 / 内容 / 强调），不要再加第四层边框。
- **排版**：8pt 网格；字号严格 5 级（12 / 13 / 15 / 18 / 24）；行高 1.55；中英文混排要指定字体栈（系统字体即可）。
- **圆角与阴影**：各 2 级，不要每处都不一样。
- **主题**：深色 + 浅色（`prefers-color-scheme`），用 CSS 变量；两套都要能读（对比度 ≥ 4.5:1）。
- **考官存在感**：一个稳定的"人"的视觉锚点（头像）＋呼吸式声波；**不要**用缩放脉冲圆球。
- **动效**：只允许 3 处（气泡出现、声波、卡片展开），150–220ms，ease-out；其余一律不动。

---

## 7. 关键交互细节（必须实现）

1. **一键连麦**：首屏只有一张卡，点击同时解锁麦克风与音频播放；之后整节课不再需要点按钮。
2. **自动接话**：考官播完自动开麦；手动模式可切换（底部"更多"里）。
3. **说完自动提交**：VAD 检测停顿 1.8s 自动结束；也允许"我说完了"手动提交。
4. **卡壳提示**：停顿 2.5s 时给出"好像卡住了"的柔和提示 + 2–3 个候选词，**点词直接播放示范音**。
5. **单词发音**：点击彩色单词 → 底部抽屉：音标、逐音素分数、问题（如 θ→s）、「听我的原声」vs「听标准示范」。
6. **Part 2**：收到题卡自动进 1 分钟准备（可「立即开讲」跳过）→ 开口后自动切 2 分钟作答，计时用进度环。
7. **结束本课**：二次确认 → "报告生成中"占位 → 报告到达后自动切换（不弹窗打断）。
8. **空态/错误态**：麦克风被拒时，直接告诉用户去地址栏改权限、或页面在 iframe 里需要新标签页打开。
---

## 8. 数据契约（必须按此对接，字段名不能改）

**首屏**
`GET /api/sessions/{id}/bootstrap` →
`{ session:{id,topic_title,part_mode,feedback_style,status}, state:{status,current_part,examiner_text,examiner_audio_url}, turns:[Turn], profile:{accent_preference,target_band}, context:LearnerContext, report:LessonReport|null, plan:LessonPlan|null }`

**对话查询 / 操作**
- `GET /api/sessions/{id}/turns` → `{turns:[Turn]}`
- `POST /api/sessions/{id}/audio`（multipart `file`，16k WAV）→ `{transcript, wpm, pauses:[{after_word,duration_sec}], pronunciation, stuck, turn_id}`
- `POST /api/sessions/{id}/recording_start` / `recording_cancel`
- `POST /api/sessions/{id}/end`
- `GET /api/learner/context`、`GET /api/sessions/{id}/report`、`GET /api/sessions?limit=20`
- `GET /api/tts/word?text=&accent=` → `{url}`（示范音）

**Turn（一轮）**
`{ id, turn_index, part, examiner_question, examiner_audio_url, learner_transcript, learner_audio_url, learner_duration_sec, wpm, pause_count, long_pauses_json:{pauses:[], stuck:{detected,longest_pause_sec,at_word,hint_words[]}}, grammar_feedback_json:{quick_praise,corrected_text,upgraded_text,grammar_mistakes:[{error_category,original_excerpt,corrected_excerpt,upgraded_excerpt,explanation}],pronunciation_tips}, pronunciation_json:{overall_score, words:[{word,score,color,ipa,start_sec,end_sec,issues:[{phoneme,likely_pronounced_as,gop_score}]}], weak_phonemes:[{phoneme,avg_score,count}]} }`

**LessonPlan**
`{ topic:{title_zh,title,tags[]}, questions:[{part,text,kind}], review:{grammar_patterns[],weak_phonemes[],revisit_questions[],story_to_polish}, focus[], is_first_lesson, rationale }`

**两个 WebSocket**
- `/ws/{sessionId}`：事件 `hello / state / examiner_turn / turn_ready / feedback / lesson_ended / report / ping`
- `/ws/live/{sessionId}`：发 32ms int16 二进制帧；收 `{type:'vad', speech, trailing_silence, should_stop, stop_reason, stuck}`
---

## 9. 交付的文件清单（照此输出）

```
web_src/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api.ts
    ├── types.ts
    ├── styles/
    │   ├── tokens.css
    │   └── app.css
    ├── audio/
    │   ├── pcmRecorder.ts
    │   └── liveSession.ts
    └── components/
        ├── StartGate.tsx
        ├── ExaminerBubble.tsx
        ├── LearnerBubble.tsx
        ├── CorrectionCard.tsx
        ├── PlanBar.tsx
        ├── VoiceDock.tsx
        ├── Part2Timer.tsx
        ├── PhonemeDrawer.tsx
        ├── HistoryDrawer.tsx
        ├── MemoryDrawer.tsx
        └── LessonReportView.tsx
```

---

## 10. 反模式（明确不要做）

- 不要仪表盘/表格/设置面板的观感
- 不要一屏 4 个以上并列按钮，不要把按钮堆成工具栏
- 不要用 emoji 当图标（最多允许 1 处）
- 不要渐变滥用、发光边框、霓虹色、玻璃拟态
- 不要每句话都套一个 chip 标签
- 不要第三方 UI 库 / 图标库 / 在线字体
- 不要为了好看砍掉第 8 节的字段或第 4 节的状态

---

## 11. 验收自检（你必须逐条自评）

- [ ] 380px 宽侧栏里不横向滚动、不出现按钮换行错乱
- [ ] 深色与浅色主题都可读（正文对比度 ≥ 4.5:1）
- [ ] 5 个主状态（gate / listening / thinking / examiner_speaking / ended）一眼能区分
- [ ] 单屏内同时可看到：考官问题、我的回答、纠错要点、当前状态
- [ ] 点击任意彩色单词，2 步内能听到"我的原声"与"标准示范"对比
- [ ] 卡壳时出现候选词，点词能发音
- [ ] Part 2 准备/作答切换不丢计时
- [ ] 除本地 daemon 外无任何外部网络请求
- [ ] 空格键可开始/停止录音
- [ ] 首次进入 gate 状态，不点按钮不发任何麦克风请求

---

## 12. 输出格式要求

先给 **design.md 全文**（含组件树与状态表），再按第 9 节顺序给**每个文件的完整代码**（不要省略成 "…"），最后给**自检清单勾选结果**。
代码必须能 `npm i` 与 `npm run build` 直接通过，TypeScript strict 无报错。
