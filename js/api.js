/* ============================================================
 * api.js · 前后端接口层
 *   · 页面由后端（exe 内置服务 / 部署的服务器）托管时，编译走服务端
 *   · 直接双击 index.html（file://）时自动退回浏览器本地计算，功能不变
 * ============================================================ */
(function (global) {
  'use strict';

  // 在 Node 里被 require 时没有 location，这里的判空兼作保护
  const online = (typeof location !== 'undefined') && /^https?:$/i.test(location.protocol);

  async function post(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (data && data.ok === false && data.error && data.fatal) throw new Error(data.error);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  const API = {
    /** 当前页面是否由服务端托管 */
    online: () => online,
    /** 探测后端，返回 health 对象或 null */
    async health() {
      if (!online) return null;
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    },
    compile: code => post('/api/compile', { code: code }),
    decompile: asm => post('/api/decompile', { asm: asm }),
    run: payload => post('/api/run', payload || {}),
    check: asm => post('/api/check', { asm: asm }),

    /** 报活：窗口模式下后端靠这个判断页面还在不在 */
    ping() {
      if (!online) return;
      try { fetch('/api/ping', { cache: 'no-store' }).catch(() => { }); } catch (e) { }
    },
    /** 关窗通知：让后端立刻退出，不用等心跳超时 */
    bye() {
      if (!online || !navigator.sendBeacon) return;
      try { navigator.sendBeacon('/api/bye', ''); } catch (e) { }
    }
  };

  global.API = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
