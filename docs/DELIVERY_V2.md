# 前端 2.0 交付记录（豆包设计稿 → 本机集成）

日期：2026-11-20
来源：`design.md` / `SELF_CHECK.md` / `ielts-coach-frontend-2.0.0.zip`

## 1. 已完成

| 项 | 结果 |
| :--- | :--- |
| 替换旧前端 | 旧版归档到 `_archive/web_src-v1`，新版位于 `web_src/` |
| 依赖与构建 | `npm install` 通过；`npm run build` 产出 `index-Chwr-irg.css` / `index-B66T0SLa.js`（构建哈希与豆包自检报告一致，说明产物可复现） |
| 真机渲染 | 用 puppeteer-core 驱动本机 Edge 实测 380 / 480 / 600 / 1400 四种宽度 |
| 横向溢出 | 四种宽度 `scrollWidth == clientWidth`，**无横向滚动** |
| 契约对接 | `/api/sessions/{id}/bootstrap`、`/turns`、`/audio`、`/tts/word`、`/tts/say`、`/api/profile`、`/ws/{id}`、`/ws/live/{id}` 全部命中 daemon 现有路由 |
| 卡壳提示 | 真实 daemon 产出 `stuck.detected=true`（2.58s），候选词 chips 正常渲染并可发声 |

![课堂（宽屏）](docs/v2-chat.png)
![侧栏 480px](docs/v2-embed.png)
![开课 Gate](docs/v2-gate.png)

## 2. 集成时修掉的三个真实问题

### 2.1 停顿测不准（影响卡壳识别与流利度）
Whisper 的词级时间戳会把静音"摊平"：一段插入 2.6s 停顿的音频，15 个词被均匀铺满整段，
测出来的最长停顿是 **0.0s**（开着 `vad_filter` 时是 1.82s）。卡壳检测因此完全失效。

改为：**停顿与发声时长用我们自己的能量 VAD 计算**，Whisper 只负责转写与词位置。

- `compute_fluency(..., vad_segments=...)`：停顿取相邻语音段的间隔，`after_word/before_word` 由词表回填
- WPM 改用**实际发声时长**（去掉静音），不再是"首词到尾词"的墙钟时间
- 同时关掉 Whisper 内部的 `vad_filter`，避免它再压缩句内停顿

实测：同一段音频 → `longest_pause_sec = 2.58`、`speech_ratio = 0.562`、`detected = true`。

### 2.2 打开面板时首题被顶栏压住
进入课堂时无条件 `scrollIntoView`，内容稍超一屏就把第一题顶到 sticky 顶栏下面。

改为：**只在新一轮对话产生时跟随滚动**，加载历史时停在顶部。

### 2.3 侧栏截图里的"横向截断"是假象
早期用 `msedge --screenshot --window-size=480` 拍图，"重听""回放原声"看起来被切掉。
用 puppeteer 实测真实视口后确认：**布局无溢出**，是命令行截图模式预留滚动条导致的 16px 假象。

## 3. 卡壳阈值：已按你的决定改为 silence 2.6s / stuck 2.0s

原来的组合是 silence 1.8s 自动提交、stuck 2.5s 提示，**普通轮次永远看不到实时提示**。
现在改成 `vad_silence_sec = 2.6` / `vad_stuck_sec = 2.0`，并把前端本地兜底 VAD、开课文案、试音文案一起改成 2.6。

真机验证（直接往 `/ws/live/{id}` 灌音频帧，不依赖麦克风）：

```
ready: {'silence_sec': 2.6}
  STUCK flag  trailing 2.08s
  STOP         trailing ~2.6s  reason=silence
  stuck_before_stop: True
```

普通轮次因此有约 **0.5–0.6 秒**的实时提示窗口：chips 先出现，然后才自动提交；
提交后 `long_pauses_json.stuck` 仍保留在纠错卡里，考官下一轮也会据此给提示。
Part 2 连续录音模式下前端仍把阈值临时设 3s，窗口更宽。

代价：自动接话从 1.8s 变成 2.6s，思考型学生会更舒服，但每轮多等 0.8 秒。

## 4. 仍需真实麦克风验收（不做假结论）

1. 真实麦克风采集 → 16kHz WAV → 真实 ASR 返回
2. Silero VAD 自动断句时序与候选词发声
3. 学生原声与标准示范的对比播放
4. Part 2 完整 60s 准备 + 120s 作答
5. 空格开始/停止、自动接话、取消收尾
6. 结束课程 → 报告 WebSocket 到达 → Markdown 下载 → 重开新局

豆包的自检表把这 6 项标为 `[~]`（实现完成、待联机），这是诚实的，我保留同样口径。

## 5. 回滚

```powershell
Remove-Item web_src -Recurse -Force
Move-Item _archive/web_src-v1 web_src
cd web_src; npm install; npm run build
```