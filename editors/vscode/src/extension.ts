import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

let panel: vscode.WebviewPanel | null = null
let statusBar: vscode.StatusBarItem | null = null
let healthTimer: NodeJS.Timeout | null = null

function config() {
  const cfg = vscode.workspace.getConfiguration('ieltsCoach')
  return {
    port: cfg.get<number>('port', 8765),
    pythonPath: cfg.get<string>('pythonPath', ''),
    projectRoot: cfg.get<string>('projectRoot', ''),
  }
}

function baseUrl(): string {
  return 'http://127.0.0.1:' + config().port
}

/** Detect the project root: configured, workspace folder, then known defaults. */
function projectRoot(): string | null {
  const configured = config().projectRoot
  if (configured && fs.existsSync(configured)) return configured
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (fs.existsSync(path.join(folder.uri.fsPath, 'daemon', 'main.py'))) return folder.uri.fsPath
  }
  for (const guess of ['E:/雅思口语插件开发', 'D:/Projects/ielts-coach-plugin']) {
    if (fs.existsSync(path.join(guess, 'daemon', 'main.py'))) return guess
  }
  return null
}

function pythonPath(): string | null {
  const configured = config().pythonPath
  if (configured && fs.existsSync(configured)) return configured
  const root = projectRoot()
  if (!root) return null
  const venv =
    process.platform === 'win32'
      ? path.join(root, '.venv', 'Scripts', 'python.exe')
      : path.join(root, '.venv', 'bin', 'python')
  return fs.existsSync(venv) ? venv : null
}

function ping(timeoutMs = 1200): Promise<any | null> {
  return new Promise((resolve) => {
    const request = http.get(baseUrl() + '/health', { timeout: timeoutMs }, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    request.on('error', () => resolve(null))
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
  })
}

function updateStatusBar(health: any | null) {
  if (!statusBar) return
  if (health) {
    statusBar.text = '$(mic) 雅思口语'
    statusBar.tooltip = 'IELTS Coach 已就绪 · ' + (health.device_name ?? '') + ' · TTS ' + (health.models?.tts?.engine ?? '?')
    statusBar.backgroundColor = undefined
  } else {
    statusBar.text = '$(debug-disconnect) 雅思口语'
    statusBar.tooltip = '守护进程未运行，点击启动'
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  }
}

async function refreshHealth() {
  updateStatusBar(await ping())
}

function startHealthLoop(context: vscode.ExtensionContext) {
  if (healthTimer) clearInterval(healthTimer)
  healthTimer = setInterval(() => void refreshHealth(), 15000)
  context.subscriptions.push({ dispose: () => { if (healthTimer) clearInterval(healthTimer) } })
}

function offlineHtml(): string {
  return [
    '<!doctype html><html><body style="font-family:system-ui;padding:26px;color:#8a93a8;background:#141b2e">',
    '<h2 style="font-weight:600;color:#e6ebf7">本地守护进程未运行</h2>',
    '<p>IELTS Coach 需要本机 ' + config().port + ' 端口上的守护进程。</p>',
    '<ol><li>点击下方按钮启动；或</li>',
    '<li>在项目目录执行 <code>.venv\\Scripts\\python.exe -m daemon.main</code>。</li></ol>',
    '<button id="start" style="padding:9px 16px;border-radius:9px;border:1px solid #4f7cf5;',
    'background:rgba(79,124,245,.18);color:#dbe6ff;cursor:pointer">启动守护进程</button>',
    '<script>const api = acquireVsCodeApi();',
    'document.getElementById("start").addEventListener("click", () => api.postMessage({type:"start"}));',
    '</script></body></html>',
  ].join('')
}

function webviewHtml(url: string, health: any | null): string {
  if (!health) return offlineHtml()
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src http: https: data:',
    'frame-src http://127.0.0.1:* http://localhost:*',
    "script-src 'unsafe-inline'",
  ].join('; ')
  return [
    '<!doctype html><html><head><meta charset="utf-8" />',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '" />',
    '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0b1020}',
    'iframe{border:0;width:100%;height:100%;display:block}</style></head><body>',
    '<iframe src="' + url + '" allow="microphone http://127.0.0.1:*; autoplay http://127.0.0.1:*; clipboard-write"></iframe>',
    // The page asks for a real browser tab when the webview sandbox blocks the mic;
    // forward that request to the extension.
    '<script>(function () {',
    '  var vscode = acquireVsCodeApi();',
    "  window.addEventListener('message', function (event) {",
    '    var data = event.data;',
    "    if (data && data.type === 'ielts-coach:open-external' && data.url) {",
    "      vscode.postMessage({ type: 'ielts-coach:open-external', url: data.url });",
    '    }',
    '  });',
    '})();</script>',
    '</body></html>',
  ].join('')
}

