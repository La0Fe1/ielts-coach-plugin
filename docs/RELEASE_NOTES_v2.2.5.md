# IELTS 口语教练 v2.2.5

**安全补丁：你分享出去的版本，别人拿不到也花不了你的 API Key。**

## 这次修了什么

1. **服务端 Key 不再可能被转发到别人的服务器**
   - 之前：如果你把服务端 Key 写进 `.env` 并把 `ACCESS_CODE` 发给朋友，懂技术的口令持有者可以通过
     自定义 `endpointUrl` / 中转地址，让你的服务器把 **你的 Key** 发给他的地址（Key 泄露）。
   - 现在（ACCESS_CODE / 服务端 Key 场景）：
     - `/api/voice/deepseek-turn`（DeepSeek 纯语音考官回复）忽略客户端自定义 `endpointUrl`，
       只走官方 `https://api.deepseek.com/v1`；
     - WebSocket 实时语音（百炼 / Gemini / OpenAI）忽略客户端自定义 `endpointUrl`；
     - DeepSeek 精批在「服务端 DEEPSEEK_API_KEY」路径下忽略客户端 `coachBaseUrl`/`coachModel`。
   - **浏览器自带 Key（BYOK）** 不受影响：仍然可以填自己的中转站地址。
2. **本地启动默认只监听本机**
   - 新增 `HOST` 环境变量：默认 `0.0.0.0`（云端 / Docker 必须）。
   - `start-local.bat` / `start-local.sh` 现在自动设 `HOST=127.0.0.1`：同一 Wi-Fi 下的其他人
     **打不开**这个网页，也就借用不到你浏览器里的 Key。
   - 要让手机 / 局域网共用：用 cloudflared 等 HTTPS 隧道（隧道连本机端口，仍然安全），
     或显式改 `HOST=0.0.0.0`（并注意风险）。
3. **启动日志一眼看清安全状态**
   ```
   [ielts-v2] listening on http://localhost:3000 | bind=127.0.0.1 (local only)
   [ielts-v2] keys: browser BYOK + server env: none (BYOK only)
   [ielts-v2] 未设置 ACCESS_CODE：服务端 Key 不对外开放，只有浏览器自带的 Key 可用
   [ielts-v2] MULTI_USER_MODE=false | MCP_TOKEN=未设置（/mcp 仅本机） | data dir=...
   ```
   日志只打印「有没有 / 开没开」，**永远不打印 Key 本身**；服务端 Key 不会写入磁盘、日志或 API 响应。

## 升级步骤

1. `git pull` 拉取 v2.2.5；
2. `npm install`（本次无新依赖，可跳过；建议跑一次保持一致）；
3. `npm run build`（服务端改动 + 前端重建）；
4. 重启服务（用 `start-local` 启动则自动只监听本机；云端继续用默认 `0.0.0.0`）；
5. 检查启动日志里的 `bind=`、`ACCESS_CODE`、`MULTI_USER_MODE`、`MCP_TOKEN` 是否符合预期。

## 验收

- `npm run typecheck` / `npm run build` / `npm test` 全绿：**10 个测试文件 / 98 项通过**，
  其中新增 `server/tests/security.test.ts` 5 项（BYOK 才允许自定义 endpoint、服务端 DeepSeek Key
  强制官方地址、口令校验等）。
- 本机实测：`start-local` 启动日志显示 `bind=127.0.0.1 (local only)`；`/health` 与原有 98 项测试全部通过。
- **未实测（如实标注）**：从另一台设备 / 公网真实访问验证「127.0.0.1 无法访问」（本机无法从外部验证，
  但 Node 的绑定语义与启动日志可确认）；真实云部署。

## 已知边界

- 如果你确实想把自己的 Key 分享给朋友用：设 `ACCESS_CODE` 并发给他们；任何知道口令的人都能使用
  你的额度（这是设计），Key 本身不会离开服务器。
- `/api/voice/tts` 仍是免费朗读接口、不需要 Key；公开部署时的滥用风险请用反向代理限流。
