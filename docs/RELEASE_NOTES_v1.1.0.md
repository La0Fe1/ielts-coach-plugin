# IELTS 口语教练 v1.1.0 — 说完了你说了算

**考官的水平 = 你正在用的那个模型。** 安装包不带大模型，
智力来自你 dsh / Cursor / Claude Code 里的模型，每节课花你自己的 token。

## 这次改了什么

- **结束一句话改成手动**：答完点「我说完了」（或按空格）才提交，不再停 2.6 秒自动切。
- **卡壳提示保留而且更准**：说到一半停顿 2 秒，会在气泡下弹出 2–3 个候选词，不打断录音。
- 想回到自动提交：底部「更多 → 停顿自动提交」。
- Part 2 仍是连续录音，结束也交给你（120 秒到点作为保险）。

## 下载（机器上不需要 Python）

下载这三个文件，放到同一个文件夹：

- `IELTS-Coach-full.zip.001`（1800 MB）
- `IELTS-Coach-full.zip.002`（539 MB）
- `merge-and-extract.bat`

双击 `merge-and-extract.bat`（用 Windows 自带的 tar，不需要 7-Zip），然后双击 `启动口语教练.bat`。

> 只想快速看看：`IELTS-Coach-portable-win64.zip`（1.4 GB，单文件，识别模型小一号）。

## 怎么用

1. 在 dsh / Cursor / VS Code / Claude Code 里说「开始练雅思 Part 1」
2. 桌面弹出窗口，点一次「开始语音连麦上课」授权麦克风
3. 考官提问 → 你回答 → 说完点「我说完了」
4. 说「结束本课」→ 四维报告；下次上课先复习上次的错

## 本机跑什么

- 语音识别 faster-whisper（包内 `small.en`）+ 音素级发音评分（int8 GOP）
- 断句 Silero VAD；朗读 edge-tts（联网，更自然）或本地 Kokoro（离线）
- 题库 283 题、SQLite 长期记忆（`~/.ielts-coach`）

音频只发往 `127.0.0.1:8765`，不上传任何服务器。

## 已知限制

- 便携版只有 Windows x64
- 需要 WebView2（Win10/11 自带）
- 完整版 3.2 GB，因为 GitHub 单文件上限 2 GB 才拆成两卷
- 只支持英文口语

## 完整改动

见仓库 [CHANGELOG.md](https://github.com/La0Fe1/ielts-coach-plugin/blob/main/CHANGELOG.md)。
