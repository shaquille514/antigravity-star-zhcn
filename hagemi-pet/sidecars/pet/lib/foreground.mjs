// 前台客户端窗口探测模块：识别当前聚焦窗口是否为 Claude / Codex / Cherry Studio 客户端，
// 并结合 Antigravity 窗口矩形计算哈基米当前位置是否被遮挡，仅在变更时向上层通知状态。
import { spawn } from 'node:child_process';

const SELF_PROCESS_RE = /^(?:antigravity|hagemi|dream[-_]?skin|cat[-_]?widget)(?:\.exe)?$/i;
const SELF_TITLE_RE = /\bantigravity\b|星语汉化|dream\s*skin/i;

const CLAUDE_PROCESS_RE = /^claude(?:[-_\s.]?(?:desktop|app|code))?(?:\.exe)?$/i;
const CODEX_PROCESS_RE = /^(?:openai[-_\s]?)?codex(?:[-_\s.]?(?:desktop|app|cli))?(?:\.exe)?$/i;
const CODEX_PACKAGE_RE = /[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/i;
const CHERRY_PROCESS_RE = /^cherry[-_\s]?studio(?:\.exe)?$/i;
const CHERRY_WINDOW_RE = /^(?:cherry\s*studio(?:\s*[-–|]\s*.*)?|.*\s[-–|]\s*cherry\s*studio)$/i;

const TERMINAL_PROCESS_RE = /^(?:windowsterminal|wt|powershell|pwsh|cmd|conhost|mintty|alacritty|wezterm(?:-gui)?|kitty|iterm2|terminal|gnome-terminal|konsole|warp|tabby|hyper|code|cursor)(?:\.exe)?$/i;
const BROWSER_CONTAINER_RE = /^(?:chrome|msedge|brave|firefox|opera|vivaldi|arc|msedgewebview2|electron|applicationframehost)(?:\.exe)?$/i;

// 浏览器普通浏览页面常见网站词（避免看视频/搜资料/看仓库时误判为正在使用客户端）
const NOISE_WEB_TITLE_RE = /\b(?:youtube|bilibili|github|gitlab|reddit|zhihu|stackoverflow|wikipedia|google\s+search|bing)\b|哔哩哔哩|知乎|教程/i;

const TERMINAL_CLAUDE_RE = /(?:^|[\s|/\\:\-\u2733*])claude(?:\s+code)?(?=$|[\s|/\\:\-])/i;
const TERMINAL_CODEX_RE = /(?:^|[\s|/\\:\-])codex(?=$|[\s|/\\:\-])/i;

const WEB_APP_CLAUDE_RE = /^(?:claude(?:\s+code)?(?:\s*[-–|]\s*.*)?|.*\s[-–|]\s*claude(?:\s+code)?(?:\s*\(\d+\))?)$/i;
const WEB_APP_CODEX_RE = /^(?:(?:openai\s+)?codex(?:\s*[-–|]\s*.*)?|.*\s[-–|]\s*(?:openai\s+)?codex)$/i;

/**
 * 判断当前进程名与窗口标题是否属于 Antigravity 自身或本套件窗体。
 */
export function isHostProcess(processName = '', title = '', processPath = '') {
  const proc = String(processName || '').trim();
  const winTitle = String(title || '').trim();
  if (/^antigravity(?:\.exe)?$/i.test(proc)) return true;
  if (SELF_PROCESS_RE.test(proc)) return true;
  if (CODEX_PACKAGE_RE.test(String(processPath))) return false;
  if (CLAUDE_PROCESS_RE.test(proc) || CODEX_PROCESS_RE.test(proc) || CHERRY_PROCESS_RE.test(proc)) return false;
  if (/\bantigravity\b/i.test(winTitle)) return true;
  return false;
}

/**
 * 识别当前前台客户端，返回 `'claude' | 'codex' | 'cherry' | null`。
 */
export function detectRivalApp({ processName = '', title = '', processPath = '' } = {}) {
  const proc = String(processName || '').trim();
  const winTitle = String(title || '').trim();
  if (!proc && !winTitle) return null;

  // 绝不误伤 Antigravity 宿主或本套件自有面板
  if (SELF_PROCESS_RE.test(proc)) return null;

  // 1. 独立客户端进程名直接命中（最高置信度）
  if (CLAUDE_PROCESS_RE.test(proc)) return 'claude';
  if (CODEX_PROCESS_RE.test(proc)) return 'codex';
  if (CODEX_PACKAGE_RE.test(String(processPath))) return 'codex';
  if (CHERRY_PROCESS_RE.test(proc)) return 'cherry';
  if (SELF_TITLE_RE.test(winTitle)) return null;

  // Cherry 的开发版可能使用通用 Electron 进程；普通浏览器里的官网/教程不触发。
  if (/^electron(?:\.exe)?$/i.test(proc) && !NOISE_WEB_TITLE_RE.test(winTitle) && CHERRY_WINDOW_RE.test(winTitle)) return 'cherry';

  // 2. 终端宿主内运行了 Claude Code / Codex CLI（以标题关键字区分）
  if (TERMINAL_PROCESS_RE.test(proc)) {
    if (TERMINAL_CODEX_RE.test(winTitle)) return 'codex';
    if (TERMINAL_CLAUDE_RE.test(winTitle)) return 'claude';
    return null;
  }

  // 3. 浏览器或 Electron/WebView2 封装客户端窗口
  if (BROWSER_CONTAINER_RE.test(proc) && !NOISE_WEB_TITLE_RE.test(winTitle)) {
    if (WEB_APP_CODEX_RE.test(winTitle)) return 'codex';
    if (WEB_APP_CLAUDE_RE.test(winTitle)) return 'claude';
  }

  return null;
}

/**
 * 根据前景窗口矩形与 Antigravity 窗口矩形判断桌宠所在位置是否被遮挡（或宿主已最小化）。
 */
export function isPetOccluded({ fgRect = null, agyRect = null, agyMinimized = false } = {}, position = null) {
  if (agyMinimized || !agyRect) return true;
  const agyWidth = (agyRect.right ?? 0) - (agyRect.left ?? 0);
  const agyHeight = (agyRect.bottom ?? 0) - (agyRect.top ?? 0);
  if (agyWidth <= 0 || agyHeight <= 0) return true;
  if (!fgRect) return false;

  // 哈基米默认停靠在宿主窗口右下区域，若有保存比例位置则追踪该参考点
  const ratioX = Number.isFinite(position?.x) ? Math.min(0.95, Math.max(0.05, position.x)) : 0.88;
  const ratioY = Number.isFinite(position?.y) ? Math.min(0.95, Math.max(0.05, position.y)) : 0.85;
  const petCenterX = agyRect.left + agyWidth * ratioX;
  const petCenterY = agyRect.top + agyHeight * ratioY;

  return (
    petCenterX >= fgRect.left &&
    petCenterX <= fgRect.right &&
    petCenterY >= fgRect.top &&
    petCenterY <= fgRect.bottom
  );
}

export function buildWindowsProbeScript(parentPid, pollMs) {
  const safePid = Math.max(1, Math.floor(parentPid));
  const safePoll = Math.max(250, Math.min(5000, Math.floor(pollMs)));
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    `$parentPid = ${safePid}`,
    `$pollMs = ${safePoll}`,
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    '',
    'namespace HagemiForegroundProbe {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  public struct RECT { public int Left, Top, Right, Bottom; }',
    '  public sealed class BoxRect { public int left, top, right, bottom; }',
    '  public sealed class Snap {',
    '    public uint pid;',
    '    public string processName;',
    '    public string processPath;',
    '    public string title;',
    '    public BoxRect fgRect;',
    '    public BoxRect agyRect;',
    '    public bool agyMinimized;',
    '  }',
    '',
    '  public static class Win {',
    '    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);',
    '    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '',
    '    static Win() { try { SetProcessDPIAware(); } catch {} }',
    '',
    '    private static BoxRect ToBox(RECT r) {',
    '      return new BoxRect { left = r.Left, top = r.Top, right = r.Right, bottom = r.Bottom };',
    '    }',
    '',
    '    public static string ReadTitle(IntPtr hWnd) {',
    '      if (hWnd == IntPtr.Zero) return "";',
    '      int len = GetWindowTextLengthW(hWnd);',
    '      if (len <= 0) return "";',
    '      var sb = new StringBuilder(Math.Min(len + 1, 512));',
    '      GetWindowTextW(hWnd, sb, sb.Capacity);',
    '      return sb.ToString();',
    '    }',
    '',
    '    public static string ReadProc(uint pid) {',
    '      if (pid == 0) return "";',
    '      try { using (var p = Process.GetProcessById((int)pid)) return p.ProcessName ?? ""; }',
    '      catch { return ""; }',
    '    }',
    '',
    '    public static Snap Snapshot() {',
    '      IntPtr fg = GetForegroundWindow();',
    '      uint fgPid = 0;',
    '      if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);',
    '      RECT fgR = new RECT();',
    '      bool hasFg = fg != IntPtr.Zero && GetWindowRect(fg, out fgR);',
    '',
    '      IntPtr best = IntPtr.Zero;',
    '      long bestArea = -1;',
    '      bool anyMin = false;',
    '      RECT bestR = new RECT();',
    '      EnumWindows(delegate(IntPtr w, IntPtr data) {',
    '        if (!IsWindowVisible(w)) return true;',
    '        uint pid = 0;',
    '        GetWindowThreadProcessId(w, out pid);',
    '        if (!string.Equals(ReadProc(pid), "Antigravity", StringComparison.OrdinalIgnoreCase)) return true;',
    '        RECT r;',
    '        if (!GetWindowRect(w, out r)) return true;',
    '        if (IsIconic(w)) { anyMin = true; return true; }',
    '        long area = (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);',
    '        if (area >= 360 * 200 && area > bestArea) { bestArea = area; best = w; bestR = r; }',
    '        return true;',
    '      }, IntPtr.Zero);',
    '',
    '      return new Snap {',
    '        pid = fgPid,',
    '        processName = ReadProc(fgPid),',
    '        processPath = ReadPath(fgPid),',
    '        title = ReadTitle(fg),',
    '        fgRect = hasFg ? ToBox(fgR) : null,',
    '        agyRect = best != IntPtr.Zero ? ToBox(bestR) : null,',
    '        agyMinimized = (best == IntPtr.Zero && anyMin)',
    '      };',
    '    }',
    '    public static string ReadPath(uint pid) {',
    '      if (pid == 0) return "";',
    '      try { using (var p = Process.GetProcessById((int)pid)) return p.MainModule.FileName ?? ""; }',
    '      catch { return ""; }',
    '    }',
    '  }',
    '}',
    "'@",
    '$prev = ""',
    'while ($true) {',
    '  try { $null = [System.Diagnostics.Process]::GetProcessById($parentPid) } catch { break }',
    '  $snap = [HagemiForegroundProbe.Win]::Snapshot() | ConvertTo-Json -Compress',
    '  if ($snap -and $snap -ne $prev) {',
    '    $prev = $snap',
    '    [Console]::Out.WriteLine($snap)',
    '    [Console]::Out.Flush()',
    '  }',
    '  [System.Threading.Thread]::Sleep($pollMs)',
    '}',
  ].join('\n');
}

