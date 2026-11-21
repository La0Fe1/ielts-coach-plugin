# 打包与发布

## 目标

用户从 GitHub 下载后**双击就能用**，机器上不需要 Python、不需要 Node、不需要 pip。

## 便携版做了什么

```text
dist/IELTS-Coach-portable-win64.zip
└── app/
    ├── python/            内嵌 CPython 3.12（python.org embeddable，11 MB）
    │   └── Lib/site-packages/   全部依赖（CPU 版 torch，约 250 MB）
    ├── daemon/            本地服务：模型、录音、评分、题库、记忆
    ├── desktop/           桌面窗口（pywebview + WebView2）
    ├── mcp_bridge/        给 dsh / Cursor / Claude Code 调
    ├── start.bat          启动口语教练.bat
    └── README.txt
```

- **不写系统环境**：一切都在解压目录里，删掉文件夹就是卸载
- **不装驱动**：Windows 10/11 自带 WebView2
- **模型随包分发**（不再首次下载）：`app/models/` 由 `scripts/prepare_models.py` 生成

## 为什么不用 PyInstaller

torch / transformers / kokoro 大量依赖数据文件与动态导入，PyInstaller 的 hook 经常漏，
且单文件模式每次启动要解包 1 GB。用「内嵌解释器 + 真实 site-packages」更稳，
同样不需要用户装 Python。

## 体积预算（硬约束：GitHub 单文件 2 GB）

| 组成 | 大小 |
| :--- | :--- |
| 内嵌 Python + 依赖（含 CPU torch） | ~450 MB |
| 语音识别 `small.en`（CT2） | 460 MB |
| 发音评分 int8（GOP） | 338 MB |
| 离线语音合成 Kokoro | 347 MB |
| Silero VAD | 2 MB |
| **zip 合计** | **1379 MB** |

取舍：

- 原计划 `distil-large-v3` 单文件就 1.44 GB，加上其它必然超 2 GB；改用 `small.en`
- 发音模型 `wav2vec2-xlsr-53` fp32 是 1205 MB，动态 int8 量化后 **338 MB**，
  随机探针上 CTC top-1 一致率 **1.0000**、平均 logit 偏差 0.156
- Kokoro 保留，这样断网也能朗读考官问题

## 三种发布形态

| 方案 | 附件 | 大小 |
| :--- | :--- | :--- |
| **完整版（推荐）** | `IELTS-Coach-full.zip.001` + `.002` + `合并并解压.bat` | 1800 MB + 539 MB |
| 轻量版 | `IELTS-Coach-portable-win64.zip` | 1379 MB |
| 分体版 | `IELTS-Coach-app.zip` + `IELTS-Coach-models-large.zip` | 623 MB + 1658 MB |

### 完整版为什么用分卷

完整内容（distil-large-v3 + Kokoro + int8 发音模型 + 运行时）压缩后 **2339 MB**，
超过 GitHub 单文件 2 GB。分卷不改变"一个包"的体验：

```bat
copy /b IELTS-Coach-full.zip.001+IELTS-Coach-full.zip.002 IELTS-Coach-full.zip
tar -xf IELTS-Coach-full.zip
```

这两条命令 Windows 10/11 都自带（`tar.exe` 是 bsdtar，认 zip），
所以 `合并并解压.bat` 双击即可，不需要装 7-Zip 或 WinRAR。
构建脚本会做 SHA-256 合并校验，确保分卷没传坏。

## 两种发布形态

| 附件 | 大小 | 内容 |
| :--- | :--- | :--- |
| `IELTS-Coach-portable-win64.zip` | 1379 MB | 一个包全都有（small.en） |
| `IELTS-Coach-app.zip` | 623 MB | 程序 + 运行时 + 发音模型 int8 + VAD |
| `IELTS-Coach-models-large.zip` | 1658 MB | `distil-large-v3` + Kokoro |

分体版用法：两个 zip **解压到同一个文件夹**，目录会长成

```text
IELTS-Coach/
├── app/  python/  models/{gop-int8,vad}/   ← app.zip
├── models/hf/…                            ← models-large.zip
└── 启动口语教练.bat
```

根启动器会检查 `models/gop-int8/config.json` 是否存在，缺了就提示先解压模型包。

构建：
```bash
python scripts/prepare_models.py                 # 单文件包用的模型
python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-distil-whisper-large-v3', cache_dir='models-large/hf')"
python scripts/build_portable.py --with-models   # 单文件包
python scripts/build_split.py                    # 分体包
```

## 构建

```bash
python scripts/build_portable.py        # 产出 dist/IELTS-Coach-portable-win64.zip
python scripts/verify_portable.py       # 解压到临时目录，用内嵌解释器做冒烟测试
```

构建过程：
1. 下载 embeddable Python 并修正 `python312._pth`（加入 `..\app` 与 `Lib\site-packages`，开启 `import site`）
2. get-pip 引导 pip
3. 先装 **CPU 版 torch/torchaudio**（`download.pytorch.org/whl/cpu`），体积从 3.84 GB 降到约 250 MB
4. 再装 `.[models,phase2]`
5. 复制源码 + 已构建的前端（`daemon/static`）
6. 用内嵌解释器做 import 冒烟测试，通过才打包

## 依赖坑记录

- `ctc-forced-aligner` 没有 Windows wheel，源码编译需要 MSVC；代码里其实从未 import
  （强制对齐用的是 `torchaudio.functional.forced_align` + numpy Viterbi 兜底），已从 extras 移除
- `espeak-ng` 在便携版里由 `espeakng_loader` 提供 DLL 与数据，无需用户安装
  （`daemon/config.py::find_espeak_library` 优先用内嵌副本）

## 发布

打 tag 即可触发 `.github/workflows/release.yml`：

```bash
git tag v1.0.0
git push origin v1.0.0
```

Action 会自动构建 zip 并挂到 Release。

## macOS / Linux

暂未提供便携包（PyInstaller 或 GTK/WebKit 依赖处理方式不同）。
这两个平台目前走开发者方式：`bash setup.sh`，需要系统 Python 3.11+ 与 espeak-ng。
