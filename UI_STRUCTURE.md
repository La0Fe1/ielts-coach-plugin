# UI 结构说明（v2.5）

Studio 采用同构双端布局。宽屏（≥1024px）左 58% 为 Dialogue 对话流，右 42% 为 Coach 工作台，两栏独立滚动；窄栏切换单流，选中的回答下方内嵌同一 CoachPanel。顶部仅保留 Elena、题单、记忆、历史和设置。

StartGate 支持已有课程续学及五种模式自主开课。CoachPanel 直接展示语法 Diff、Band 7.5+ 升级句、错因与弱音素；PhonemeDrawer 负责原声、示范音和跟读重测。Part2Card 将 60 秒准备便签与 120 秒作答锁定提词卡分离，准备期不开麦。

VoiceDock 只保留自由连麦/手动控场两档、唯一主按钮、静音和更多。自由模式用动态静默阈值及可见倒计时提示发送，继续说话即取消。报告使用原生 SVG 绘制四维雷达和 Overall 趋势。主题支持浅色、深色及系统跟随，全部 API 与 WebSocket 仅连接本地 daemon。
