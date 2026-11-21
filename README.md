# 雅思口语教练

练雅思口语的桌面窗口。你说英文，它出题、纠错、记错题。

- 装在自己电脑上，不用装 Python
- 声音和评分在本机，断网也能用
- 老师是你电脑里的 AI（豆包 / Cursor / dsh），换个更强的就教得更好
- 说完停一下，它自己判断你说完没有；卡住会给你词

![课堂](docs/v2-chat.png)
## 下载

**只有一种推荐路径**，机器上不需要装 Python：

1. 打开 [Releases](https://github.com/La0Fe1/ielts-coach-plugin/releases)
2. 把这三个文件下到同一个文件夹：
   - `IELTS-Coach-full.zip.001`
   - `IELTS-Coach-full.zip.002`
   - `merge-and-extract.bat`（合并并解压的那个 bat）
3. 双击 `merge-and-extract.bat`（用的是 Windows 自带的 `tar`，不用装 7-Zip）
4. 双击 `连接我的AI工具.bat` —— 自动把教练接进 Cursor / Claude Code / dsh，并装好技能；用豆包的话它会打印两步配置
5. 在你的 AI 工具里说「开始练雅思 Part 1」，窗口自动弹出

> Release 里还有一个轻量单文件包 `IELTS-Coach-portable-win64.zip`（1.4 GB，识别模型小一号）。
> 只想快点看看长什么样，用那个；正常用上面那三个文件。

## 怎么用

1. 在 dsh / Cursor / VS Code / Claude Code 里说「开始练雅思 Part 1」
2. 桌面弹出窗口，点一次「开始语音连麦上课」，允许麦克风
3. 考官用英文提问，你回答；**说完点「我说完了」**，说到一半卡住 2 秒会给提示词
4. 说「结束本课」出四维报告；下次上课先复习上次错的地方

## 支持的工具

| 工具 | 怎么接 |
| :--- | :--- |
| dsh / Claude Code | MCP + SKILL，说「开始上课」 |
| Cursor / VS Code / Windsurf | 同上 + 扩展（状态栏 🎤、命令面板 `IELTS: 打开口语教练面板`） |
| 任何 MCP 客户端 | `ielts-mcp`，调 `start_lesson` |

## 在豆包工作里用

豆包工作的「插件」支持**本地 STDIO MCP**，「技能」直接吃 `SKILL.md`：

1. 左侧 **插件·技能·伙伴 → 插件 → + 添加 → 新建自定义连接器**
   - 传输类型：**STDIO**
   - 运行命令（便携版）：`<安装目录>\ielts-mcp.bat`
   - 运行命令（源码版）：`<仓库>\.venv\Scripts\ielts-mcp.exe`
   - 环境变量：`PYTHONUTF8` = `1`
2. **技能 → + 添加 → 上传技能**，选 `skills/ielts-speaking-coach/` 文件夹
3. 在豆包里说「开始练雅思 Part 1」

如果客户端只支持 HTTP 连接器：填 **`http://127.0.0.1:8765/mcp`**（daemon 自带这个端点，不用额外进程）。

## 本机跑什么

- 语音识别 faster-whisper（便携包内置 `small.en`）
- 发音评分 wav2vec2 + GOP，音素级，单词标绿 / 黄 / 红
- 断句 Silero VAD；朗读 edge-tts（联网，更自然）或本地 Kokoro（离线）
- 题库 283 题；长期记忆存 SQLite

音频只发往 `127.0.0.1:8765`，不上传任何服务器。数据目录 `~/.ielts-coach`，删掉即清空记忆。

## 从源码跑

```bash
git clone https://github.com/La0Fe1/ielts-coach-plugin
cd ielts-coach-plugin

# Windows
powershell -ExecutionPolicy Bypass -File setup.ps1

# macOS / Linux
bash setup.sh
```

需要 Python 3.11+。

## 开发

```bash
pytest tests -q                                  # 64 个测试
cd web_src && npm run build                      # 构建界面
python -m desktop.app                            # 直接开桌面窗口
python scripts/build_portable.py --with-models   # 打便携包
```

## 已知限制

- 便携版只有 Windows x64；macOS / Linux 走源码方式
- 需要 WebView2（Win10/11 自带，老系统要装 Runtime）
- 完整版 3.2 GB，因为 GitHub 单文件上限 2 GB 才拆成两卷
- 只支持英文口语
- **考官的智力取决于你 agent 的模型**：模型弱，纠错也会弱