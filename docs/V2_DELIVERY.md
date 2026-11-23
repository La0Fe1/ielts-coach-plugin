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
