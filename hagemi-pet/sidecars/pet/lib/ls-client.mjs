// Talks to Antigravity's local language server. Sidecars get its address and CSRF token from
// the host through the environment; outside a sidecar (npm run dev) they are discovered from the
// running process. The token stays in memory and is never logged, stored or sent to a page.
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const DEFAULT_DISCOVER_BACKOFF_MS = [5000, 10000, 20000, 30000];
const INVALIDATING_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

/**
 * 构造带有 ETIMEDOUT 错误码的请求超时异常，供上层识别并清理失效端点缓存。
 * @param {string} method 调用的 LanguageServer 方法名。
 * @returns {Error} 携带 code='ETIMEDOUT' 的 Error 实例。
 */
function createTimeoutError(method) {
  const error = new Error(`${method} timed out`);
  error.code = 'ETIMEDOUT';
  return error;
}

/**
 * 判断错误是否意味着缓存的 LanguageServer 端点已失效（鉴权过期、连接拒绝/重置或请求超时）。
 * @param {unknown} error 请求抛出的异常对象。
 * @returns {boolean} 是否需要清除本地端点缓存。
 */
function isEndpointInvalidatingError(error) {
  return Boolean(error && (error.status === 401 || INVALIDATING_ERROR_CODES.has(error.code)));
}

/**
 * 规范化探测退避序列配置。
 * @param {number[] | undefined} backoffMs 自定义退避毫秒序列。
 * @returns {number[]} 有效的退避时间序列。
 */
function normalizeBackoff(backoffMs) {
  if (Array.isArray(backoffMs)) return backoffMs.map(ms => Math.max(0, Number(ms) || 0));
  return DEFAULT_DISCOVER_BACKOFF_MS;
}

function post(host, port, csrf, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({
      hostname: host, port, method: 'POST', path: SERVICE + method,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf, 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const error = new Error(`${method} returned ${res.statusCode}`);
          error.status = res.statusCode;
          reject(error);
          return;
        }
        try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error(`${method} returned malformed JSON`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(createTimeoutError(method)));
    req.end(data);
  });
}

