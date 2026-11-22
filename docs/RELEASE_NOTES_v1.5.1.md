# IELTS 口语教练 v1.5.1

修一个会让便携版**完全打不开**的打包错误。

## 修了什么

- 便携包漏了 `database/schema.sql`，daemon 启动直接报错退出（v1.2 以来的便携包都有这个问题）。
- 便携包漏装 `silero-vad` 和 `edge-tts`，导致只能退到能量 VAD 和本地 Kokoro 音色。

现在打包会带上 schema，依赖补齐；已在打包版里实测：

- 三个模型全部就绪：`asr=True pron=True tts=edge`
- Silero VAD 就绪 0.17s
- 建课 5 题、录音检测、DeepSeek 首题 6.0s、音频 URL 正常

## 用法（不变）

1. 下 `IELTS-Coach-full.zip.001`、`.002`、`merge-and-extract.bat` 到同一文件夹
2. 双击 `merge-and-extract.bat`
3. 双击 `启动口语教练.bat`

第一次启动会加载模型（约 30 秒），之后是秒开。

## 从 v1.5.0 升级

v1.5.0 的便携包打不开，请直接用这个版本覆盖。记忆在 `%USERPROFILE%\.ielts-coach`，不受影响。
