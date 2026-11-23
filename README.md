# IELTS 口语教练 · 实时语音版（v2.0）

打开网页就能练雅思口语：**像打电话一样对话**，考官实时听、实时接话，你可以随时打断。
语法纠错和升级表达在后台安静生成，不打断你开口。

- 手机 / iPad / 电脑浏览器都能用，可「添加到主屏幕」当 App
- 麦克风、字幕、打断都在本地页面完成，语音走你配置的服务商
- 两种用法：**自己填 API Key**（只存在你自己的浏览器）或 **用朋友分享的访问口令**

---

## 一、最快：3 分钟部署给朋友用（推荐）

部署到任意支持 Docker 的云（Render / Zeabur / 自己的服务器）：

1. Fork 或上传本仓库
2. 新建 Web Service（Docker），环境变量按需填：
   - ACCESS_CODE=ielts2026（朋友输入这个口令就能用你的额度）
   - DASHSCOPE_API_KEY=sk-...（阿里云百炼，国内直连，推荐）
   - 或 GEMINI_API_KEY=... / OPENAI_API_KEY=...
3. 部署完把网址发给朋友，他在设置里输入口令即可开麦

> 只填 Key 不填 ACCESS_CODE 时，只能用户自带 Key（BYOK）。

一键部署文件已经准备好：Dockerfile、docker-compose.yml、render.yaml、zeabur.json、.env.example。

## 二、本地跑起来

装好 Node.js LTS（https://nodejs.org/zh-cn ，20 以上），然后：

- Windows：双击 start-local.bat
- Mac / Linux：./start-local.sh

浏览器打开 http://localhost:3000 → 设置里填 Key 或口令 → 开始连麦。

想用手机试：在电脑上执行

    npx cloudflared tunnel --url http://localhost:3000

把生成的 https 链接在手机上打开即可（临时链接，关掉就失效）。

## 三、支持哪些语音服务商

| 服务商 | 适用 | 说明 |
| --- | --- | --- |
| 阿里云百炼 Qwen-Omni-Realtime | 国内 | 延迟低、中文支持好，推荐国内用户 |
| Google Gemini Live | 海外 | 音色自然，需要能访问 Google |
| OpenAI Realtime | 海外 / 中转 | 支持自定义 endpoint，兼容 OneAPI/NewAPI |

设置里可以填**自定义 endpoint**，用中转站或 Cloudflare Worker 反代都行。

## 四、怎么用（练的时候）

- **自由通关**：随时开口就能打断考官；外放时考官说话会自动闭麦，点「打断」即可插话。
- **手动控场**：说完点「我说完了」再提交，适合嘈杂环境。
- **Part 2**：自动切手动模式，60 秒准备（不开麦）+ 2 分钟独白，绝不打断你。
- **字幕**：双方逐字滚动；可以开「盲听」练听力。
- **精批**：每说完一句，右侧（手机上是底部抽屉）出现 ✨ 精批：修正、Band 8 升级句、错因。
- **报告**：结束后生成四维评分 + Top 错题 + 可背诵的升级句，存进浏览器本地，可导出 JSON。

## 五、隐私

- 自带 Key 只存在你浏览器的 localStorage，服务端**不落盘、不打日志**。
- 站长模式下 Key 只在服务器内存里用于建立连接，前端拿不到。
- 课程记录只存在你自己的浏览器（IndexedDB），换设备不会自动同步。

## 六、开发

    npm install
    npm run dev        # 前端 5173 + 网关 3000
    npm run typecheck
    npm test
    npm run build && npm start

目录：shared/（协议与雅思 Prompt）、server/（网关与三家适配器）、web/（React PWA）。

## 七、旧版本

v1（本地 Python / Whisper / 桌面窗口）保留在分支 archive/v1-local-python，不再维护。