async function renderPanel(current: vscode.WebviewPanel) {
  const health = await ping()
  updateStatusBar(health)
  current.webview.html = webviewHtml(baseUrl() + '/?embed=1', health)
}

function openPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true)
    void renderPanel(panel)
    return
  }
  panel = vscode.window.createWebviewPanel(
    'ieltsCoach',
    'IELTS 口语教练',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  )
  panel.onDidDispose(() => {
    panel = null
  })
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === 'start') {
      startDaemon(context)
      setTimeout(() => { if (panel) void renderPanel(panel) }, 2500)
    }
    if (message?.type === 'ielts-coach:open-external' && typeof message.url === 'string') {
      // Mirrors the embedded page: opened here because the webview cannot grant the mic.
      void vscode.env.openExternal(vscode.Uri.parse(message.url))
    }
  })
  void renderPanel(panel)
}

function startDaemon(context: vscode.ExtensionContext) {
  const python = pythonPath()
  const root = projectRoot()
  if (!python || !root) {
    void vscode.window.showErrorMessage('找不到项目目录或 .venv Python，请设置 ieltsCoach.projectRoot / pythonPath。')
    return
  }
  const out = vscode.window.createOutputChannel('IELTS Coach')
  out.show(true)
  const child = spawn(python, ['-m', 'daemon.main'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  child.stdout?.on('data', (data) => out.append(String(data)))
  child.stderr?.on('data', (data) => out.append(String(data)))
  child.unref()
  void vscode.window.showInformationMessage('IELTS 守护进程已启动，模型预热约需 15 秒。')
  setTimeout(() => void refreshHealth(), 3000)
}

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusBar.command = 'ieltsCoach.openPanel'
  statusBar.text = '$(mic) 雅思口语'
  statusBar.tooltip = '打开 IELTS 口语教练'
  statusBar.show()
  context.subscriptions.push(statusBar)

  context.subscriptions.push(
    vscode.commands.registerCommand('ieltsCoach.openPanel', () => openPanel(context)),
    vscode.commands.registerCommand('ieltsCoach.openInBrowser', () =>
      vscode.env.openExternal(vscode.Uri.parse(baseUrl() + '/')),
    ),
    vscode.commands.registerCommand('ieltsCoach.startDaemon', () => startDaemon(context)),
    vscode.commands.registerCommand('ieltsCoach.showStatus', async () => {
      const health = await ping()
      updateStatusBar(health)
      if (!health) {
        const pick = await vscode.window.showWarningMessage('守护进程未运行。', '启动')
        if (pick === '启动') startDaemon(context)
        return
      }
      const models = health.models ?? {}
      void vscode.window.showInformationMessage(
        'IELTS Coach ' + health.version + ' · ' + health.device_name +
          ' · ASR ' + (models.asr?.ok ? 'ok' : 'x') +
          ' · TTS ' + (models.tts?.engine ?? '?') +
          ' · 发音 ' + (models.pronounce?.ok ? 'ok' : 'x'),
      )
    }),
  )

  void refreshHealth()
  startHealthLoop(context)
}

export function deactivate() {
  if (healthTimer) clearInterval(healthTimer)
  panel = null
}
