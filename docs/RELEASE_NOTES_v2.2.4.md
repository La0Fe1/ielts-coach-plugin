# IELTS 口语教练 v2.2.4

**诊断版：新增「声音自检」页，一页看清到底是浏览器、服务端朗读、还是系统音量的问题。**

v2.2.3 已修复「Edge TTS 被限流（429）导致突然没声音」的根因，但仍有环境（系统静音、
输出设备、标签页静音、浏览器朗读被禁用）会让课堂没声音。这一版专门用来定位这类问题。

## 新增

- **声音自检页**：`http://127.0.0.1:3000/sound-check.html`
  - ① 检查环境：AudioContext 状态 / sampleRate / 声道数、`speechSynthesis` 与系统音色数量、
    页面加载的前端 bundle、服务端版本与 TTS 计数器；
  - ② 播放测试音：真实调用 `POST /api/voice/tts`，显示 HTTP 状态、字节数、解码时长、
    音量峰值、播放结果，并告诉你「如果 ✅ 但听不到 = 系统音量/输出设备/标签页静音」；
  - ③ 浏览器朗读：测试 `speechSynthesis` 兜底通道是否正常。
  - 全程只读 + 播放测试音，不写课程、不消耗 DeepSeek Key。
- **服务端 TTS 计数器**：`GET /api/status` 新增 `tts: { requests, ok, failed, lastBytes, lastMs,
  lastTextChars, lastError, lastAt }`，配合服务端日志 `[tts] ok 42336B in 812ms (69 chars)`
  可以确认「浏览器到底有没有向服务器要过音频」。
- 版本统一 `2.2.4`（4 个 `package.json` + lock 5 处 + APP_VERSION + MCP server version）。

## 怎么用

1. 打开 `http://127.0.0.1:3000/sound-check.html`；
2. 依次点「① 检查环境」→「② 播放测试音」→「③ 浏览器朗读」；
3. 把日志区内容（或截图）发给我：
   - ② 显示 ✅ 但你听不到 → 系统音量 / 输出设备 / 标签页静音；
   - ② 显示 ❌ HTTP 4xx/5xx → 服务端朗读问题（把状态码发我）；
   - ③ 也 ✅ 但你听不到 → 系统扬声器或浏览器被静音。

## 验收

- `npm run typecheck` / `npm test`（9 文件 / 93 项）/ `npm run build` 全绿；
- 本机用无头 Edge（CDP）实测真实页面音频链路：`/api/voice/tts` 200、`decodeAudioData`
  成功（3.5s / 48kHz / 单声道 / 峰值 0.41）、`AudioBufferSourceNode` 正常 `ended`、无 JS 报错。
- **未实测**：真实设备扬声器 / 蓝牙耳机 / 系统音量混音器状态（需要你在自己机器上点自检页确认）。

## 升级步骤

1. `git pull` 拉取 v2.2.4；
2. `npm run build`（新增静态自检页需要重建）；
3. 重启服务；
4. 打开 `/sound-check.html` 按上面步骤自检。
---

## 📌 封版说明

> ⚠️ 本版已被 **v2.2.5 安全补丁**取代（服务端 Key 禁止自定义中转 + 本地只监听 127.0.0.1）；
> 封版版本以 v2.2.5 为准。

**v2.2.4 曾是 2026-11-23 的封版版本**（封版标记 tag 现指向 v2.2.5），发布后项目暂时冻结，
不再自动迭代。封版前已提交并推送全部代码、测试、文档；真实进程 E2E、真实 Edge TTS 与无头浏览器
音频链路均已实测，未实测项（真实厂商 Key 质量、真机 iPhone/Android、Docker 构建、云平台部署）
已如实记录在 `docs/V2_DELIVERY.md`。

恢复开发时：删除 README 的「版本状态：已封版」一节，提升版本号（4 个 `package.json` +
`package-lock.json`），按文末流程继续即可。