export class ForegroundWatcher {
  constructor({
    pollMs = 600,
    platform = process.platform,
    parentPid = process.pid,
    spawnFn = spawn,
    getPosition = () => null,
    onChange = () => {},
    onError = () => {},
    log = () => {},
  } = {}) {
    Object.assign(this, { pollMs, platform, parentPid, spawnFn, getPosition, onChange, onError, log });
    this.child = null;
    this.stopped = false;
    this.buffer = '';
    this.lastState = null;
  }

  start() {
    if (this.stopped || this.child || this.platform !== 'win32') return false;
    try {
      const encoded = Buffer.from(buildWindowsProbeScript(this.parentPid, this.pollMs), 'utf16le').toString('base64');
      const child = this.spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      let errTail = '';
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', chunk => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) this.processLine(line);
        }
      });
      child.stderr?.on('data', chunk => {
        errTail = (errTail + chunk.toString('utf8')).slice(-400);
      });
      child.on('error', error => {
        this.onError(error);
        this.log(`foreground probe error: ${error.message}`);
      });
      child.on('exit', code => {
        this.child = null;
        if (!this.stopped && code && errTail.trim()) {
          this.log(`foreground probe exited (${code}): ${errTail.trim()}`);
        }
      });
      return true;
    } catch (error) {
      this.onError(error);
      this.log(`foreground probe unavailable: ${error.message}`);
      return false;
    }
  }

  processLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
    const processName = String(parsed?.processName || '');
    const title = String(parsed?.title || '');
    const processPath = String(parsed?.processPath || '');
    const app = detectRivalApp({ processName, title, processPath });
    const isHost = isHostProcess(processName, title, processPath);
    const occluded = app ? isPetOccluded(parsed, this.getPosition?.()) : false;
    const next = {
      app,
      isHost,
      occluded,
      pid: Number(parsed?.pid) || 0,
      processName,
      title,
    };
    const sig = `${next.app || ''}|${next.isHost ? 1 : 0}|${next.occluded ? 1 : 0}`;
    const prevSig = this.lastState
      ? `${this.lastState.app || ''}|${this.lastState.isHost ? 1 : 0}|${this.lastState.occluded ? 1 : 0}`
      : null;
    this.lastState = next;
    if (sig !== prevSig) {
      this.onChange(next);
    }
    return next;
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }
}
