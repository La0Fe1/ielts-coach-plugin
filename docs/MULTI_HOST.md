# 多宿主使用说明（dsh / VS Code / Cursor / Claude Code）

> 核心设计：**能力住在本地守护进程，入口长在每个宿主里**。
> 换工具只换"薄壳"，daemon、题库、记忆、发音引擎全部复用。

## 1. 结构

```text
宿主（dsh / VS Code / Cursor / Claude Code）
   │  ① MCP stdio（工具调用）   ② SKILL.md（行为规范）   ③ 一个薄壳入口
   ▼
mcp_bridge → daemon（127.0.0.1:8765）
   ├─ 模型常驻：Whisper / Kokoro·Edge-TTS / Silero VAD / Wav2Vec2 GOP
   ├─ 题库出题 + 复习编排（daemon/content/question_bank.json）
   ├─ 长期记忆（~/.ielts-coach/ielts_coach.db，所有宿主共享）
   └─ 录音 / 转写 / 流利度 / 发音评分 / 报告
```

## 2. 各宿主入口

| 宿主 | 入口 | 状态 |
| :--- | :--- | :--- |
| **所有宿主（默认）** | 说「开始上课」→ 智能体调 `start_lesson` → daemon 拉起**独立桌面窗口**（pywebview + WebView2，无地址栏） | **已实现，单实例** |
| **ds h** | 同上；也可让智能体调 `open_window` 把窗口调出来 | 可用 |
| **VS Code / Cursor / Windsurf** | 右下角状态栏 🎤 + 命令面板 `IELTS: 打开口语教练面板`；面板以 webview 内嵌，可"在浏览器打开"兜底 | **已安装** `ielts-coach-local.ielts-speaking-coach` |
| **Claude Code / 其它 MCP 工具** | `mcp_bridge` + `~/.dsh/skills/ielts-speaking-coach/SKILL.md`（或 `~/.agents/skills/`），面板用浏览器打开 | 可用 |
| **纯终端** | MCP 工具即可，无 UI | 可用 |

## 3. VS Code 扩展

- 源码：`editors/vscode/`（TypeScript，esbuild 打包，约 10KB）
- 已构建：`editors/vscode/ielts-speaking-coach-0.1.0.vsix`
- 安装：`code --install-extension editors/vscode/ielts-speaking-coach-0.1.0.vsix --force`
- 命令：
  - `IELTS: 打开口语教练面板` — 侧栏 webview 打开 `/?embed=1`
  - `IELTS: 在浏览器打开（麦克风更稳）` — 编辑器 webview 若拦麦克风就用这个
  - `IELTS: 启动本地守护进程` — 用项目 `.venv` 拉起 daemon
  - `IELTS: 检查守护进程状态` — 显示设备 / ASR / TTS / 发音状态
- 设置：`ieltsCoach.port`（默认 8765）、`ieltsCoach.pythonPath`、`ieltsCoach.projectRoot`

> **已知限制**：VS Code webview 对麦克风有沙箱限制，如果面板里点"开始语音连麦"报权限错误，
> 用 `IELTS: 在浏览器打开` 继续（同一节课、同一份记忆，浏览器里说，编辑器里看报告都行）。

## 4. 一键安装

```powershell
cd E:\雅思口语插件开发
.\.venv\Scripts\python.exe scripts\install.py
```

会依次完成：
1. `pip install -e .`（editable，生成 `ielts-mcp.exe`）
2. 复制 `SKILL.md` 到 `~/.dsh/skills/` 与 `~/.agents/skills/`
3. 在 `~/.dsh/profiles/*/cordis.patch.yml` 注册 ielts-coach MCP（已存在则跳过）
4. 写入 Claude Code `~/.claude.json`、Cursor `~/.cursor/mcp.json`（若存在）
5. **安装 VS Code/Cursor 扩展**（检测到 `code`/`cursor` CLI 时）

## 5. 记忆是共享的

所有宿主连的是同一个 daemon、同一个 `~/.ielts-coach/ielts_coach.db`：

- 在 VS Code 里练的第 3 课，回到 dsh 说"继续练" → 直接读到上次的错题、弱音素、Part 2 素材
- 报告统一落在 `~/.ielts-coach/reports/`
- 题库与提示词库在仓库里，改 JSON 即生效（重启 daemon）
