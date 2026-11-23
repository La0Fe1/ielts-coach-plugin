# IELTS 口语教练 v2.0.0 · 实时语音网页版

打开网页就能练：**像打电话一样对话**，考官实时听、实时接话，随时可以打断。

## 这一版是什么

- 纯 TypeScript 全栈（Node 网关 + React PWA），零 Python、零本地模型
- 手机 / iPad / 电脑浏览器都能用，可添加到主屏幕
- 三家实时语音：阿里云百炼 Qwen-Omni、Google Gemini Live、OpenAI Realtime（含中转）
- 双轨：主轨极速通话；副轨异步生成语法精批、长期记忆、四维报告
- 两种用法：自己填 Key（只存浏览器），或用朋友分享的访问口令

## 3 分钟部署

1. 用 Docker 部署到 Render / Zeabur / 自己的服务器（仓库自带 Dockerfile、docker-compose.yml、render.yaml、zeabur.json）
2. 环境变量：
   - ACCESS_CODE=ielts2026（可选，给朋友用口令）
   - DASHSCOPE_API_KEY=sk-...（国内推荐）
   - 或 GEMINI_API_KEY=... / OPENAI_API_KEY=...
3. 打开网址 → 设置里填口令或 Key → 开始连麦

本地：双击 start-local.bat（Windows）或 ./start-local.sh。

## 已知未实测

- 真实厂商 Key 未实测（本机没有实时语音 Key）：协议映射与全链路转发已用本地假上游跑通，真实外网音色与延迟需自测
- 真机 iPhone Safari / Android 的音频解锁与 PWA 安装未实测
- 旧版本 v1（本地 Python）保留在分支 archive/v1-local-python

详细验收清单见仓库 docs/V2_DELIVERY.md。
