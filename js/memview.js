/* ============================================================
 * 内存可视化：寄存器 + 栈内存 + 数据流动画
 * 用真实执行结果绘制，箭头表示本步指令的数据流向
 * ============================================================ */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const VM = global.ASM_VM;

  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  const hex = v => '0x' + Number(VM.uN(v === undefined ? 0 : v, 64)).toString(16).replace(/^0x/, '');

  const REG_ORDER = ['rax', 'rcx', 'rdx', 'rbx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'rbp', 'rsp', 'rip'];

  function frameCells(m, prog, varMap) {
    const rsp = m.regs.rsp;
    const cells = [];
    const hasPrologue = prog.instrs.some(i => i.mnem === 'push' && i.ops[0] && i.ops[0].name === 'rbp');

    // 选择栈帧锚点：结束时回看最后的栈帧；未开始则预览即将建立的栈帧
    let anchor = 0;
    if (m.halted && m.frameRbp) anchor = m.frameRbp;
    else if (m.steps === 0) anchor = rsp - 8;
    else if (m.regs.rbp) anchor = m.regs.rbp;

    if (!anchor || (!hasPrologue && m.steps === 0)) {
      for (let i = 6; i >= 0; i--) {
        const addr = rsp + i * 4;
        cells.push({ addr, size: 4, label: i === 0 ? 'rsp' : 'rsp+' + (i * 4), name: i === 0 ? '栈顶' : '' });
      }
      return cells;
    }

    // 找出程序用到的最大局部偏移
    let maxOff = 16;
    prog.instrs.forEach(ins => ins.ops.forEach(op => {
      if (op.kind === 'mem' && op.base === 'rbp' && (op.disp || 0) < 0) maxOff = Math.max(maxOff, -op.disp + 4);
    }));
    cells.push({ addr: anchor + 8, size: 8, label: 'rbp+8', name: '返回地址' });
    cells.push({ addr: anchor, size: 8, label: 'rbp+0', name: '保存的 rbp' });
    const n = Math.ceil(maxOff / 4);
    for (let i = 1; i <= Math.min(n, 10); i++) {
      const off = i * 4;
      cells.push({ addr: anchor - off, size: 4, label: 'rbp-' + off, name: (varMap && varMap.get(off)) || '' });
    }
    return cells;
  }

  let rafId = null;

  function render(svg, opts) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const m = opts.m, prog = opts.prog, varMap = opts.varMap;
    const step = opts.step;
    const W = 1000, H = 300;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = '';

    const defs = el('defs');
    const marker = el('marker', { id: 'arrowhead', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#f97316' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    if (!m) {
      svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': '14' }, '输入汇编代码后，这里会实时显示栈内存与寄存器的变化'));
      return;
    }

    /* ---------- 寄存器面板 ---------- */
    const regX = 12, regW = 220, regY0 = 44, rowH = 25;
    const used = new Set(['rax', 'rbp', 'rsp', 'rip']);
    (opts.regsUsed || []).forEach(r => used.add(r));
    const regs = REG_ORDER.filter(r => used.has(r)).slice(0, 9);

    svg.appendChild(el('rect', { x: regX, y: 10, width: regW, height: H - 20, rx: 10, fill: '#f8fafc', stroke: '#e2e8f0' }));
    svg.appendChild(el('text', { x: regX + 12, y: 32, fill: '#334155', 'font-size': '12.5', 'font-weight': '600' }, '寄存器'));
    svg.appendChild(el('text', { x: regX + regW - 12, y: 32, fill: '#94a3b8', 'font-size': '11', 'text-anchor': 'end' }, '十六进制 / 十进制'));

    const regPos = {};
    const changedRegs = new Set();
    if (step && step.writes) step.writes.forEach(w => { if (w.kind === 'reg') changedRegs.add(w.name.replace(/^e/, 'r').replace(/^r([abcd]x)$/, 'r$1')); });
    if (step && step.writes) step.writes.forEach(w => { if (w.kind === 'reg' && VM.regInfo(w.name)) changedRegs.add(VM.regInfo(w.name).parent); });

    regs.forEach((r, i) => {
      const y = regY0 + i * rowH;
      const isChanged = changedRegs.has(r);
      const g = el('g', { class: isChanged ? 'reg-row changed' : 'reg-row' });
      g.appendChild(el('rect', { x: regX + 8, y: y, width: regW - 16, height: rowH - 4, rx: 6, fill: isChanged ? '#fff7ed' : '#ffffff', stroke: isChanged ? '#fdba74' : '#e8edf5' }));
      g.appendChild(el('text', { x: regX + 18, y: y + 15, fill: '#0f172a', 'font-size': '12.5', 'font-family': 'ui-monospace, Consolas, monospace', 'font-weight': '600' }, r));
      const v = m.regs[r] || 0;
      const shown = (r === 'rip') ? '0x' + Number(VM.uN(v, 64)).toString(16) : '0x' + Number(VM.uN(v, 64)).toString(16);
      g.appendChild(el('text', { x: regX + regW - 92, y: y + 15, fill: '#2563eb', 'font-size': '12', 'font-family': 'ui-monospace, Consolas, monospace', 'text-anchor': 'end' }, shown));
      g.appendChild(el('text', { x: regX + regW - 18, y: y + 15, fill: '#64748b', 'font-size': '11.5', 'font-family': 'ui-monospace, Consolas, monospace', 'text-anchor': 'end' }, String(Number(VM.signedOf(v || 0, 64))).slice(0, 12)));
      svg.appendChild(g);
      regPos[r] = { x: regX + regW - 8, y: y + (rowH - 4) / 2, x0: regX + 8 };
    });

    // 标志位
    const flagY = H - 34;
    svg.appendChild(el('text', { x: regX + 12, y: flagY - 6, fill: '#334155', 'font-size': '12', 'font-weight': '600' }, '标志位'));
    ['ZF', 'SF', 'CF', 'OF'].forEach((f, i) => {
      const on = m.flags[f] === 1;
      const bx = regX + 12 + i * 50;
      svg.appendChild(el('rect', { x: bx, y: flagY, width: 42, height: 20, rx: 5, fill: on ? '#dcfce7' : '#f1f5f9', stroke: on ? '#86efac' : '#e2e8f0' }));
      svg.appendChild(el('text', { x: bx + 21, y: flagY + 14, 'text-anchor': 'middle', 'font-size': '11', fill: on ? '#15803d' : '#94a3b8', 'font-weight': on ? '700' : '400' }, f + '=' + m.flags[f]));
    });

    /* ---------- 内存面板 ---------- */
    const memX = 690, memW = 298;
    svg.appendChild(el('rect', { x: memX, y: 10, width: memW, height: H - 20, rx: 10, fill: '#f8fafc', stroke: '#e2e8f0' }));
    svg.appendChild(el('text', { x: memX + 12, y: 32, fill: '#334155', 'font-size': '12.5', 'font-weight': '600' }, '栈内存（小端序）'));
    svg.appendChild(el('text', { x: memX + memW - 12, y: 32, fill: '#94a3b8', 'font-size': '11', 'text-anchor': 'end' }, '地址 ↑ 高'));

    const cells = frameCells(m, prog, varMap);
    const n = cells.length;
    const top = 44, avail = H - top - 16;
    const cellH = Math.min(30, Math.floor(avail / n) - 3);
    const cellPos = {};
    cells.forEach((c, i) => {
      const y = top + i * (cellH + 3);
      const val = m.readMem(c.addr, Math.min(c.size, 8));
      const isChanged = step && step.writes && step.writes.some(w => w.kind === 'mem' && w.addr === c.addr);
      const g = el('g', { class: isChanged ? 'mem-cell changed' : 'mem-cell' });
      g.appendChild(el('rect', { x: memX + 10, y, width: memW - 20, height: cellH, rx: 6, fill: isChanged ? '#fff7ed' : '#ffffff', stroke: isChanged ? '#fb923c' : '#e8edf5', 'stroke-width': isChanged ? 1.6 : 1 }));
      g.appendChild(el('text', { x: memX + 20, y: y + cellH / 2 + 4, fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'ui-monospace, Consolas, monospace' }, c.label));
      const nameTxt = el('text', { x: memX + 86, y: y + cellH / 2 + 4, fill: '#475569', 'font-size': '11' }, c.name || '');
      g.appendChild(nameTxt);
      const disp = (Math.abs(val) > 999999) ? '0x' + Number(VM.uN(val, 64)).toString(16) : String(val);
      g.appendChild(el('text', { x: memX + memW - 22, y: y + cellH / 2 + 4, fill: isChanged ? '#c2410c' : '#0f172a', 'font-size': '12', 'font-family': 'ui-monospace, Consolas, monospace', 'text-anchor': 'end', 'font-weight': '600' }, disp));
      svg.appendChild(g);
      cellPos[c.addr] = { x: memX + 10, y: y + cellH / 2, w: memW - 20 };
    });

    // 地址标注
    svg.appendChild(el('text', { x: memX + 12, y: H - 14, fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'ui-monospace, Consolas, monospace' },
      'rsp=0x' + Number(VM.uN(m.regs.rsp, 64)).toString(16) + '   rbp=0x' + Number(VM.uN(m.regs.rbp, 64)).toString(16)));

    /* ---------- 数据段 ---------- */
    if (prog.strings && prog.strings.length) {
      const dataY = H - 92;
      svg.appendChild(el('rect', { x: 250, y: dataY, width: 420, height: 78, rx: 10, fill: '#f8fafc', stroke: '#e2e8f0' }));
      svg.appendChild(el('text', { x: 264, y: dataY + 20, fill: '#334155', 'font-size': '12', 'font-weight': '600' }, '只读数据段（字符串常量）'));
      prog.strings.slice(0, 3).forEach((sg, i) => {
        const y = dataY + 38 + i * 17;
        svg.appendChild(el('text', { x: 264, y, fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'ui-monospace, Consolas, monospace' }, '0x' + sg.addr.toString(16)));
        const txt = sg.text.replace(/\n/g, '\\n');
        svg.appendChild(el('text', { x: 356, y, fill: '#0f172a', 'font-size': '11.5', 'font-family': 'ui-monospace, Consolas, monospace' }, '"' + (txt.length > 28 ? txt.slice(0, 28) + '…' : txt) + '"'));
      });
    }

    /* ---------- 数据流动画 ---------- */
    if (opts.showFlow !== false && step) {
      drawFlow(svg, step, { regPos, cellPos, m });
    }

    // 当前指令说明
    const capY = opts.prog.strings && opts.prog.strings.length ? 40 : H / 2;
    const cap = el('g');
    if (opts.caption) {
      const cx = 250, cy = opts.prog.strings && opts.prog.strings.length ? 26 : 60;
      cap.appendChild(el('text', { x: 250, y: cy, fill: '#0f172a', 'font-size': '12.5', 'font-family': 'ui-monospace, Consolas, monospace', 'font-weight': '600' }, opts.caption));
    }
    svg.appendChild(cap);
  }

  function drawFlow(svg, step, pos) {
    const m = pos.m;
    let src = null, dst = null, value = null, label = '';

    const writeMem = step.writes.find(w => w.kind === 'mem' && pos.cellPos[w.addr]);
    const writeReg = step.writes.find(w => w.kind === 'reg' && pos.regPos[VM.regInfo(w.name) ? VM.regInfo(w.name).parent : w.name]);
    const readMem = step.reads.find(r => r.kind === 'mem' && pos.cellPos[r.addr]);
    const readReg = step.reads.find(r => r.kind === 'reg' && pos.regPos[VM.regInfo(r.name) ? VM.regInfo(r.name).parent : r.name]);

    const pushed = step.writes.find(w => w.kind === 'mem' && w.push);
    if (step.instr && step.instr.mnem === 'push' && pushed) {
      if (pos.cellPos[pushed.addr]) { src = { x: 250, y: 150 }; dst = pos.cellPos[pushed.addr]; value = pushed.value; }
    } else if (readMem && writeReg) {
      src = pos.cellPos[readMem.addr]; dst = pos.regPos[VM.regInfo(writeReg.name).parent];
      src = { x: src.x, y: src.y }; dst = { x: dst.x - 4, y: dst.y };
      value = readMem.value;
    } else if (readReg && writeMem) {
      const rp = pos.regPos[VM.regInfo(readReg.name) ? VM.regInfo(readReg.name).parent : readReg.name];
      if (rp) src = { x: rp.x, y: rp.y };
      dst = pos.cellPos[writeMem.addr] || null;
      value = writeMem.value;
    } else if (readMem && writeMem) {
      const a = pos.cellPos[readMem.addr], b = pos.cellPos[writeMem.addr];
      if (a && b) { src = { x: a.x, y: a.y }; dst = { x: b.x, y: b.y }; }
      value = writeMem.value;
    } else if (readReg && writeReg) {
      const a = pos.regPos[VM.regInfo(readReg.name) ? VM.regInfo(readReg.name).parent : readReg.name];
      const b = pos.regPos[VM.regInfo(writeReg.name) ? VM.regInfo(writeReg.name).parent : writeReg.name];
      if (a && b) { src = { x: a.x0 + 40, y: a.y }; dst = { x: b.x0 + 40, y: b.y }; }
      value = writeReg.value;
    }
    if (!src || !dst) return;
    if (![src.x, src.y, dst.x, dst.y].every(Number.isFinite)) return;
    if (Math.abs(src.x - dst.x) < 2 && Math.abs(src.y - dst.y) < 2) return;

    const dx = Math.abs(dst.x - src.x);
    const c1 = { x: src.x + (dst.x > src.x ? dx * 0.45 : -dx * 0.45), y: src.y };
    const c2 = { x: dst.x - (dst.x > src.x ? dx * 0.45 : -dx * 0.45), y: dst.y };
    const d = 'M ' + src.x + ' ' + src.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + dst.x + ' ' + dst.y;

    const path = el('path', { d, fill: 'none', stroke: '#f97316', 'stroke-width': '2', 'stroke-dasharray': '7 6', 'marker-end': 'url(#arrowhead)', opacity: '0.9' });
    svg.appendChild(path);

    // 流动的小圆点
    const dot = el('circle', { r: '4.5', fill: '#f97316', opacity: '0.95' });
    svg.appendChild(dot);
    const labelEl = el('text', { x: src.x, y: src.y - 8, 'font-size': '11.5', fill: '#c2410c', 'font-weight': '700', 'text-anchor': 'middle', 'font-family': 'ui-monospace, Consolas, monospace' }, String(value));
    svg.appendChild(labelEl);

    let len = 0;
    try { len = path.getTotalLength(); } catch (e) { len = 0; }
    if (!len) {
      // 拿不到路径长度时退化成"不动的箭头"，不影响理解
      dot.setAttribute('opacity', '0');
      return;
    }
    const dur = 620;
    let t0 = null;
    const tick = ts => {
      if (!dot.isConnected) { rafId = null; return; }
      if (!t0) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
      let pt;
      try { pt = path.getPointAtLength(len * ease); } catch (e) { rafId = null; return; }
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);
      labelEl.setAttribute('x', pt.x);
      labelEl.setAttribute('y', pt.y - 8);
      if (p < 1) rafId = requestAnimationFrame(tick);
      else { rafId = null; dot.setAttribute('opacity', '0'); labelEl.setAttribute('opacity', '0'); }
    };
    rafId = requestAnimationFrame(tick);
  }

  const API = { render, frameCells };
  global.ASM_MEMVIEW = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
