# IELTS 口语教练 v1.2.0 — 任意 agent 都能接

**考官的水平 = 你正在用的那个模型。** 安装包不带大模型，
智力来自你 dsh / Cursor / Claude Code / 豆包里的模型。

## 这次新增了什么

### 1. MCP over HTTP

daemon 现在自带一个 HTTP 端点：

```
http://127.0.0.1:8765/mcp
```

支持 URL 型 MCP 的客户端（豆包工作、扣子等）填这个地址就能用，不用再起本地进程。

### 2. 便携版多一个启动器

解压后的根目录多了 `ielts-mcp.bat`，给豆包这类「填一条命令」的客户端用，
内部已经设好模型路径和 PYTHONPATH。

### 3. 在豆包里怎么接

**插件**：豆包工作 → 插件·技能·伙伴 → 插件 → + 添加 → 新建自定义连接器

- 传输类型：STDIO
- 运行命令：`<安装目录>\ielts-mcp.bat`
- 环境变量：`PYTHONUTF8=1`

如果只支持 HTTP：传输类型选 HTTP，URL 填 `http://127.0.0.1:8765/mcp`。

**技能**：技能 → + 添加 → 上传技能，选仓库里的 `skills/ielts-speaking-coach/` 文件夹。

然后在豆包里说「开始练雅思 Part 1」，桌面窗口会自动弹出。

## 下载（机器上不需要 Python）

下这三个文件，放同一个文件夹：

- `IELTS-Coach-full.zip.001`
- `IELTS-Coach-full.zip.002`
- `merge-and-extract.bat`

双击 `merge-and-extract.bat`，然后双击 `启动口语教练.bat`。

## 从 v1.1 升级

覆盖安装目录即可，记忆在 `%USERPROFILE%\.ielts-coach`，不受影响。

## 已知限制

- 便携版只有 Windows x64
- 完整版 3.2 GB，分两卷（GitHub 单文件上限 2 GB）
- 只支持英文口语
