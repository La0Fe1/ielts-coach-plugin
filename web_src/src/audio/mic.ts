/**
 * Microphone diagnostics.
 *
 * getUserMedia can fail for reasons that all look identical from the caller's
 * side ("NotAllowedError"), but need completely different fixes:
 *   - the page is embedded in an iframe without allow="microphone"
 *   - the origin was blocked in the site settings
 *   - the OS-level privacy switch (Windows 麦克风隐私) blocks the browser
 *   - the page is not a secure context (http on a LAN IP)
 * This module turns the raw failure into a checklist the user can act on.
 */

export interface MicDiagnosis {
  secureContext: boolean
  inIframe: boolean
  permission: 'granted' | 'denied' | 'prompt' | 'unknown'
  deviceCount: number
  devices: string[]
  hints: string[]
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms)),
  ])
}

export async function diagnoseMic(): Promise<MicDiagnosis> {
  const secureContext = window.isSecureContext
  const inIframe = window.self !== window.top
  let permission: MicDiagnosis['permission'] = 'unknown'
  try {
    if (navigator.permissions?.query) {
      const status = await withTimeout(
        navigator.permissions.query({ name: 'microphone' as PermissionName }),
        1200,
        null,
      )
      if (status) permission = status.state as MicDiagnosis['permission']
    }
  } catch {
    permission = 'unknown'
  }
  let devices: string[] = []
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const listed = await withTimeout(navigator.mediaDevices.enumerateDevices(), 1200, [])
      devices = (listed || [])
        .filter((device) => device.kind === 'audioinput')
        .map((device) => device.label || '(未授权，名称不可见)')
    }
  } catch {
    devices = []
  }

  const hints: string[] = []
  if (!secureContext) {
    hints.push('当前页面不是安全上下文：请用 http://127.0.0.1:8765 或 localhost 打开，不要用局域网 IP。')
  }
  if (inIframe) {
    hints.push('页面被嵌在 iframe 里：内嵌页面默认不能开麦，请在新标签页直接打开本地址。')
  }
  if (permission === 'denied') {
    hints.push('浏览器已把本站麦克风设为「阻止」：点地址栏左侧的锁/麦克风图标 → 把麦克风改成「允许」→ 刷新本页。')
  }
  if (permission === 'prompt') {
    hints.push('浏览器还没给过权限：点「开始试音」时要在弹窗里选「允许」。')
  }
  if (devices.length === 0) {
    hints.push('没有检测到任何输入设备：检查麦克风是否插好；Windows 设置 → 隐私和安全性 → 麦克风 → 允许桌面应用访问。')
  }
  return { secureContext, inIframe, permission, deviceCount: devices.length, devices, hints }
}

export function explainMicError(error: unknown): string {
  const name = (error as { name?: string })?.name ?? ''
  const message = (error as { message?: string })?.message ?? String(error)
  if (name === 'NotAllowedError' || /permission denied/i.test(message)) {
    return '麦克风权限被拒绝。请看下方诊断结果按提示放行（通常是地址栏左侧的权限图标，或页面被嵌在 iframe 里）。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到麦克风设备：确认设备已连接，或换一个输入设备。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其他程序占用：关掉正在录音的软件（会议/录音机）后重试。'
  }
  if (name === 'SecurityError') {
    return '安全策略拒绝：请用 127.0.0.1 或 localhost 打开，并通过真实浏览器标签页访问。'
  }
  return name ? name + ': ' + message : message
}
