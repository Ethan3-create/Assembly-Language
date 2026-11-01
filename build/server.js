/* ============================================================
 * server.js · 零依赖 HTTP 后端
 *   · 托管前端静态文件（SEA 单文件 exe 时从内嵌资源读取）
 *   · 提供 C ⇄ 汇编 的 HTTP 接口：编译 / 反编译 / 运行 / 检查
 *
 * 直接运行：node build/server.js --port 41730
 * 打包后：  汇编学习台.exe [--port N] [--host 0.0.0.0] [--no-window]
 * ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

/* ---------- 1. 运行时：SEA 内嵌资源 or 磁盘文件 ---------- */
let sea = null;
try { sea = require('node:sea'); } catch (e) { /* 老版本 Node 没有 */ }
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function assetKey(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/* ---------- 存活探测：页面心跳 + 关窗通知 ----------
 * 为什么不靠“浏览器子进程退出”判断：Chrome 在 profile 有残留锁时会启动后立刻退出，
 * 窗口一闪就没；此时服务还活着，页面也刚打开，把它当成“用户关窗”就会直接杀掉服务。
 * 改成由页面自己报活：页面每 15 秒 ping 一次；关窗时用 sendBeacon 发 bye，服务立即退出。
 * 万一 bye 丢了，90 秒没有心跳也会退出，不会留僵尸进程。 */
let lastSeen = 0;
let windowMode = false;
let byeAt = 0;

function markAlive() { lastSeen = Date.now(); }

/** 收到关窗通知：等 3 秒再退。刷新页面也会发 bye，但新页面会立刻 ping 过来，那样就撤销 */
function scheduleByeExit() {
  byeAt = Date.now();
  const mark = byeAt;
  setTimeout(() => {
    if (byeAt !== mark) return;              // 已经处理过
    byeAt = 0;
    if (lastSeen >= mark) { log('关窗通知后仍有心跳，判断为刷新页面，继续运行'); return; }
    if (typeof onBye === 'function') onBye();
  }, 5000);
}

/* ---------- 1.5 输出通道：GUI 子系统下没有控制台，改用日志 + 弹窗 ---------- */
const APP_DIR = IS_SEA ? path.dirname(process.execPath) : ROOT;

/** 写一行日志；没有控制台时静默失败（GUI 版 exe 的 stdout 是无效句柄） */
function say(s) {
  try { process.stdout.write(s); } catch (e) { /* GUI 模式没有控制台 */ }
}

/** 出错时让用户看得见：优先写日志文件，再弹一个系统提示框 */
function notify(title, msg) {
  try {
    fs.appendFileSync(path.join(APP_DIR, 'asm-studio-error.log'),
      '[' + new Date().toISOString() + '] ' + title + '：' + msg + '\r\n', 'utf8');
  } catch (e) { }
  say(title + '：' + msg + '\n');
  // mshta 是 Windows 自带的，比拉起 PowerShell 快得多
  const esc = s => String(s).replace(/['"\\\r\n]/g, ' ');
  try {
    spawn('mshta', ['javascript:alert("' + esc(title + '\\n\\n' + msg + '\\n\\n详细日志：asm-studio-error.log') + '");close()'],
      { stdio: 'ignore', windowsHide: false }).unref();
  } catch (e) { }
}

/* 运行日志：GUI 版看不到控制台，出问题时靠它复盘（放在 temp，不弄脏程序目录） */
const LOG_FILE = path.join(os.tmpdir(), 'asm-studio.log');
function log(s) {
  try {
    const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + s + '\r\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) { }
}

/** 读静态资源：打包后走内嵌资源，开发时走磁盘 */
function readAsset(p) {
  const key = assetKey(p);
  if (IS_SEA) {
    try {
      // getAsset() 不带编码时返回 ArrayBuffer（没有 .length），统一转成 Buffer
      const a = sea.getAsset(key);
      if (a == null) return null;
      if (typeof a === 'string') return Buffer.from(a, 'utf8');
      if (Buffer.isBuffer(a)) return a;
      if (a instanceof ArrayBuffer) return Buffer.from(a);
      if (ArrayBuffer.isView(a)) return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
      return null;
    } catch (e) { return null; }
  }
  const full = path.join(ROOT, key);
  if (!full.startsWith(ROOT)) return null;
  try { return fs.readFileSync(full); } catch (e) { return null; }
}

/* ---------- 2. 计算模块（与前端同一份源码） ---------- */
const D = require('../js/data.js');
const VM = require('../js/vm.js');
const C2 = require('../js/c2asm.js');
const DEC = require('../js/decompile.js');
const AN = require('../js/analyze.js');
const DIAG = require('../js/diagnose.js');

/* ---------- 3. 业务函数 ---------- */
function varMapIndex(varMap) {
  const byFunc = new Map();
  (varMap || []).forEach(v => {
    if (!byFunc.has(v.func)) byFunc.set(v.func, { names: new Map(), types: new Map(), sizes: new Map() });
    const e = byFunc.get(v.func);
    e.names.set(v.offset, v.name); e.types.set(v.offset, v.type); e.sizes.set(v.offset, v.size);
  });
  return byFunc;
}

function apiCompile(src) {
  const r = C2.compile(String(src || ''));
  if (!r.ok) return { ok: false, error: r.error, asm: '', issues: [] };
  const prog = VM.assemble(r.asm);
  const dg = DIAG.check(prog, { srcText: r.asm, varMapRaw: r.varMap });
  let ast = null;
  try { ast = JSON.parse(JSON.stringify(r.ast || null)); } catch (e) { ast = null; }
  return {
    ok: true, asm: r.asm, varMap: r.varMap || [], ast: ast,
    instructionCount: prog.instrs.length,
    issues: dg.issues, counts: dg.counts
  };
}

function apiDecompile(asmText) {
  const prog = VM.assemble(String(asmText || ''));
  const varMap = new Map();
  prog.instrs.forEach(ins => {
    const m = (ins.comment || '').match(/^\s*int\s+([A-Za-z_]\w*)/);
    if (!m) return;
    ins.ops.forEach(op => {
      if (op.kind === 'mem' && op.base === 'rbp' && (op.disp || 0) < 0) varMap.set(-op.disp, m[1]);
    });
  });
  let dec, decErr = null;
  try { dec = DEC.decompile(prog, { varMap: varMap }); }
  catch (e) { decErr = e.message; dec = { ok: false, code: '', tree: [], vars: [], events: [] }; }
  let stats = null;
  try { stats = AN.analyzeProgram(prog, { dec: dec, varMap: varMap, prog: prog }); } catch (e) { }
  const dg = DIAG.check(prog, { srcText: String(asmText || '') });
  return {
    ok: prog.ok && !decErr,
    code: dec.code || '',
    decompiled: !!dec.ok,
    error: decErr,
    parseErrors: prog.errors,
    instructionCount: prog.instrs.length,
    stats: stats,
    issues: dg.issues, counts: dg.counts
  };
}

function apiRun(payload) {
  let asmText = payload.asm;
  if (!asmText && payload.code) {
    const c = C2.compile(String(payload.code));
    if (!c.ok) return { ok: false, error: 'C 编译失败：' + c.error };
    asmText = c.asm;
  }
  const prog = VM.assemble(String(asmText || ''));
  if (!prog.ok) return { ok: false, error: '汇编失败：' + prog.errors.join('；'), parseErrors: prog.errors };
  const m = new VM.Machine(prog);
  const limit = Math.min(Math.max(Number(payload.maxSteps) || 200000, 1), 2000000);
  let steps = 0;
  while (!m.halted && steps < limit) { m.step(); steps++; }
  return {
    ok: !m.errorMsg,
    error: m.errorMsg || null,
    output: m.output || '',
    steps: steps,
    halted: !!m.halted
  };
}

function apiCheck(payload) {
  const prog = VM.assemble(String(payload.asm || ''));
  const dg = DIAG.check(prog, { srcText: String(payload.asm || ''), varMapRaw: payload.varMap || [] });
  return { ok: true, issues: dg.issues, counts: dg.counts };
}

/* ---------- 4. HTTP ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('请求体过大（上限 4MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const buf = readAsset(p);
  if (!buf) {
    const body = '404 找不到 ' + p;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  res.end(buf);
}

let onBye = null;

const ROUTES = {
  'GET /api/health': async () => ({
    ok: true,
    service: 'asm-studio',
    version: '1.0.0',
    runtime: IS_SEA ? 'sea-exe' : 'node',
    node: process.version,
    instructions: D.INSTRS.length,
    endpoints: ['POST /api/compile', 'POST /api/decompile', 'POST /api/run', 'POST /api/check']
  }),
  // 页面报活：窗口模式下用不上就退出
  'GET /api/ping': async () => {
    const first = !lastSeen;
    markAlive();
    if (first) log('页面已连上（首次心跳）');
    return { ok: true, t: Date.now() };
  },
  // 关窗通知：sendBeacon 打过来，3 秒内没有新心跳才退出（区分“关窗”和“刷新”）
  'POST /api/bye': async () => {
    log('收到关窗/离页通知');
    if (windowMode) scheduleByeExit();
    return { ok: true };
  },
  'POST /api/compile': async (req) => apiCompile((await readBody(req)).code),
  'POST /api/decompile': async (req) => apiDecompile((await readBody(req)).asm),
  'POST /api/run': async (req) => apiRun(await readBody(req)),
  'POST /api/check': async (req) => apiCheck(await readBody(req))
};

function createServer() {
  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    const key = req.method + ' ' + url.split('?')[0];
    const handler = ROUTES[key];
    if (handler) {
      try {
        const out = await handler(req);
        json(res, 200, out);
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
      return;
    }
    if (url.startsWith('/api/')) return json(res, 404, { ok: false, error: '没有这个接口：' + key });
    serveStatic(req, res, url);
  });
}

/* ---------- 5. 打开桌面窗口（浏览器 app 模式） ---------- */
function findBrowser() {
  const cands = [
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { }
  }
  return null;
}

/** 清掉已经死掉的实例留下的 profile 目录
 *  Chrome 遇到残留 SingletonLock 会启动后立刻退出（窗口一闪就没），所以这里宁可多清。 */
function cleanOldProfiles() {
  const base = os.tmpdir();
  let items = [];
  try { items = fs.readdirSync(base); } catch (e) { return; }
  const now = Date.now();
  for (const name of items) {
    const m = /^asm-studio-profile-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (pid === process.pid) continue;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
    const full = path.join(base, name);
    if (alive) {
      // 那个实例还在跑，但目录太老（1 小时以上）说明是 pid 复用的遗留，清掉
      try { if (now - fs.statSync(full).mtimeMs < 3600 * 1000) continue; } catch (e) { continue; }
    }
    try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { }
  }
}

function openWindow(url) {
  const browser = findBrowser();
  if (browser) {
    // 每次都用全新的 profile 目录：宁可多花 1 秒冷启动，也不要被残留锁坑到“窗口一闪就没”
    cleanOldProfiles();
    const profile = path.join(os.tmpdir(), 'asm-studio-profile-' + process.pid);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
    const child = spawn(browser, [
      '--app=' + url,
      '--user-data-dir=' + profile,
      '--window-size=1560,960',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-sync',
      '--disable-features=Translate,msEdgeIdentityFeature'
    ], { detached: false, stdio: 'ignore' });
    child.on('exit', () => {
      // 页面关掉后浏览器进程会退出，顺手把临时 profile 清掉
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { } }, 1500);
    });
    return child;
  }
  // 没有 Edge/Chrome 就退回默认浏览器（会带地址栏）
  const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  child.unref();
  return null;
}

/* ---------- 6. 启动 ---------- */
function parseArgs(argv) {
  const o = { port: 0, host: '127.0.0.1', window: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = parseInt(argv[++i], 10) || 0;
    else if (a === '--host') o.host = argv[++i] || '127.0.0.1';
    else if (a === '--no-window') o.window = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

/** 探测某个端口上是不是本程序已经在跑 */
function probeExisting(port) {
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { const j = JSON.parse(d); fin(!!(j && j.service === 'asm-studio')); }
          catch (e) { fin(false); }
        });
      });
      req.on('error', () => fin(false));
      req.on('timeout', () => { req.destroy(); fin(false); });
    } catch (e) { fin(false); }
  });
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  log('=== 启动 pid=' + process.pid + ' 参数=' + JSON.stringify(process.argv.slice(2)));
  if (opt.help) {
    say(
      '汇编学习台 v1.0.0\n' +
      '  --port N        指定端口（默认自动选 41730 附近可用的端口）\n' +
      '  --host H        监听地址，默认 127.0.0.1；要让局域网同事访问用 0.0.0.0\n' +
      '  --no-window     只启动服务，不弹窗口（配合 --host 0.0.0.0 部署）\n' +
      '  --quiet         不打印日志\n');
    return;
  }

  const server = createServer();
  let tried = 0;
  const basePort = opt.port || 41730;

  server.on('error', async err => {
    if (err.code === 'EADDRINUSE') {
      if (!opt.port) {
        // 先看是不是本程序已经在跑（用户重复双击）：是就直接用那个窗口，不再起第二个服务
        for (let base = basePort; base < basePort + 20; base++) {
          if (await probeExisting(base)) {
            const u = 'http://127.0.0.1:' + base + '/';
            if (opt.window) {
              openWindow(u);
              setTimeout(() => process.exit(0), 2500);
            } else {
              if (!opt.quiet) say('已经有一个实例在运行：' + u + '\n');
              process.exit(0);
            }
            return;
          }
        }
        // 端口被别的程序占了，换个端口
        if (tried < 20) {
          tried++;
          server.listen(basePort + tried, opt.host, onListen);
          return;
        }
      }
      notify('启动失败', '端口 ' + (opt.port || basePort) + ' 已被占用。换一个端口：汇编学习台.exe --port 42000');
      process.exit(1);
      return;
    }
    notify('启动失败', err.message);
    process.exit(1);
  });

  function onListen() {
    const port = server.address().port;
    const url = 'http://' + (opt.host === '0.0.0.0' ? '127.0.0.1' : opt.host) + ':' + port + '/';
    log('服务已就绪 ' + url);
    if (!opt.quiet) {
      say('汇编学习台 v1.0.0\n');
      say('  本地地址：' + url + '\n');
      if (opt.host === '0.0.0.0') {
        const nets = os.networkInterfaces();
        Object.keys(nets).forEach(k => (nets[k] || []).forEach(n => {
          if (n.family === 'IPv4' && !n.internal) {
            say('  局域网地址：http://' + n.address + ':' + port + '/\n');
          }
        }));
      }
      say('  接口：/api/health /api/compile /api/decompile /api/run /api/check\n');
      say('  关闭窗口或按 Ctrl+C 退出\n');
    }
    if (opt.window) {
      windowMode = true;
      onBye = () => {
        log('退出：收到关窗通知，3 秒内无新心跳');
        try { server.close(); } catch (e) { }
        process.exit(0);
      };
      openWindow(url);
      log('已请求打开窗口 ' + url);

      // 看门狗：页面 90 秒没报活就认为窗口已关；一次都没报活则 5 分钟后退出
      const bootAt = Date.now();
      const timer = setInterval(() => {
        const idle = lastSeen ? Date.now() - lastSeen : Date.now() - bootAt;
        const limit = lastSeen ? 90 * 1000 : 5 * 60 * 1000;
        if (idle > limit) {
          clearInterval(timer);
          const why = lastSeen ? '页面 90 秒无心跳' : '5 分钟内没有任何页面连上';
          log('退出：看门狗判定 ' + why + '（idle=' + Math.round(idle / 1000) + 's）');
          if (!opt.quiet) say(lastSeen ? '页面已关闭，程序退出。\n' : '窗口没能打开，程序退出。\n');
          try { server.close(); } catch (e) { }
          process.exit(0);
        }
      }, 15000);
      if (timer.unref) timer.unref();
    }
  }

  log('监听 ' + opt.host + ':' + basePort);
  server.listen(basePort, opt.host, onListen);
}

if (require.main === module) main();
module.exports = { createServer, apiCompile, apiDecompile, apiRun, apiCheck };
