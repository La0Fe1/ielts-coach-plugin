# IELTS 口语教练 v2.2.3

**修复「突然没声音」：微软 Edge 朗读被限流时不再静音。**

## 问题定位（真实日志）

服务端日志里出现了：

```
[ielts-v2] Edge TTS 失败: Unexpected server response: 429
```

微软 Edge 朗读服务对短时间内的突发请求会返回 **429（限流）**。v2.2.2 之前的做法是：
一句话一个 TTS 请求、且允许 2 个并发预取 —— 考官一次回 2–3 句就会在 1 秒内打出 3 个请求，
很容易触发 429；路由返回 503 后，前端虽然会回退浏览器朗读，但那次回退没有真正发声，
于是整节课“只有字幕没有声音”。

## 修复内容

1. **服务端（`server/src/deepseek-voice.ts`）**：
   - 所有 Edge TTS 合成**串行排队**，浏览器再也不会打出并发突发请求；
   - 429 / 限流自动**重试 3 次**（退避 0.7s / 1.4s），仍然失败才返回 503；
   - 增加 **128 条 LRU 音频缓存**，重复的考官句子直接返回内存音频；
   - 失败诊断仍只写 stderr，不泄露 Key。
2. **前端（`web/src/realtime/deepseekSession.ts`）**：
   - TTS 请求从「一句一个」改为「≤420 字符一块」，通常一次朗读只有 **1 个请求**，
     预取并发从 2 降到 1 —— 从源头减少限流概率；
   - 真回退系统朗读时，顶部弹出一次友好提示
     「微软朗读服务暂时被限流，已自动切换为浏览器朗读（音色会变）」；
   - 在用户点击「开始对话」的手势里**预解锁 `speechSynthesis`**（静音 utterance），
     保证限流兜底真的能出声；
   - 回退前先 `cancel()/resume()` 清掉可能卡住的朗读队列。
3. 版本统一 `2.2.3`（4 个 `package.json` + `package-lock.json` 5 处 workspace version、
   `APP_VERSION`、MCP server version、测试断言）。

## 升级步骤

1. `git pull` 拉取 v2.2.3；
2. `npm run build`（前端重建；服务端是 tsx 直跑，重启服务即可生效）；
3. 重启服务（或重新双击 `start-local.bat`）；
4. **硬刷新浏览器**（`Ctrl+F5` / `Cmd+Shift+R`），重新开一节课。

## 验收

- `npm run typecheck` / `npm test`（9 文件 / 93 项）/ `npm run build` 全部通过。
- 服务端 TTS 已用真实微软服务验证：单次合成 200 / `audio/mpeg`；连续 4 次快速请求
  经串行 + 重试后全部成功（详见 `docs/V2_DELIVERY.md`）。
- **未实测**：长时间连续上课下的真实限流概率、真机 Safari / Android 的浏览器朗读回退音色。

## 已知边界

- Edge TTS 是微软免费服务，极端情况下仍可能持续限流；此时会自动用系统朗读，音色会变。
- 浏览器朗读（`speechSynthesis`）在部分 Linux 发行版 / 无语音包的浏览器里可能没有声音，
  这种环境建议改用手机 Safari 或 Chrome。
