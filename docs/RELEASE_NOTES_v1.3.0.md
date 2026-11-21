# IELTS 口语教练 v1.3.0 — 说完没说完，看句子，不看秒表

**插件负责「实时听、实时判断、题库、评分、记忆」；能力上限由你 agent 里的基底模型决定。**

## 这次改的是最核心的那件事

以前：停 2.6 秒就当你答完了。思考久了被误切，答完了还得干等。
现在：停顿 0.9 秒时先判断**这句话完整吗**——

| 你刚才说 | 判断 | 系统行为 |
| :--- | :--- | :--- |
| I live in a small city near the coast. | 完整 | 自动提交，进下一题 |
| I live in a small city near the | 停在介词 | 继续听，不打断 |
| I like it because | 停在连词 | 继续听 |
| My favourite place is the | 停在冠词 | 继续听 |
| 上面任一 + 又静默 2 秒 | 卡壳 | 弹出 2–3 个提示词 |
| Yes, I do. | 完整（短回答） | 自动提交 |

判断由本机完成：词法（句尾不能是冠词/介词/连词/系动词）+ 句法（最后一小句必须有谓语动词）+ 语义豁免（代词、助动词结尾算完整）。
22 个用例覆盖，含「I like it.」「Yes, I do.」这类容易被误判的句子。

## 下载（机器上不需要 Python）

1. 下这三个文件到同一文件夹：
   - `IELTS-Coach-full.zip.001`
   - `IELTS-Coach-full.zip.002`
   - `merge-and-extract.bat`
2. 双击 `merge-and-extract.bat`
3. 双击 `连接我的AI工具.bat`（自动接 Cursor / Claude Code / dsh；豆包按提示两步配置）
4. 打开你的 AI 工具，说「开始练雅思 Part 1」

## 从 v1.2 升级

覆盖安装目录即可，记忆在 `%USERPROFILE%\.ielts-coach`，不受影响。

## 已知限制

- 便携版只有 Windows x64
- 完整版 3.2 GB，分两卷（GitHub 单文件上限 2 GB）
- 只支持英文口语
- 桌面窗口只是「身体」，必须由 AI 工具驱动；没有 agent 时它没有题可出
