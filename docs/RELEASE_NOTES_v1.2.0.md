# IELTS 口语教练 v1.2.0 — 下载解压，接上你的 AI，就能上课

**考官的水平 = 你正在用的那个模型。** 安装包不带大模型：
出题、追问、批改、报告都由你 dsh / Cursor / Claude Code / 豆包里的模型完成，花你自己的 token。

## 这次新增

### 1. 一键接入（`连接我的AI工具.bat`）

双击它，脚本会自己找你装过的工具并写好配置：

- Cursor → `~/.cursor/mcp.json`
- Claude Code → `~/.claude.json`
- Claude 桌面 → `claude_desktop_config.json`
- DeepSeek Harness → `~/.dsh/profiles/*/cordis.patch.yml`

同时把 SKILL.md 复制到 `~/.dsh/skills` 和 `~/.agents/skills`。
改文件前会备份，重复运行不会写坏。豆包没有配置文件，脚本最后打印两步手动配置。

### 2. MCP over HTTP

daemon 自带 `http://127.0.0.1:8765/mcp`，只支持 URL 型 MCP 的客户端填这个就行。

### 3. 便携版多一个 `ielts-mcp.bat`

给「填一条命令」的客户端（豆包）用，内部已设好模型路径。

## 安装（不需要安装 Python）

1. 下载这三个文件到同一个文件夹：
   - `IELTS-Coach-full.zip.001`
   - `IELTS-Coach-full.zip.002`
   - `merge-and-extract.bat`
2. 双击 `merge-and-extract.bat`（用 Windows 自带的 tar，不用装 7-Zip）
3. 双击 `连接我的AI工具.bat`
4. 打开你的 AI 工具，说「开始练雅思 Part 1」

## 豆包工作

插件 → + 添加 → 新建自定义连接器：传输类型 STDIO，运行命令填 `<安装目录>\ielts-mcp.bat`，环境变量 `PYTHONUTF8=1`。
技能 → + 添加 → 上传技能，选 `app/skills/ielts-speaking-coach/`。

## 从 v1.1 升级

覆盖安装目录即可；记忆在 `%USERPROFILE%\.ielts-coach`，不受影响。

## 已知限制

- 便携版只有 Windows x64（需要 WebView2，Win10/11 自带）
- 完整版 3.2 GB，因为 GitHub 单文件上限 2 GB 才拆两卷
- 只支持英文口语
- 桌面窗口只是「身体」，必须由 AI 工具驱动；没有 agent 时它会提示「还没有进行中的课程」
