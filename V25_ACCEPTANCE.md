# IELTS Speaking Studio v2.5 验收说明

日期：2026-11-22  
口径：`通过` 表示已有构建、算法或浏览器证据；`待联机` 表示实现已落地，但当前 daemon 或真实设备链路尚未完成端到端验证。

## 1. 完整代码清单

```text
web_src/
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api.ts
    ├── types.ts
    ├── audio/
    │   ├── pcmRecorder.ts
    │   └── liveSession.ts
    ├── utils/
    │   └── wordDiff.ts
    ├── components/
    │   ├── StartGate.tsx
    │   ├── TopBar.tsx
    │   ├── ExaminerBubble.tsx
    │   ├── LearnerBubble.tsx
    │   ├── ChatStream.tsx
    │   ├── CoachPanel.tsx
    │   ├── Part2Card.tsx
    │   ├── VoiceDock.tsx
    │   ├── PhonemeDrawer.tsx
    │   ├── PlanDrawer.tsx
    │   ├── HistoryDrawer.tsx
    │   ├── MemoryDrawer.tsx
    │   ├── LessonReportView.tsx
    │   └── SettingsDrawer.tsx
    └── styles/
        ├── tokens.css
        └── app.css
```

`CorrectionCard.tsx`、`Part2Timer.tsx`、`PlanBar.tsx`、`SelftestView.tsx`、旧 `audio/mic.ts` 和旧 `styles.css` 已删除，不再保留废弃实现。

## 2. 构建结果

- **通过**：`npm install --no-audit --no-fund`。
- **通过**：最后一次源码修改后执行 `npm run build`，实际运行 `tsc -b && vite build`。
- **通过**：TypeScript strict 无报错，Vite 共转换 50 个模块。
- **通过**：`wordDiff` 独立算法测试中，原句 `go / to` 标为删除，修正句 `visit / the / is` 标为新增。
- **通过**：源码没有 `smartTurn`、0.9 秒探测、`MediaRecorder`、外部字体或 CDN 运行时引用。

最终产物：

```text
daemon/static/index.html
assets/index-B3v3QGQM.css   31.95 kB
assets/index-CXRGbVZF.js   221.35 kB
✓ built in 586ms
```

最终浏览器确认加载 `./assets/index-CXRGbVZF.js`。

## 3. 响应式实测

使用真实 1280px 桌面视口和同源 iframe 触发精确宽度媒体查询，不仅缩放截图。

| 视口 | 实测结果 |
|---|---|
| 380×700 | `innerWidth=380`，滚动条内 client/scrollWidth 均 365；无横向溢出。Dock x=8、宽 348.8px；主按钮 82×42px、单行。Coach 内嵌于回答下方。 |
| 460px | client/scrollWidth 均 445，无横向溢出；主按钮 42px 高，More 36px 高。 |
| 600px | client/scrollWidth 均 585，无横向溢出；主按钮 44px 高，More 40px 高。 |
| 1280×960 | 实际双栏为 742.4 / 537.6px，两栏内容高均 896px，各自独立滚动。 |
| 1440×900 | 双栏为 835.2 / 604.8px，client/scrollWidth 均 1440；两栏内容高均 836px，无横向溢出。 |

## 4. 视觉与主题

深色主题已实际切换并截图检查，`data-theme=dark`、背景 `rgb(18,23,19)`、正文 `rgb(237,242,237)` 生效。浅色、深色与系统跟随均由统一 token 管理。

WCAG 相对亮度计算结果：

| 组合 | 对比度 |
|---|---:|
| 浅色正文 / 背景 | 13.51:1 |
| 浅层次级文字 / 背景 | 5.44:1 |
| 浅色按钮文字 / 主色 | 7.31:1 |
| 浅色绿 / 黄 / 红发音胶囊 | 5.66 / 5.95 / 5.78:1 |
| 深色正文 / 背景 | 16.00:1 |
| 深色次级文字 / 背景 | 9.31:1 |
| 深色按钮文字 / 主色 | 8.85:1 |
| 深色绿 / 黄 / 红发音胶囊 | 7.09 / 6.80 / 6.19:1 |

以上关键组合全部超过 4.5:1。

## 5. 浏览器交互抽查

- **通过**：已有课程 Gate 显示续学入口，点击“自主新开一课”后出现 5 种模式、4 档目标分、2 种口音和 2 种反馈风格。
- **通过**：正常 Gate 未点击按钮时没有出现麦克风授权动作；浏览历史不触发录音。
- **通过**：宽屏右栏直接展示 Diff、升级句、错因、弱音素和跟读按钮；窄栏改为内嵌，次级详情进入 `details`。
- **通过**：Part 2 可见内容为 Topic、4 个要点、4 个便签，Dock 显示“准备中，尚未开麦”；隐藏的同构副本不在可访问树中重复出现。
- **通过**：报告生成 1 个雷达图、1 个 Overall 趋势图和 4 个真实历史点；错题提供原句/示范音入口。
- **通过**：从报告点击低分词会打开发音抽屉，层级高于报告，提供原声、标准示范和跟读重测。
- **通过**：设置抽屉可编辑 Provider / Base URL / Model / Key / 目标分 / 口音 / 语速 / 反馈风格；mock 模型测试的 123ms 延迟能正确展示。
- **通过**：最终轮次编号按后端 1 起始值显示，课堂与报告均为“第 1 轮”。

## 6. 音频与状态机实现核对

- 两档收音已替换三个重叠开关：自由模式自动断句，手动模式只手动发送。
- 自由模式动态阈值为 2.0 / 1.8 / 1.6 秒，Dock 上方显示剩余秒数和进度条；继续说会清除倒计时。
- Part 2 准备期不调用正式录音；倒计时结束或点击开始后播放提示音，再进入 120 秒连续录音。
- 正式录音和跟读复用 AudioWorklet、16kHz 单声道重采样、16bit PCM 与手写 WAV header。
- 跟读有 2 秒下限、8 秒上限，避免与正式 Part 2 作答同时抢占麦克风。
- 报告、主题、模式、Part 2 deadline、当前轮次、原声音频 URL 和发音数据均使用真实字段，没有另造平行数据模型。

## 7. 当前后端兼容边界与待联机项

当前仓库 daemon 已存在 `band_history`、`probe` 和新 VAD `config` 项；但本轮审查时尚未找到以下扩展的完整持久化/路由实现：

- Profile 的 `llm_mode / llm_provider / llm_base_url / llm_model / has_api_key`。
- `POST /api/llm/test`。
- 创建课程的 `drive_mode` 处理与 standalone 自动开播。
- `POST /api/sessions/{id}/practice_sentence`。

前端已按附件契约接入，并对 404 或缺失 `drive_mode` 显示明确升级提示，**不会把当前旧 daemon 的开课等待或 mock 分数伪报为真实成功**。

以下仍需更新配套 daemon 后做真实联机验收：

1. DeepSeek / OpenAI / Ollama 的真实连接测试与 Key 持久化。
2. 界面直连创建课程后自动计划、自动第一题、每轮追问和自动报告。
3. 真实麦克风、ASR、VAD 倒计时/取消、原声与 TTS 播放。
4. 2–8 秒真实跟读上传、前后 GOP 对比和音素提升结果。
5. Part 2 完整 60+120 秒计时与提交、结束课程到真实报告推送。

验收 mock 只用于界面、字段和交互测试；其 WebSocket 404 重连日志来自 mock 未实现 WS，不能据此判断真实 daemon 的 WebSocket 失败。