async function discover() {
  const platform = process.platform;
  let rows = [];
  if (platform === 'win32') {
    const script = "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId,CommandLine); @{rows=$rows;appRunning=[bool](Get-Process -Name Antigravity -ErrorAction SilentlyContinue)} | ConvertTo-Json -Compress -Depth 4";
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 });
    const info = stdout.trim() ? JSON.parse(stdout) : {};
    rows = (info.rows || []).map(r => ({ pid: r.ProcessId, command: r.CommandLine || '' }));
    if (!rows.some(row => /--standalone\b/.test(row.command)) && info.appRunning) {
      const state = JSON.parse(await readFile(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'wsl_state.json'), 'utf8'));
      if (state.distro) {
        const bridge = join(dirname(fileURLToPath(import.meta.url)), '..', 'windows-bridge.py');
        const drive = bridge.match(/^([a-z]):[\\/](.*)$/i);
        if (!drive) throw new Error('WSL discovery requires a local Windows installation');
        const linuxBridge = `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
        // The endpoint/token travel only through this private child-process pipe.
        const probe = "import runpy,json,sys; endpoint=runpy.run_path(sys.argv[1])['discover_language_server'](); print(json.dumps({'host':'127.0.0.1','port':int(endpoint[0].rsplit(':',1)[1]),'csrf':endpoint[1]}) if endpoint else '{}')";
        const result = await exec('wsl.exe', ['-d', state.distro, '--exec', 'python3', '-c', probe, linuxBridge], { windowsHide: true, timeout: 12000, maxBuffer: 1 << 16 });
        const endpoint = JSON.parse(result.stdout);
        if (!Number.isInteger(endpoint.port) || !endpoint.csrf) throw new Error('WSL language server is unavailable');
        await post(endpoint.host, endpoint.port, endpoint.csrf, 'GetStatus', {}, 2500);
        return endpoint;
      }
    }
  } else {
    const { stdout } = await exec('ps', ['-ww', '-axo', 'pid=,args='], { timeout: 8000, maxBuffer: 1 << 22 });
    rows = stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), command: m[2] })).filter(r => /language_server/.test(r.command));
  }
  const row = rows.find(r => /--standalone\b/.test(r.command));
  if (!row) throw new Error('Antigravity is not running');
  const csrf = row.command.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (!csrf) throw new Error('Language server exposes no CSRF token');
  const listing = platform === 'win32'
    ? (await exec('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 22 })).stdout
    : (await exec('lsof', ['-nP', '-a', '-p', String(row.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 5000 })).stdout;
  const ports = platform === 'win32'
    ? [...listing.matchAll(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+\S+\s+(\d+)/g)].filter(m => Number(m[2]) === row.pid).map(m => Number(m[1]))
    : [...listing.matchAll(/:(\d+)\s*$/gm)].map(m => Number(m[1]));
  for (const port of new Set(ports)) {
    try {
      await post('127.0.0.1', port, csrf, 'GetStatus', {}, 2500);
      return { host: '127.0.0.1', port, csrf };
    } catch { /* The TLS and extension ports reject this; keep looking. */ }
  }
  throw new Error('Language server port not found');
}

export class LanguageServer {
  /**
   * 创建 LanguageServer 客户端实例。
   * @param {object} [options] 客户端配置项。
   * @param {NodeJS.ProcessEnv} [options.env=process.env] 环境变量对象。
   * @param {Function} [options.discoverFn=discover] 本地进程端点探测函数。
   * @param {Function} [options.transport=post] HTTP 请求发送函数。
   * @param {() => number} [options.now=Date.now] 当前时间戳读取函数（支持测试注入虚拟时钟）。
   * @param {number[]} [options.discoverBackoffMs] 探测失败后的递增退避毫秒序列。
   */
  constructor({
    env = process.env,
    discoverFn = discover,
    transport = post,
    now = Date.now,
    discoverBackoffMs,
  } = {}) {
    this.transport = transport;
    this.discoverFn = discoverFn;
    this.now = typeof now === 'function' ? now : Date.now;
    this.discoverBackoffMs = normalizeBackoff(discoverBackoffMs);
    this.endpoint = null;
    this.discoveryPromise = null;
    this.discoverFailures = 0;
    this.discoverRetryAt = 0;
    this.lastDiscoverError = null;
    const address = env.ANTIGRAVITY_LS_ADDRESS, csrf = env.ANTIGRAVITY_CSRF_TOKEN;
    if (address && csrf) {
      const index = address.lastIndexOf(':');
      this.endpoint = { host: address.slice(0, index) || '127.0.0.1', port: Number(address.slice(index + 1)), csrf };
      this.fromHost = true;
    }
  }

  /**
   * 根据连续探测失败次数返回本次冷却退避时长（毫秒）。
   * @returns {number} 退避等待毫秒数。
   */
  nextBackoffMs() {
    if (!this.discoverBackoffMs.length) return 0;
    const index = Math.min(this.discoverFailures, this.discoverBackoffMs.length - 1);
    return this.discoverBackoffMs[index];
  }

  /**
   * 执行单次端点探测并更新退避状态；成功时立即清零退避计数与冷却窗口。
   * @returns {Promise<{host: string, port: number, csrf: string}>} 探测到的端点信息。
   */
  async runDiscovery() {
    try {
      const endpoint = await this.discoverFn();
      this.endpoint = endpoint;
      this.discoverFailures = 0;
      this.discoverRetryAt = 0;
      this.lastDiscoverError = null;
      return endpoint;
    } catch (error) {
      const discoverError = error instanceof Error ? error : new Error(String(error));
      const delayMs = this.nextBackoffMs();
      this.discoverFailures += 1;
      this.discoverRetryAt = this.now() + delayMs;
      this.lastDiscoverError = discoverError;
      throw discoverError;
    }
  }

  /**
   * 获取缓存端点或在非冷却期内触发探测；并发请求共享同一次探测 Promise。
   * @returns {Promise<{host: string, port: number, csrf: string}>} 可用的端点信息。
   */
  async ensureEndpoint() {
    if (this.endpoint) return this.endpoint;
    if (!this.discoveryPromise) {
      // 处于失败退避冷却期内直接快速失败，避免轮询周期反复冷启动 powershell.exe / wsl.exe 子进程。
      if ((this.discoverFailures > 0 || this.discoverRetryAt > 0) && this.now() < this.discoverRetryAt) {
        throw this.lastDiscoverError || new Error('Antigravity is not running');
      }
      this.discoveryPromise = this.runDiscovery().finally(() => {
        this.discoveryPromise = null;
      });
    }
    return await this.discoveryPromise;
  }

  /**
   * 调用 LanguageServer 指定方法并在端点失效（含超时）时清理本地缓存。
   * @param {string} method RPC 方法名。
   * @param {object} [body={}] 请求体对象。
   * @param {number} [timeoutMs=12000] 请求超时时间（毫秒）。
   * @returns {Promise<any>} 服务端返回的 JSON 对象。
   */
  async call(method, body = {}, timeoutMs = 12000) {
    const endpoint = await this.ensureEndpoint();
    try {
      return await this.transport(endpoint.host, endpoint.port, endpoint.csrf, method, body, timeoutMs);
    } catch (error) {
      // A language server restart invalidates both the port and the token. The host restarts
      // sidecars when that happens; in dev mode, look again next time.
      if (!this.fromHost && isEndpointInvalidatingError(error)) this.endpoint = null;
      throw error;
    }
  }
}
