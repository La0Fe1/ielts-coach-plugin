# v2.0.0 交付说明（实时语音网页版）

## 一、已真实验证

| 项目 | 证据 |
| --- | --- |
| 依赖安装 | npm install 0 报错 |
| 类型检查 | npm run typecheck：shared / server / web 全部 0 报错 |
| 前端构建 | vite build 通过，产物 190 KB（gzip 62 KB） |
| 网关构建 | tsc --noEmit 通过 |
| 单元/协议测试 | npm test：12 项全绿 |
| 生产服务 | node server/src/index.ts（tsx）：/health 返回 v2.0.0 |
| 静态页面 | GET / 200，JS/CSS 资源 200 |
| 网关鉴权 | 无 Key 时返回 no_credentials 与中文提示；未知帧返回错误 |
| 端到端转发 | 用本地假上游跑通：session_ready → user_speech_started → user_transcript_delta(replace) → user_transcript_final → examiner_transcript_delta，二进制音频 960 字节原样转发，上游收到 input_audio_buffer.append |
| 三家协议映射 | Qwen：text+stash 合并为 replace；Gemini：responseModalities 只含 AUDIO 且转录字段在 setup 顶层；OpenAI：16k→24k 升采样后长度 1.5 倍、speech_started 正确映射 |
| 课表规划 | 全真模考生成 part1→part2→part3，题卡含 You should say: |

## 二、尚未实测（必须知道）

1. **真实厂商 Key 未实测**：本机没有任何百炼 / Gemini / OpenAI 的实时语音 Key，因此
   真实外网 WSS 连通性、真实音色、真实打断延迟都没有跑过。
   已用本地假上游验证协议映射与全链路转发，但不是真实厂商。
2. **真机 iPhone Safari / Android** 未实测：音频解锁、AudioWorklet 重采样、PWA 安装
   需要在真机浏览器上验证。
3. **回声防护**：外放模式下「考官说话时自动闭麦」逻辑已实现，但真实外放回声强度未实测。
4. **副轨精批 / 报告**：需要文本模型 Key 才会真正调用；无 Key 时接口返回 502，前端会显示提示，不影响主通话。

## 三、3 分钟部署

1. 上传仓库到 Render / Zeabur，选 Docker。
2. 环境变量填：
   - ACCESS_CODE=ielts2026（可选，给朋友用口令）
   - DASHSCOPE_API_KEY=sk-...（国内推荐）
   - 或 GEMINI_API_KEY=... / OPENAI_API_KEY=...
3. 部署完打开网址 → 设置里填口令或 Key → 开始连麦。

本地：双击 start-local.bat（Windows）或 ./start-local.sh。

## 四、已知边界

- 浏览器必须允许麦克风；非 HTTPS 的局域网 IP 会被浏览器拒绝（localhost 除外，或用 cloudflared 临时域名）。
- 中断播放依赖服务端 user_speech_started 事件；若某中转站不返回该事件，可用「打断」按钮手动清空。
- 课程只存本地 IndexedDB，换设备不同步（可导出 JSON 手动迁移）。
---

## v2.0.1 修复记录（2026-11-23）

### 修复的真实联调 Bug

1. **开场白丢失**：适配器现在等上游握手成功后才返回句柄，网关把握手中收到的控制帧排队回放，
   前端在 session_ready 之后才发开场指令 —— 慢网络下第一题不再静默。
2. **自带 Key 时精批/报告全失效**：/api/coach/* 现在接收并优先使用浏览器传入的 Key，
   支持独立的精批 Key/地址/模型；没有凭证时返回 401，**不再伪造 6.0 分报告**。
3. **服务端 Key 被盗刷**：服务端配置了 Key 但未设置 ACCESS_CODE 时，默认拒绝无自带 Key 的请求
   （access_code_not_configured），除非显式设置 ALLOW_PUBLIC_HOST_KEY=true。
4. **Gemini 字幕蒸发/顺序颠倒/切模式断连**：只保留 ?key= 参数；用户字幕在考官开口前先落盘；
   考官字幕用累加器在 turnComplete 时发出非空文本；中途不再发送非法 realtimeInputConfig。
5. **React 旧闭包**：模式/阶段/外放开关全部走 ref，通话中切换立即生效；断线能弹出提示。
6. **外放尾音被反录**：PcmPlayer 增加 onIdle（最后一个音频真正播完 +220ms），
   外放模式等尾音播完才解除上行静音。
7. **Part 2 直接开课不出题卡**：首题是 cue card 时，session_ready 后立即显示题卡 + 60 秒准备（保持闭麦）。

### 补齐的交互

- 历史课与长期记忆抽屉（列表、回看字幕/报告、导出/导入 JSON）；开课时自动带最近 5 条记忆进考官提示。
- 盲听模式点单条考官字幕可临时偷看。
- 点任意用户字幕查看那一轮的精批；手机端自动拉起底部抽屉。
- 草稿字幕兜底：服务端 1.2 秒没给 delta 时，用浏览器识别显示浅色实时草稿。
- 设置弹窗分「自带 API Key / 朋友访问口令」两个 Tab，支持自定义模型、Workspace ID、精批专用 Key，以及「测试连接」。

### 自动化测试

- 新增 server/tests/gateway.test.ts 5 项：开场指令竞态、精批 BYOK、未设口令拒绝服务端 Key、
  无凭证不返回假报告、Gemini 字幕顺序。
- 全量：17 项通过（npm test）。

### 仍未实测

- 真实厂商 Key 的外网连通与音色（本地假上游验证过协议）。
- 真机 iPhone Safari / Android 的音频解锁与 PWA 安装。
