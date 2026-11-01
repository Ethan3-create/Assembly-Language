/* ============================================================
 * 汇编 → 伪 C 反编译（教学用）
 *
 * 思路：
 *   1. 先从标签里切出「函数」边界（main、被 call 的目标、紧跟序言的标签）
 *   2. 对每个函数做符号执行：寄存器/栈槽 → 表达式树
 *   3. 用 cmp+jcc 的跳转模式还原 if / while
 *   4. 从栈槽的读写宽度、SSE 指令推断变量类型（int/char/long/double…）
 *   5. 被读之前没被写过的参数寄存器 → 还原成函数参数
 * ============================================================ */
(function (global) {
  'use strict';

  const VM = global.ASM_VM || (typeof require !== 'undefined' ? require('./vm.js') : null);

  const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
  const NEG = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==' };

  /* System V 参数寄存器 */
  const ARG_I = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
  const ARG_X = ['xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5', 'xmm6', 'xmm7'];
  const ARG_ALL = ARG_I.concat(ARG_X);
  const CALLER_SAVED = ARG_ALL.concat(['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']);

  const TPRI = { char: 1, short: 2, int: 3, long: 4, float: 5, double: 6 };
  const TYPE_BY_SIZE = { 1: 'char', 2: 'short', 4: 'int', 8: 'long' };

  function num(v) { return { t: 'num', v }; }
  function str(s) { return { t: 'str', v: s }; }
  function vr(n) { return { t: 'var', name: n }; }

  function bin(op, l, r) {
    if (l && r && l.t === 'num' && r.t === 'num') {
      const a = l.v, b = r.v;
      let v = null;
      if (op === '+') v = a + b; else if (op === '-') v = a - b; else if (op === '*') v = a * b;
      else if (op === '/' && b !== 0) v = Math.trunc(a / b); else if (op === '%' && b !== 0) v = a % b;
      else if (op === '<<' && b < 32) v = a << b;
      if (v !== null) return num(v);
    }
    if (op === '+' && l && l.t === 'num' && l.v === 0) return r;
    if (op === '+' && r && r.t === 'num' && r.v === 0) return l;
    if (op === '-' && r && r.t === 'num' && r.v === 0) return l;
    if (op === '*' && l && l.t === 'num' && l.v === 1) return r;
    if (op === '*' && r && r.t === 'num' && r.v === 1) return l;
    return { t: 'bin', op: op, l: l, r: r };
  }

  function exprText(e) {
    if (!e) return '?';
    switch (e.t) {
      case 'num': {
        const v = e.v;
        if (typeof v === 'number' && !Number.isInteger(v)) return String(v);
        return String(v);
      }
      case 'var': return e.name;
      case 'str': return '"' + String(e.v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
      case 'raw': return e.text;
      case 'callref': return e.ev.name + '(' + (e.ev.args || []).map(exprText).join(', ') + ')';
      case 'index': {
        const ix = (typeof e.idx === 'number') ? String(e.idx) : exprText(e.idx);
        return e.name + '[' + ix + ']';
      }
      case 'addr': return '&' + e.name;
      case 'ptr': {
        const b = e.name;
        if (e.idx === null || e.idx === undefined) return b;
        if (typeof e.idx === 'number' && e.idx === 0) return b;
        return b + ' + ' + (typeof e.idx === 'number' ? e.idx : exprText(e.idx));
      }
      case 'scaled': return exprText(e.e);
      case 'bin': {
        const p = PREC[e.op] || 0;
        let ls = exprText(e.l), rs = exprText(e.r);
        if (e.l && e.l.t === 'bin' && (PREC[e.l.op] || 0) < p) ls = '(' + ls + ')';
        if (e.r && e.r.t === 'bin' && ((PREC[e.r.op] || 0) < p || ((e.r.op === '-' || e.r.op === '/') && PREC[e.r.op] === p))) rs = '(' + rs + ')';
        return ls + ' ' + e.op + ' ' + rs;
      }
      default: return '?';
    }
  }

  function negCond(c) {
    if (c && c.t === 'bin' && NEG[c.op]) return { t: 'bin', op: NEG[c.op], l: c.l, r: c.r };
    return { t: 'bin', op: '==', l: c || { t: 'raw', text: '?' }, r: num(0) };
  }

  /* 从数据段按 IEEE-754 读浮点常量 */
  const DBUF = new ArrayBuffer(8);
  const DDV = new DataView(DBUF);
  function readDoubleAt(dm, addr, size) {
    if (!dm || !dm.get) return null;
    for (let i = 0; i < size; i++) DDV.setUint8(i, dm.get(addr + i) || 0);
    return size === 4 ? DDV.getFloat32(0, true) : DDV.getFloat64(0, true);
  }

  function parentOf(n) {
    if (!n) return n;
    const ri = VM && VM.regInfo ? VM.regInfo(n) : null;
    return ri ? ri.parent : n;
  }

  /* ============================================================
   * 1. 切分函数
   * ============================================================ */
  function findFunctions(prog) {
    const instrs = prog.instrs;
    const callTargets = new Set();
    instrs.forEach(i => {
      if (i.mnem === 'call' && i.ops[0]) callTargets.add(i.ops[0].label || i.ops[0].text);
    });

    const starts = [];
    prog.labels.forEach((v, name) => {
      if (v.kind !== 'code') return;
      if (/^\.L/i.test(name) || /^\$/.test(name)) return;      // 局部标签
      let likeFn = callTargets.has(name) || name === 'main' || name === '_start';
      if (!likeFn) {
        const a = instrs[v.index];
        const b = instrs[v.index + 1];
        if (a && a.mnem === 'push' && a.ops[0] && a.ops[0].name === 'rbp') likeFn = true;
        else if (b && b.mnem === 'mov' && b.ops[0] && b.ops[0].name === 'rbp' && b.ops[1] && b.ops[1].name === 'rsp') likeFn = true;
        else if (a && a.mnem === 'endbr64') likeFn = true;
      }
      if (likeFn) starts.push({ name: name, start: v.index });
    });

    // 去重 + 排序
    const seen = new Set();
    const uniq = [];
    starts.sort((x, y) => x.start - y.start).forEach(s => {
      if (seen.has(s.start)) return;
      seen.add(s.start); uniq.push(s);
    });

    if (!uniq.length) return [{ name: null, start: 0, end: instrs.length }];

    const out = [];
    if (uniq[0].start > 0) out.push({ name: null, start: 0, end: uniq[0].start });
    uniq.forEach((s, i) => {
      out.push({ name: s.name, start: s.start, end: i + 1 < uniq.length ? uniq[i + 1].start : instrs.length });
    });
    return out;
  }

  /* ============================================================
   * 1.5 从数据段还原全局变量声明
   * ============================================================ */
  function readByte(dm, a) {
    const v = dm.get(a);
    return v === undefined || v === null ? 0 : Number(v) & 0xff;
  }
  function readInt(dm, addr, size, signed) {
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(readByte(dm, addr + i));
    return signed === false ? Number(v) : Number(BigInt.asIntN(size * 8, v));
  }

  function dataDecls(prog, floatG, metaOut) {
    const out = [];
    const dm = prog.dataMap;
    if (!dm || !dm.get) return out;
    const datas = [];
    prog.labels.forEach((v, k) => {
      if (v.kind === 'data' && typeof v.addr === 'number' && !/^\.L/.test(k)) datas.push({ name: k, addr: v.addr });
    });
    if (!datas.length) return out;
    datas.sort((a, b) => a.addr - b.addr);

    let maxA = -1;
    dm.forEach((val, k) => { const n = typeof k === 'number' ? k : Number(k); if (n > maxA) maxA = n; });

    datas.forEach((d, i) => {
      const end = i + 1 < datas.length ? datas[i + 1].addr : maxA + 1;
      const size = end - d.addr;
      if (size <= 0) return;
      const isF = floatG && floatG.has(d.name);
      const per = (isF || (size % 8 === 0 && size % 4 !== 0)) ? 8 : (size === 1 ? 1 : size === 2 ? 2 : 4);
      if (metaOut) metaOut.set(d.name, { size: size, elem: per, len: Math.max(1, Math.floor(size / per)), fp: !!isF });
      if (size === 1) {
        out.push('char ' + d.name + ' = ' + readInt(dm, d.addr, 1) + ';');
      } else if (size === 2) {
        out.push('short ' + d.name + ' = ' + readInt(dm, d.addr, 2) + ';');
      } else if (size === 4) {
        if (isF) out.push('float ' + d.name + ' = ' + (Math.round(readDoubleAt(dm, d.addr, 4) * 1e6) / 1e6) + ';');
        else out.push('int ' + d.name + ' = ' + readInt(dm, d.addr, 4) + ';');
      } else if (size === 8) {
        if (isF) out.push('double ' + d.name + ' = ' + (Math.round(readDoubleAt(dm, d.addr, 8) * 1e9) / 1e9) + ';');
        else out.push('long ' + d.name + ' = ' + readInt(dm, d.addr, 8) + 'L;');
      } else if (size % 8 === 0 && (isF || size % 4 !== 0)) {
        const n = size / 8;
        const vals = [];
        for (let k = 0; k < n; k++) {
          vals.push(isF ? (Math.round(readDoubleAt(dm, d.addr + k * 8, 8) * 1e9) / 1e9) : readInt(dm, d.addr + k * 8, 8) + 'L');
        }
        out.push((isF ? 'double ' : 'long ') + d.name + '[' + n + '] = {' + vals.join(', ') + '};');
      } else if (size % 4 === 0) {
        const n = size / 4;
        const vals = [];
        for (let k = 0; k < n; k++) vals.push(readInt(dm, d.addr + k * 4, 4));
        out.push('int ' + d.name + '[' + n + '] = {' + vals.join(', ') + '};');
      } else if (size % 2 === 0) {
        const n = size / 2;
        out.push('short ' + d.name + '[' + n + '];');
      } else {
        out.push('char ' + d.name + '[' + size + '];');
      }
    });
    return out;
  }

  /* ============================================================
   * 1.8 参数寄存器识别（也被"预扫描"复用）
   * 规则：一个参数寄存器如果在被写之前先被"读"，它就是函数入参
   * ============================================================ */
  function detectParamRegs(prog, S, E) {
    const instrs = prog.instrs;
    const written = new Set();
    const out = [];
    for (let i = S; i < E; i++) {
      const ins = instrs[i];
      if (!ins) break;
      if (ins.mnem === 'ret' && out.length) break;
      const d0 = ins.ops[0];
      const dw = (d0 && d0.kind === 'reg') ? parentOf(d0.name) : null;
      for (let k = 1; k < ins.ops.length; k++) {
        const op = ins.ops[k];
        if (op && op.kind === 'reg') {
          const p = parentOf(op.name);
          if (p === dw) continue;          // xor edx, edx 这种"先写后读"不算入参
          if (ARG_ALL.indexOf(p) >= 0 && !written.has(p) && out.indexOf(p) < 0) out.push(p);
        }
      }
      const d = ins.ops[0];
      if (d && d.kind === 'reg') written.add(parentOf(d.name));
      if (ins.mnem === 'cdq' || ins.mnem === 'cqo' || ins.mnem === 'cwd' || ins.mnem === 'cqto') written.add('rdx');
      else if (ins.mnem === 'idiv' || ins.mnem === 'div' || ins.mnem === 'mul') { written.add('rax'); written.add('rdx'); }
      else if (ins.mnem === 'call') CALLER_SAVED.forEach(r => written.add(r));
    }
    return out;
  }

  /* ============================================================
   * 1.9 判断一个函数是否用 xmm0 返回浮点
   * ============================================================ */
  function detectRetFloat(prog, S, E) {
    const instrs = prog.instrs;
    let rax = -1, xmm0 = -1;
    for (let i = S; i < E; i++) {
      const ins = instrs[i];
      if (!ins) break;
      const d = ins.ops[0];
      if (d && d.kind === 'reg') {
        const p = parentOf(d.name);
        if (p === 'rax') rax = i;
        if (p === 'xmm0') xmm0 = i;
      }
      if (ins.mnem === 'call') rax = i;           // 调用返回值放在 rax
      if (ins.mnem === 'ret') return xmm0 > rax;
    }
    return false;
  }

  /* ============================================================
   * 2. 单个函数
   * ============================================================ */
  function decompileFn(prog, fn, ctx) {
    const instrs = prog.instrs;
    const S = fn.start, E = fn.end;
    const knownVars = ctx.varMap || null;
    const knownTypes = ctx.varTypes || null;
    const floatG = ctx.floatG || null;
    const gmeta = ctx.gmeta || null;

    // 每个函数的栈偏移会重叠，所以优先用"按函数分组"的变量表
    let fNames = knownVars, fTypes = knownTypes, fSizes = ctx.varSizes || null;
    if (ctx.varMapByFunc && fn.name && ctx.varMapByFunc.get && ctx.varMapByFunc.get(fn.name)) {
      const e = ctx.varMapByFunc.get(fn.name);
      fNames = e.names || null;
      fTypes = e.types || null;
      fSizes = e.sizes || fSizes;
    }
    const spanMap = new Map();      // 栈偏移 -> {name, idx}：数组元素占的连续空间

    // 类型可能来自编译器的字符串（"int[5]" / "int*"），也可能是类型对象
    function typeFromDecl(t) {
      if (!t) return null;
      if (typeof t === 'string') {
        const m = t.match(/(unsigned\s+)?(int|long|short|char|float|double)\b/);
        if (!m) return null;
        return m[2];
      }
      let b = t;
      let guard = 0;
      while (b && (b.k === 'array' || b.k === 'ptr') && guard++ < 12) b = b.to;
      if (!b || b.k === 'struct' || b.k === 'void') return null;
      return b.k;
    }
    function arrLenFromDecl(t) {
      if (!t) return 0;
      if (typeof t === 'string') {
        const m = t.match(/\[(\d+)\]/);
        return m ? parseInt(m[1], 10) : 0;
      }
      if (t.k === 'array' && t.n > 0) return t.n;
      return 0;
    }
    function isPtrVar(name) {
      const rec = varRec(name);
      if (!rec) return false;
      if (fTypes && fTypes.get) {
        const t = fTypes.get(rec.off);
        if (typeof t === 'string') return t.indexOf('*') >= 0;
        if (t && (t.k === 'ptr' || t.k === 'array')) return true;
      }
      return false;
    }

    const varNames = new Map();     // name -> offset(绝对值)
    const offNames = new Map();     // offset -> name
    const usedVars = [];            // {name, off, type, isParam, arrLen}
    const typeOf = new Map();
    const arrSeen = new Map();      // name -> 最大下标
    const guessArr = new Set();     // 长度是猜出来的数组
    const sym = {};                 // 寄存器(parent) -> 表达式
    const wIdx = {};                // 寄存器(parent) -> 最后写入的指令序号
    const argIdx = {};              // 寄存器(parent) -> 最后写入的指令序号
    const events = [];
    const symStack = [];
    const skipIdx = new Set();
    const temps = new Set();
    const stk = {};                 // 栈上的临时槽：偏移 -> 表达式（用来还原"栈传参"）
    let rspShift = 0;               // sub/add rsp 的累计偏移

    let lastCmp = null;
    let sseCount = 0;
    let inPrologue = true;
    let lastCallIdx = -1;
    let lastStore = -1;             // 最后一次"写内存"的位置（判断 rax 里的值是不是返回值）
    let floatRet = false;
    let hasMemOp = false;

    function varNameFor(offAbs) {
      if (offNames.has(offAbs)) return offNames.get(offAbs);
      let name = null;
      if (fNames && fNames.get) name = fNames.get(offAbs) || null;
      if (!name) name = (offAbs % 4 === 0) ? 'v' + (offAbs / 4) : 'v_' + offAbs;
      while (usedVars.some(v => v.name === name)) name = name + '_';
      offNames.set(offAbs, name);
      varNames.set(name, offAbs);
      usedVars.push({ name: name, off: offAbs, type: 'int', isParam: false, arrLen: 0 });
      // 如果是 C→汇编→C 的往返，直接拿编译器的类型信息
      if (fTypes && fTypes.get) {
        const t0 = fTypes.get(offAbs);
        const bt = typeFromDecl(t0);
        if (bt) noteType(name, bt);
        const n0 = arrLenFromDecl(t0);
        if (n0 > 0) {
          arrSeen.set(name, n0 - 1);
          const tot = (fSizes && fSizes.get) ? fSizes.get(offAbs) : 0;
          const elem = tot > 0 ? Math.max(1, Math.round(tot / n0)) : 4;
          for (let k = 0; k < n0; k++) spanMap.set(offAbs - k * elem, { name: name, idx: k });
        }
      }
      return name;
    }
    function varRec(name) {
      for (let i = 0; i < usedVars.length; i++) if (usedVars[i].name === name) return usedVars[i];
      return null;
    }
    function noteType(name, t) {
      if (!name || !t) return;
      const cur = typeOf.get(name);
      if (!cur || (TPRI[t] || 0) > (TPRI[cur] || 0)) typeOf.set(name, t);
      const r = varRec(name);
      if (r) r.type = typeOf.get(name);
    }
    function nextFreeName(base) {
      let n = base, k = 2;
      while (usedVars.some(v => v.name === n)) n = base + k++;
      return n;
    }

    /* ---------- 参数识别 ---------- */
    const paramRegs = detectParamRegs(prog, S, E);

    // 参数落到哪个栈槽
    const slotOf = new Map();   // reg -> {off, size, kind, idx}
    for (let i = S; i < E; i++) {
      const ins = instrs[i];
      const d = ins.ops[0], s1 = ins.ops[1];
      if (!d || !s1) continue;
      if (d.kind !== 'mem' || d.base !== 'rbp' || (d.disp || 0) >= 0) continue;
      if (s1.kind !== 'reg') continue;
      const p = parentOf(s1.name);
      if (paramRegs.indexOf(p) < 0 || slotOf.has(p)) continue;
      const isSse = ins.mnem === 'movsd' || ins.mnem === 'movss';
      if (ins.mnem !== 'mov' && !isSse) continue;
      slotOf.set(p, {
        off: -d.disp,
        size: d.size || (isSse ? 8 : 4),
        kind: isSse ? (ins.mnem === 'movss' ? 'float' : 'double') : (TYPE_BY_SIZE[d.size || 4] || 'int'),
        idx: i
      });
    }

    const params = [];
    paramRegs.sort((a, b) => ARG_ALL.indexOf(a) - ARG_ALL.indexOf(b));
    paramRegs.forEach((reg, k) => {
      const slot = slotOf.get(reg);
      let name, type;
      if (slot) {
        name = varNameFor(slot.off);
        type = slot.kind;
        skipIdx.add(slot.idx);              // 这条只是"把参数存到栈上"，不用翻译
        const r = varRec(name);
        if (r) { r.isParam = true; r.type = type; }
        typeOf.set(name, type);
      } else {
        name = nextFreeName('a' + (k + 1));
        type = ARG_X.indexOf(reg) >= 0 ? 'double' : 'int';
        usedVars.push({ name: name, off: 0, type: type, isParam: true, arrLen: 0 });
        typeOf.set(name, type);
      }
      params.push({ name: name, type: type, reg: reg });
      sym[reg] = vr(name);
    });

    /* ---------- 取表达式 ---------- */
    function elemSizeOf(size) { return size === 8 ? 8 : size === 2 ? 2 : size === 1 ? 1 : 4; }

    function markArr(name, idx) {
      if (typeof idx !== 'number') {
        // 动态下标：确认它是数组，长度至少 2（后面可能被更准确的信息覆盖）
        if (!arrSeen.has(name)) { arrSeen.set(name, 1); guessArr.add(name); }
        return;
      }
      const rec = arrSeen.get(name) || 0;
      if (idx > rec) arrSeen.set(name, idx);
    }

    // 基址寄存器上带偏移的访问 → 数组下标
    function indexExpr(baseName, disp, size) {
      const elem = elemSizeOf(size);
      let idx = disp / elem;
      if (!Number.isInteger(idx)) idx = Math.floor(idx);
      markArr(baseName, idx);
      return { t: 'index', name: baseName, idx: idx };
    }

    // 指针（lea 出来的基址或指针变量）上的访问
    function ptrAccess(base, disp, size) {
      const elem = elemSizeOf(size);
      const byteOff = (disp || 0) + (base.extra || 0);
      let n = byteOff / elem;
      if (!Number.isInteger(n)) n = Math.floor(n);
      let bidx = base.idx;
      // 结构体/大步长：下标要乘回去，否则字节偏移会被算错
      if (bidx !== null && bidx !== undefined && base.stride && base.stride !== elem) {
        const k = base.stride / elem;
        if (Number.isInteger(k)) {
          bidx = (bidx.t === 'num') ? num(bidx.v * k) : { t: 'bin', op: '*', l: bidx, r: num(k) };
        }
      }
      if (bidx === null || bidx === undefined) {
        markArr(base.name, n);
        return { t: 'index', name: base.name, idx: n };
      }
      markArr(base.name, null);
      if (n === 0) return { t: 'index', name: base.name, idx: bidx };
      return { t: 'index', name: base.name, idx: bin('+', bidx, num(n)) };
    }

    function readExpr(op) {
      if (!op) return { t: 'raw', text: '?' };
      if (op.kind === 'reg') {
        const k = parentOf(op.name);
        if (sym[k]) return sym[k];
        return { t: 'raw', text: op.name };
      }
      if (op.kind === 'imm') {
        if (op.label) {
          if (op.labelKind === 'data') {
            const s = (prog.strings || []).find(x => x.addr === op.value);
            return s ? str(s.text) : { t: 'raw', text: '&' + op.label };
          }
          return { t: 'raw', text: op.label };
        }
        return num(op.value);
      }
      // 内存操作数
      if (op.base === 'rbp') {
        const off = op.disp || 0;
        if (off < 0) {
          const sp = spanMap.get(-off);
          if (sp) return { t: 'index', name: sp.name, idx: sp.idx };
          return vr(varNameFor(-off));
        }
        if (off > 0) return { t: 'raw', text: '[rbp+' + off + ']' };
        return { t: 'raw', text: '[rbp]' };
      }
      if (op.base === 'rsp') {
        const k0 = (op.disp || 0) - rspShift;
        if (stk[k0]) return stk[k0];
        temps.add('tmp');
        return { t: 'raw', text: 'tmp' };
      }
      if (op.base) {
        const b = sym[op.base];
        let base = null;
        if (b && b.t === 'addr') base = { t: 'ptr', name: b.name, idx: null, extra: b.extra || 0 };
        else if (b && b.t === 'ptr') base = b;
        else if (b && b.t === 'var') base = { t: 'ptr', name: b.name, idx: null, extra: 0 };

        if (base) {
          if (op.index) {
            // [rax+rcx*4] —— 基址 + 变址
            const ie = sym[op.index] || { t: 'raw', text: op.index };
            markArr(base.name, null);
            return { t: 'index', name: base.name, idx: ie };
          }
          return ptrAccess(base, op.disp, op.size);
        }
        return { t: 'raw', text: '*(int*)(' + (op.text || 'mem') + ')' };
      }
      if (!op.base && !op.index) {
        const s = (prog.strings || []).find(x => x.addr === (op.disp || 0));
        if (s) return str(s.text);
        if (op.sym) return globalRead(op.sym);
        return globalRead(globalName(op.disp || 0).name);
      }
      return { t: 'raw', text: op.text || '[mem]' };
    }

    // 全局变量（.data/.bss）
    const globalAt = new Map();
    function globalName(addr) {
      if (globalAt.has(addr)) return globalAt.get(addr);
      let nm = null;
      prog.labels.forEach((v, k) => {
        if (nm) return;
        if (v.kind === 'data' && v.addr === addr && !/^\.L/.test(k)) nm = k;
      });
      const e = vr(nm || ('g_' + Number(addr).toString(16)));
      globalAt.set(addr, e);
      return e;
    }
    // 读一个全局变量：数组的 [x] 要保留成 x[0]
    function globalRead(name) {
      const m = gmeta && gmeta.get ? gmeta.get(name) : null;
      if (m && m.len > 1) { arrSeen.set(name, m.len - 1); noteType(name, m.fp ? 'double' : 'int'); return { t: 'index', name: name, idx: 0 }; }
      if (m) noteType(name, m.fp ? 'double' : 'int');
      return vr(name);
    }

    // lea：取地址，不读内存
    function leaExpr(op) {
      if (op && op.kind === 'mem') {
        if (op.base === 'rbp' && (op.disp || 0) < 0) {
          const sp = spanMap.get(-op.disp);
          if (sp) return { t: 'ptr', name: sp.name, idx: sp.idx };
          return { t: 'addr', name: varNameFor(-op.disp) };
        }
        if (op.base) {
          const b = sym[op.base];
          if (b && b.t === 'addr') {
            const d = (op.disp || 0) + (b.extra || 0);
            if (d === 0) return { t: 'addr', name: b.name };
            return { t: 'addr', name: b.name, extra: d };
          }
          if (b && b.t === 'ptr') {
            const d = (op.disp || 0) + (b.extra || 0);
            if (d === 0) return b;
            return { t: 'ptr', name: b.name, idx: b.idx, extra: d };
          }
          if (b && b.t === 'var') return { t: 'ptr', name: b.name, idx: null, extra: op.disp || 0 };
        }
        if (!op.base && !op.index) {
          const sg = (prog.strings || []).find(x => x.addr === (op.disp || 0));
          if (sg) return str(sg.text);
          const gname = op.sym || globalName(op.disp || 0).name;
          const gm = gmeta && gmeta.get ? gmeta.get(gname) : null;
          if (gm && gm.len > 1) arrSeen.set(gname, gm.len - 1);
          return { t: 'ptr', name: gname, idx: null, extra: 0 };
        }
        return { t: 'addr', name: varNameFor(-(op.disp || 0) || 4) };
      }
      return readExpr(op);
    }

    function noteOperandType(op, kind) {
      if (!op) return;
      if (op.kind === 'mem' && op.base === 'rbp' && (op.disp || 0) < 0) {
        noteType(varNameFor(-op.disp), kind);
      } else if (op.kind === 'mem' && op.base) {
        const b = sym[op.base];
        if (b && (b.t === 'addr' || b.t === 'ptr' || b.t === 'var')) noteType(b.name, kind);
      } else if (op.kind === 'mem' && op.sym) {
        noteType(op.sym, kind);
        if (floatG && (kind === 'double' || kind === 'float')) floatG.add(op.sym);
      }
    }

    /* ---------- 判定"跳转过去就等于 return" ---------- */
    function isExitLabel(name) {
      const L = prog.labels.get(name);
      if (!L || L.kind !== 'code') return false;
      if (L.index >= E) return false;
      for (let j = L.index; j < E; j++) {
        const mn = instrs[j].mnem;
        if (mn === 'ret') return true;
        if (mn === 'leave' || mn === 'nop' || mn === 'pop' || mn === 'endbr64') continue;
        if (mn === 'mov' && instrs[j].ops[0] && instrs[j].ops[0].kind === 'reg' && /^(e|r)ax$/.test(instrs[j].ops[0].name)) continue;
        if (/^(movsd|movss)$/.test(mn) && instrs[j].ops[0] && instrs[j].ops[0].name === 'xmm0') continue;
        return false;
      }
      return false;
    }

    const addrToLabel = {};
    prog.labels.forEach((v, k) => { if (v.kind === 'code' && v.index >= S && v.index < E) addrToLabel[v.index] = k; });

    function pushAssign(o) { lastStore = i; events.push(o); }
    function noteWrite(reg) {
      const p = parentOf(reg);
      wIdx[p] = i;
      argIdx[p] = i;
    }

    /* ---------- 主循环 ---------- */
    let i = S;
    for (i = S; i < E; i++) {
      if (skipIdx.has(i)) continue;
      const ins = instrs[i];
      const m = ins.mnem;
      const ops = ins.ops;
      if (addrToLabel[i] && addrToLabel[i] !== fn.name) events.push({ k: 'label', name: addrToLabel[i] });

      // push rbp / mov rbp, rsp 等序言
      if (m === 'push' && ops[0] && ops[0].name === 'rbp' && (i === S || inPrologue)) continue;
      if (m === 'mov' && ops[0] && ops[0].name === 'rbp' && ops[1] && ops[1].name === 'rsp') continue;
      if (m === 'sub' && ops[0] && ops[0].name === 'rsp' && ops[1] && ops[1].kind === 'imm') { rspShift += ops[1].value; continue; }
      if (m === 'add' && ops[0] && ops[0].name === 'rsp' && ops[1] && ops[1].kind === 'imm') { rspShift -= ops[1].value; continue; }
      if (m === 'pop' && ops[0] && ops[0].name === 'rbp') continue;
      if (m === 'leave' || m === 'endbr64') continue;

      switch (m) {
        case 'push': {
          const e = readExpr(ops[0]);
          symStack.push(e);
          rspShift += 8;
          stk[-rspShift] = e;          // 记下"压进去的那个值"，后面 mov esi,[rsp+0] 就能读回来
          inPrologue = false;
          continue;
        }
        case 'pop': {
          const top = stk[-rspShift];
          const e = symStack.length ? symStack.pop() : (top || { t: 'raw', text: '[rsp]' });
          rspShift -= 8;
          if (ops[0]) { sym[parentOf(ops[0].name)] = e; noteWrite(ops[0].name); }
          inPrologue = false;
          continue;
        }
        case 'mov': case 'movzx': case 'movsx': case 'movsxd': case 'lea': {
          inPrologue = false;
          const src = (m === 'lea') ? leaExpr(ops[1]) : readExpr(ops[1]);
          // 类型标注
          const dsz = ops[0].size || (ops[0].kind === 'mem' ? 4 : 0);
          if (m === 'lea') {
            // 取地址，不涉及变量宽度
          } else if (m === 'movsx' || m === 'movzx') {
            // 变量宽度看"源"操作数（是 BYTE 就说明它是 char）
            const ss = ops[1] && ops[1].size;
            noteOperandType(ops[1], ss === 1 ? 'char' : ss === 2 ? 'short' : 'int');
          } else if (ops[1] && ops[1].kind === 'reg' && /^xmm/i.test(ops[1].name)) {
            noteOperandType(ops[0], (ops[0].size === 4) ? 'float' : 'double');
          } else if (ops[0].kind === 'mem') {
            noteOperandType(ops[0], TYPE_BY_SIZE[ops[0].size || 4] || 'int');
          } else if (ops[1] && ops[1].kind === 'mem') {
            noteOperandType(ops[1], TYPE_BY_SIZE[ops[1].size || 4] || 'int');
          }

          if (ops[0].kind === 'mem' && ops[0].base === 'rsp') {
            // 压到栈上传给函数：只是搬运，不产生 C 语句
            stk[(ops[0].disp || 0) - rspShift] = src;
            continue;
          }
          if (ops[0].kind === 'mem') {
            hasMemOp = true;
            const target = readExpr(ops[0]);
            const nm = target.t === 'var' ? target.name
              : target.t === 'index' ? exprText(target)
                : (target.t === 'raw' ? target.text : exprText(target));
            pushAssign({ k: 'assign', name: nm, op: '=', expr: src });
          } else {
            const k2 = parentOf(ops[0].name);
            sym[k2] = src;
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'movsd': case 'movss': {
          sseCount++;
          inPrologue = false;
          const dst = ops[0], s1 = ops[1];
          if (dst.kind === 'reg' && /^xmm/i.test(dst.name)) {
            let e = null;
            if (s1.kind === 'mem' && !s1.base && prog.dataMap) {
              const v = readDoubleAt(prog.dataMap, s1.disp || 0, m === 'movss' ? 4 : 8);
              if (v !== null && Number.isFinite(v)) e = num(Math.round(v * 1e9) / 1e9);
            }
            if (!e && s1.kind === 'reg') e = sym[s1.name] || null;
            if (!e) e = readExpr(s1);
            noteOperandType(s1, m === 'movss' ? 'float' : 'double');
            sym[dst.name] = e;
            noteWrite(dst.name);
          } else {
            noteOperandType(dst, m === 'movss' ? 'float' : 'double');
            if (dst.kind === 'mem' && dst.base === 'rsp') {
              stk[(dst.disp || 0) - rspShift] = sym['xmm0'] || { t: 'raw', text: 'xmm0' };
              continue;
            }
            hasMemOp = true;
            const target = readExpr(dst);
            const nm = target.t === 'var' ? target.name
              : target.t === 'index' ? exprText(target)
                : (target.t === 'raw' ? target.text : exprText(target));
            pushAssign({ k: 'assign', name: nm, op: '=', expr: sym['xmm0'] || { t: 'raw', text: 'xmm0' } });
          }
          continue;
        }
        case 'addsd': case 'subsd': case 'mulsd': case 'divsd':
        case 'addss': case 'subss': case 'mulss': case 'divss': {
          sseCount++;
          inPrologue = false;
          const tk = m === 'addsd' || m === 'subsd' || m === 'mulsd' || m === 'divsd' ? 'double' : 'float';
          const op = { add: '+', sub: '-', mul: '*', div: '/' }[m.slice(0, 3)];
          const a = readExpr(ops[0]);
          const b = readExpr(ops[1]);
          noteOperandType(ops[0], tk);
          noteOperandType(ops[1], tk);
          const e = { t: 'bin', op: op, l: a, r: b };
          if (ops[0].kind === 'mem') {
            hasMemOp = true;
            const nm = a.t === 'var' ? a.name : a.t === 'index' ? exprText(a) : exprText(a);
            pushAssign({ k: 'assign', name: nm, op: '=', expr: e });
          } else {
            sym[parentOf(ops[0].name)] = e;
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'sqrtsd': case 'sqrtss': {
          sseCount++;
          sym[parentOf(ops[0].name)] = { t: 'raw', text: 'sqrt(' + exprText(readExpr(ops[1])) + ')' };
          noteOperandType(ops[1], 'double');
          noteWrite(ops[0].name);
          continue;
        }
        case 'cvtsi2sd': case 'cvtsi2ss': {
          sseCount++;
          const from = (ops[1].kind === 'reg' && sym[parentOf(ops[1].name)]) || readExpr(ops[1]);
          sym[parentOf(ops[0].name)] = { t: 'raw', text: '(double)(' + exprText(from) + ')' };
          noteWrite(ops[0].name);
          continue;
        }
        case 'cvttsd2si': case 'cvttss2si': {
          sseCount++;
          const from = (ops[1].kind === 'reg' && sym[parentOf(ops[1].name)]) || readExpr(ops[1]);
          sym[parentOf(ops[0].name)] = { t: 'raw', text: '(int)(' + exprText(from) + ')' };
          noteOperandType(ops[1], 'double');
          noteWrite(ops[0].name);
          continue;
        }
        case 'cvtsd2ss': case 'cvtss2sd': {
          sseCount++;
          const from = (ops[1].kind === 'reg' && sym[ops[1].name]) || readExpr(ops[1]);
          sym[parentOf(ops[0].name)] = { t: 'raw', text: '(double)(' + exprText(from) + ')' };
          noteWrite(ops[0].name);
          continue;
        }
        case 'ucomisd': case 'comisd': case 'ucomiss': case 'comiss': {
          sseCount++;
          const a = (ops[0].kind === 'reg' && sym[parentOf(ops[0].name)]) || readExpr(ops[0]);
          const b = (ops[1].kind === 'reg' && sym[parentOf(ops[1].name)]) || readExpr(ops[1]);
          noteOperandType(ops[0], 'double');
          noteOperandType(ops[1], 'double');
          lastCmp = { a: a, b: b, test: false, fp: true };
          continue;
        }
        case 'xorpd': case 'xorps': case 'pxor': {
          if (ops[0].kind === 'reg' && ops[1] && ops[0].name === ops[1].name) {
            sym[parentOf(ops[0].name)] = num(0);
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'add': case 'sub': case 'imul': case 'and': case 'or': case 'xor': case 'shl': case 'shr': case 'sar': {
          inPrologue = false;
          if (m === 'add' && ops[0] && ops[0].name === 'rsp') continue;
          if (m === 'sub' && ops[0] && ops[0].name === 'rsp') continue;

          // 三操作数 imul：imul rcx, rcx, 4  —— 这是"下标 × 元素大小"，先记下来
          if (m === 'imul' && ops.length === 3 && ops[0].kind === 'reg') {
            const a3 = readExpr(ops[1]);
            const c3 = ops[2];
            const k3 = parentOf(ops[0].name);
            noteOperandType(ops[0], 'int'); noteOperandType(ops[1], 'int');
            if (c3 && c3.kind === 'imm' && c3.value > 1) {
              sym[k3] = { t: 'scaled', e: a3, scale: c3.value };
            } else {
              sym[k3] = bin('*', a3, readExpr(c3));
            }
            noteWrite(ops[0].name);
            continue;
          }

          // 指针 + 偏移 → 变成"数组基址 + 下标"
          if (m === 'add' && ops[0].kind === 'reg') {
            const dc = sym[parentOf(ops[0].name)];
            const asPtr = dc && (dc.t === 'ptr' || dc.t === 'addr' ||
              (dc.t === 'var' && (isPtrVar(dc.name) || arrSeen.has(dc.name))));
            if (asPtr) {
              const rr = readExpr(ops[1]);
              const k2 = parentOf(ops[0].name);
              const base = (dc.t === 'ptr') ? dc
                : { t: 'ptr', name: dc.name, idx: null, extra: dc.extra || 0 };
              if (rr && rr.t === 'scaled') {
                sym[k2] = { t: 'ptr', name: base.name, idx: rr.e, extra: base.extra || 0, stride: rr.scale };
              } else if (rr && rr.t === 'num') {
                sym[k2] = { t: 'ptr', name: base.name, idx: base.idx, extra: (base.extra || 0) + rr.v };
              } else {
                sym[k2] = { t: 'ptr', name: base.name, idx: rr, extra: base.extra || 0 };
              }
              noteWrite(ops[0].name);
              continue;
            }
          }

          const opTxt = { add: '+', sub: '-', imul: '*', and: '&', or: '|', xor: '^' }[m];
          const rhs = readExpr(ops[1]);
          if (ops[0].kind === 'mem') {
            hasMemOp = true;
            const target = readExpr(ops[0]);
            if (target.t === 'var') {
              const e = opTxt ? bin(opTxt, vr(target.name), rhs) : { t: 'raw', text: target.name + ' ' + m + ' ' + exprText(rhs) };
              pushAssign({ k: 'assign', name: target.name, op: '=', expr: e });
            } else if (target.t === 'index') {
              const nm = exprText(target);
              const e = opTxt ? bin(opTxt, { t: 'index', name: target.name, idx: target.idx }, rhs)
                : { t: 'raw', text: nm + ' ' + m + ' ' + exprText(rhs) };
              pushAssign({ k: 'assign', name: nm, op: '=', expr: e });
            } else {
              pushAssign({ k: 'assign', name: exprText(target), op: '=', expr: { t: 'raw', text: exprText(target) + ' ' + m + ' ' + exprText(rhs) } });
            }
          } else {
            const cur = readExpr(ops[0]);
            const e = opTxt ? bin(opTxt, cur, rhs) : { t: 'raw', text: exprText(cur) + ' ' + m + ' ' + exprText(rhs) };
            sym[parentOf(ops[0].name)] = e;
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'inc': case 'dec': {
          inPrologue = false;
          const delta = m === 'inc' ? 1 : -1;
          if (ops[0].kind === 'mem') {
            hasMemOp = true;
            const target = readExpr(ops[0]);
            if (target.t === 'var') pushAssign({ k: 'assign', name: target.name, op: '=', expr: bin('+', vr(target.name), num(delta)) });
            else if (target.t === 'index') pushAssign({ k: 'assign', name: exprText(target), op: '=', expr: bin('+', target, num(delta)) });
          } else {
            const cur = readExpr(ops[0]);
            sym[parentOf(ops[0].name)] = bin('+', cur, num(delta));
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'neg': {
          inPrologue = false;
          if (ops[0].kind === 'mem') {
            const t = readExpr(ops[0]);
            if (t.t === 'var') pushAssign({ k: 'assign', name: t.name, op: '=', expr: bin('*', vr(t.name), num(-1)) });
          } else { sym[parentOf(ops[0].name)] = bin('*', readExpr(ops[0]), num(-1)); noteWrite(ops[0].name); }
          continue;
        }
        case 'cdq': case 'cqo': case 'nop': case 'not': case 'cdqe': case 'cltq': case 'cwd': case 'cqto': continue;
        case 'idiv': case 'div': {
          inPrologue = false;
          const A = sym['rax'] || { t: 'raw', text: 'eax' };
          const B = readExpr(ops[0]);
          sym['rax'] = { t: 'raw', text: '(' + exprText(A) + ' / ' + exprText(B) + ')' };
          sym['rdx'] = { t: 'raw', text: '(' + exprText(A) + ' % ' + exprText(B) + ')' };
          wIdx['rax'] = i; argIdx['rax'] = i;
          continue;
        }
        case 'cmp': {
          inPrologue = false;
          lastCmp = { a: readExpr(ops[0]), b: readExpr(ops[1]) };
          if (ops[1] && ops[1].kind === 'mem' && (ops[1].size === 8)) noteOperandType(ops[1], 'long');
          continue;
        }
        case 'test': {
          inPrologue = false;
          lastCmp = { a: readExpr(ops[0]), b: readExpr(ops[1]), test: true };
          continue;
        }
        case 'sete': case 'setne': case 'setl': case 'setle': case 'setg': case 'setge':
        case 'seta': case 'setae': case 'setb': case 'setbe': {
          inPrologue = false;
          let cond;
          const mp = { sete: '==', setne: '!=', setl: '<', setle: '<=', setg: '>', setge: '>=', seta: '>', setae: '>=', setb: '<', setbe: '<=' };
          if (lastCmp) cond = { t: 'bin', op: mp[m], l: lastCmp.a, r: lastCmp.b };
          else cond = { t: 'raw', text: '(标志位)' };
          if (ops[0] && ops[0].kind === 'reg') {
            sym[parentOf(ops[0].name)] = { t: 'raw', text: '(' + exprText(cond) + ')' };
            noteWrite(ops[0].name);
          }
          continue;
        }
        case 'jmp': {
          const t = ops[0].label || ops[0].text;
          // 只有"跳到紧跟在后面的出口标签"才算 return，否则保留成跳转（if/else 要靠它）
          if (isExitLabel(t) && addrToLabel[i + 1] === t) { events.push({ k: 'ret', expr: pickRet() }); continue; }
          events.push({ k: 'jump', target: t });
          continue;
        }
        case 'je': case 'jz': case 'jne': case 'jnz': case 'jl': case 'jle': case 'jg': case 'jge':
        case 'ja': case 'jae': case 'jb': case 'jbe': case 'js': case 'jns': {
          inPrologue = false;
          const t = ops[0].label || ops[0].text;
          let cond;
          if (lastCmp) {
            const map = { je: '==', jz: '==', jne: '!=', jnz: '!=', jl: '<', jle: '<=', jg: '>', jge: '>=', ja: '>', jae: '>=', jb: '<', jbe: '<=' };
            if (lastCmp.test && (m === 'je' || m === 'jz')) cond = { t: 'bin', op: '==', l: lastCmp.a, r: num(0) };
            else if (lastCmp.test && (m === 'jne' || m === 'jnz')) cond = { t: 'bin', op: '!=', l: lastCmp.a, r: num(0) };
            else if (m === 'js' || m === 'jns') {
              cond = { t: 'bin', op: m === 'js' ? '<' : '>=', l: lastCmp.a, r: num(0) };
            } else {
              cond = { t: 'bin', op: map[m], l: lastCmp.a, r: lastCmp.b };
            }
          } else {
            cond = { t: 'raw', text: '(标志位条件)' };
          }
          events.push({ k: 'branch', cond: cond, target: t, mnem: m });
          lastCmp = null;
          continue;
        }
        case 'call': {
          inPrologue = false;
          const name = ops[0].label || ops[0].text;
          const pick = r => (argIdx[r] !== undefined && argIdx[r] > lastCallIdx && sym[r]) ? sym[r] : null;
          const ints = ARG_I.map(pick);
          const flts = ARG_X.map(pick);
          const fmtExpr = ints[0];
          const fmtStr = (fmtExpr && fmtExpr.t === 'str') ? fmtExpr.v : null;
          let args = [];

          if (fmtStr && /printf/.test(name)) {
            // printf 的参数个数由格式串决定，顺序也按格式串里的转换符排
            args.push(fmtExpr);
            let ii = 1, xi = 0;
            const re = /%[-+ 0#]*\d*(?:\.\d+)?(?:l{1,2}|h{1,2}|z)?([diuoxXcsfgFeEGpa%])/g;
            let mm;
            while ((mm = re.exec(fmtStr))) {
              const cv = mm[1];
              if (cv === '%') continue;
              if ('fgeEFG'.indexOf(cv) >= 0) { if (flts[xi]) args.push(flts[xi]); xi++; }
              else { if (ints[ii]) args.push(ints[ii]); ii++; }
            }
          } else if (fmtStr && /puts|putchar/.test(name)) {
            args.push(fmtExpr);
          } else {
            for (let k = 0; k < ARG_I.length; k++) {
              if (ints[k]) args.push(ints[k]); else break;
            }
            flts.forEach(e => { if (e) args.push(e); });
          }

          // 已知被调函数有几个参数，就只取几个，避免把上一个表达式残留的寄存器算进来
          const want = (ctx.sigCount && ctx.sigCount[name] !== undefined) ? ctx.sigCount[name] : -1;
          if (want >= 0 && args.length > want) args = args.slice(0, want);

          const ev = { k: 'call', name: name, args: args, fmt: null };
          events.push(ev);
          lastCallIdx = i;
          // 先清掉 caller-saved 的旧符号值，再把返回值引用到返回寄存器
          CALLER_SAVED.forEach(r => { if (params.every(p => p.reg !== r)) { delete sym[r]; } });
          const fRet = ctx.sigFloat && ctx.sigFloat[name];
          if (fRet) { sym['xmm0'] = { t: 'callref', ev: ev }; wIdx['xmm0'] = i; }
          else { sym['rax'] = { t: 'callref', ev: ev }; wIdx['rax'] = i; }
          argIdx['rax'] = i;
          lastCmp = null;
          continue;
        }
        case 'ret': {
          events.push({ k: 'ret', expr: pickRet() });
          continue;
        }
        default: continue;
      }
    }

    function pickRet() {
      const rx = wIdx['rax'];
      const fx = wIdx['xmm0'];
      if (fx !== undefined && (rx === undefined || fx > rx)) { floatRet = true; return sym['xmm0'] || null; }
      // 值已经存回内存了（比如 *p = *p + 1），说明它不是返回值
      if (rx !== undefined && rx < lastStore) return null;
      const e = sym['rax'];
      if (e && e.t === 'var') {
        const t = typeOf.get(e.name);
        if (t === 'double' || t === 'float') floatRet = true;
      }
      return e || null;
    }

    /* ---------- 后处理：把"其实不是数组"的下标 0 还原成普通变量 ---------- */
    function isArr(name) { return (arrSeen.get(name) || 0) > 0; }
    // 指针变量虽然也用 p[i] 访问，但声明要是 int*，不能写成数组
    function isArrReal(name) { return isArr(name) && !isPtrVar(name); }
    function fixExpr(e) {
      if (!e || typeof e !== 'object') return e;
      if (e.t === 'index' && e.idx === 0 && !isArrReal(e.name)) {
        return isPtrVar(e.name) ? { t: 'raw', text: '*' + e.name } : vr(e.name);
      }
      if (e.t === 'var' && isArrReal(e.name)) return { t: 'index', name: e.name, idx: 0 };
      if (e.t === 'bin') return { t: 'bin', op: e.op, l: fixExpr(e.l), r: fixExpr(e.r) };
      if (e.t === 'addr') return e;
      return e;
    }
    events.forEach(ev => {
      if (ev.cond) ev.cond = fixExpr(ev.cond);
      if (ev.expr) ev.expr = fixExpr(ev.expr);
      if (ev.args) ev.args = ev.args.map(fixExpr);
      // 对数组的第一次赋值，写的是第 0 个元素
      if (ev.k === 'assign' && ev.name && ev.name.indexOf('[') < 0 && isArrReal(ev.name)) ev.name = ev.name + '[0]';
      // 指针变量解引用写作 *p，与读取时的写法保持一致
      if (ev.k === 'assign' && ev.name) {
        const m0 = ev.name.match(/^(\w+)\[0\]$/);
        if (m0 && isPtrVar(m0[1])) ev.name = '*' + m0[1];
      }
    });

    /* ---------- 结构化 ---------- */
    const labelIdx = {};
    events.forEach((e, k) => { if (e.k === 'label') labelIdx[e.name] = k; });
    const tree = structure(events, 0, events.length, labelIdx, 0);

    /* ---------- 声明 ---------- */
    const decls = [];
    const paramNames = new Set(params.map(p => p.name));
    // 直接把编译器的类型字符串拼成声明，最准确
    function declLine(name) {
      const rec = varRec(name);
      const ts = (rec && fTypes && fTypes.get) ? fTypes.get(rec.off) : null;
      if (typeof ts === 'string' && ts) {
        const am = ts.match(/^(.*?)((?:\[\d*\])+)$/);
        if (am) return am[1] + ' ' + name + am[2] + ';';
        if (/\*$/.test(ts)) return ts.replace(/\s*\*.*$/, ' *') + name + ';';
        return ts + ' ' + name + ';';
      }
      const t = typeOf.get(name) || 'int';
      if (isArrReal(name)) return t + ' ' + name + '[' + ((arrSeen.get(name) || 0) + 1) + '];';
      if (isPtrVar(name)) return t + ' *' + name + ';';
      return t + ' ' + name + ';';
    }
    usedVars.forEach(v => {
      if (paramNames.has(v.name)) return;
      decls.push(declLine(v.name));
    });
    temps.forEach(t => decls.push('long ' + t + ';'));

    /* ---------- 渲染 ---------- */
    const lines = [];
    const notes = [];
    const fname = fn.name || 'func_0x' + (instrs[S] ? instrs[S].addr.toString(16) : '0');
    const hasRetVal = events.some(e => e.k === 'ret' && e.expr);
    const retType = (fname === 'main' || fname === '_start') ? 'int'
      : floatRet ? 'double'
        : (hasRetVal ? 'int' : 'void');
    const sig = params.map(p => {
      const rec = varRec(p.name);
      const ts = (rec && fTypes && fTypes.get) ? fTypes.get(rec.off) : null;
      if (typeof ts === 'string' && ts) {
        if (/\*$/.test(ts)) return ts.replace(/\s*\*.*$/, ' *') + p.name;
        return ts + ' ' + p.name;
      }
      if (isArrReal(p.name) || isPtrVar(p.name)) return 'int *' + p.name;
      return p.type + ' ' + p.name;
    }).join(', ');
    lines.push(retType + ' ' + fname + '(' + sig + ') {');
    decls.forEach(d => lines.push('    ' + d));
    if (decls.length) lines.push('');

    const hasAssign = events.some(e => e.k === 'assign' || e.k === 'call' || e.k === 'ret');
    if (!hasAssign) {
      lines.push('    /* 这段代码没有可还原的语句（可能只是数据或空函数） */');
    } else {
      renderNodes(tree, 1, lines, notes);
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('}');

    if (!usedVars.length && !params.length) notes.push('这段代码没有使用栈上的局部变量，也可能只是片段。');
    if (guessArr.size) notes.push('数组 ' + [...guessArr].join('、') + ' 的长度是按"下标可以是变量"猜的，实际长度要看原始代码。');
    if (sseCount) notes.push('含浮点（SSE）指令：xmm 上的运算已还原成浮点表达式，常量从 .quad 按 IEEE-754 解出。');

    return {
      ok: true,
      name: fname,
      retType: retType,
      params: params,
      code: lines.join('\n'),
      notes: notes,
      tree: tree,
      events: events,
      vars: usedVars.map(v => ({ name: v.name, off: v.off, type: typeOf.get(v.name) || 'int', isParam: !!v.isParam, arrLen: isArr(v.name) ? (arrSeen.get(v.name) + 1) : 0 })),
      hasPrologue: true
    };
  }

  /* ============================================================
   * 3. 结构化：label 回跳 → while；branch+jmp → if/else
   * ============================================================ */
  function structure(evs, start, end, li, depth) {
    const out = [];
    let i = start;
    let guard = 0;
    while (i < end && guard++ < 4000) {
      const ev = evs[i];
      if (ev.k === 'label') {
        const backIdx = findBackJump(evs, i, end, ev.name);
        if (backIdx > i) {
          const exitIdx = findExitBranch(evs, i, backIdx, li, end);
          if (exitIdx >= 0) {
            const exitTargetIdx = li[evs[exitIdx].target];
            const body = structure(evs, exitIdx + 1, backIdx, li, depth + 1);
            out.push({ k: 'while', cond: negCond(evs[exitIdx].cond), body: body, label: ev.name, exitLabel: evs[exitIdx].target });
            if (exitTargetIdx !== undefined && exitTargetIdx > backIdx) { i = exitTargetIdx + 1; continue; }
            i = backIdx + 1; continue;
          }
          // 往回跳但找不到出口条件：无条件的死循环
          const body = structure(evs, i + 1, backIdx, li, depth + 1);
          out.push({ k: 'while', cond: { t: 'raw', text: '1' }, body: body, raw: true });
          i = backIdx + 1; continue;
        }
        // do-while：没有 jmp 回跳，而是"条件分支往回跳"
        const backBr = findBackBranch(evs, i, end, ev.name, li);
        if (backBr > i) {
          const body = structure(evs, i + 1, backBr, li, depth + 1);
          out.push({ k: 'dowhile', cond: evs[backBr].cond, body: body });
          i = backBr + 1; continue;
        }
        i++; continue;
      }
      if (ev.k === 'branch') {
        const t = li[ev.target];
        if (t !== undefined && t > i && t <= end) {
          const prev = evs[t - 1];
          if (prev && prev.k === 'jump' && li[prev.target] !== undefined && li[prev.target] > t && li[prev.target] <= end) {
            const endIdx = li[prev.target];
            const thenB = structure(evs, i + 1, t - 1, li, depth + 1);
            const elseB = structure(evs, t + 1, endIdx, li, depth + 1);
            out.push({ k: 'if', cond: negCond(ev.cond), then: thenB, els: elseB, hasElse: true });
            i = endIdx + 1; continue;
          }
          const thenB = structure(evs, i + 1, t, li, depth + 1);
          out.push({ k: 'if', cond: negCond(ev.cond), then: thenB, els: null });
          i = t; continue;
        }
        out.push({ k: 'raw', text: 'if (' + exprText(ev.cond) + ') goto ' + ev.target + ';' });
        i++; continue;
      }
      if (ev.k === 'jump') { out.push({ k: 'raw', text: 'goto ' + ev.target + ';' }); i++; continue; }
      out.push(ev);
      i++;
    }
    return out;
  }

  function findBackJump(evs, start, end, name) {
    for (let i = end - 1; i > start; i--) {
      if (evs[i].k === 'jump' && evs[i].target === name) return i;
    }
    return -1;
  }

  function findExitBranch(evs, start, backIdx, li, end) {
    for (let i = start + 1; i < backIdx; i++) {
      if (evs[i].k === 'branch') {
        const t = li[evs[i].target];
        if (t !== undefined && t > backIdx) return i;
      }
    }
    return -1;
  }

  // 往回跳的"条件分支"——do-while 的形态
  function findBackBranch(evs, start, end, name, li) {
    const t = li[name];
    for (let i = end - 1; i > start; i--) {
      if (evs[i].k === 'branch' && evs[i].target === name) return i;
    }
    return -1;
  }

  function renderNodes(nodes, indent, lines, notes) {
    const pad = '    '.repeat(indent);
    // 调用结果的表达式若正好被下一句 return 用掉，就不再单独占一行
    (nodes || []).forEach((n, idx) => {
      if (n.k !== 'call') return;
      const nx = nodes[idx + 1];
      if (!nx || !nx.expr) return;
      const callTxt = n.name + '(' + (n.args || []).map(exprText).join(', ') + ')';
      if (exprText(nx.expr).indexOf(callTxt) >= 0) n._skipStmt = true;
    });
    (nodes || []).forEach(n => {
      if (n.k === 'assign') {
        if (n.name && n.name[0] === '&') return;   // 地址不能当左值，宁可不显示
        lines.push(pad + n.name + ' = ' + exprText(n.expr) + ';');
      } else if (n.k === 'call') {
        if (n.name === '__stack_chk_fail' || n._skipStmt) return;
        const args = (n.args || []).map(exprText);
        lines.push(pad + n.name + '(' + args.join(', ') + ');');
      } else if (n.k === 'ret') {
        const e = n.expr ? exprText(n.expr) : null;
        const bad = !e || e === 'eax' || e === 'rax' || /^\(.*\)\(\)$/.test(e);
        const line = pad + (bad ? 'return;' : 'return ' + e + ';');
        const prev = (lines[lines.length - 1] || '').trim();
        if (prev.indexOf('return') === 0 && prev === line.trim()) return;
        lines.push(line);
      } else if (n.k === 'if') {
        lines.push(pad + 'if (' + exprText(n.cond) + ') {');
        renderNodes(n.then, indent + 1, lines, notes);
        if (n.els && n.els.length) {
          lines.push(pad + '} else {');
          renderNodes(n.els, indent + 1, lines, notes);
        }
        lines.push(pad + '}');
      } else if (n.k === 'while') {
        if (n.raw) lines.push(pad + 'while (1) {   /* 汇编里是"回跳到开头"，循环条件可能藏在 break 里 */');
        else lines.push(pad + 'while (' + exprText(n.cond) + ') {');
        renderNodes(n.body, indent + 1, lines, notes);
        lines.push(pad + '}');
      } else if (n.k === 'dowhile') {
        lines.push(pad + 'do {');
        renderNodes(n.body, indent + 1, lines, notes);
        lines.push(pad + '} while (' + exprText(n.cond) + ');');
      } else if (n.k === 'raw') {
        lines.push(pad + '/* 无法自动还原：' + n.text + ' */');
      }
    });
  }

  /* ============================================================
   * 4. 入口
   * ============================================================ */
  function decompile(prog, ctx) {
    ctx = ctx || {};
    const instrs = prog.instrs;
    if (!instrs || !instrs.length) {
      return { ok: false, code: '; 没有可反汇编的指令', notes: [], tree: [], events: [], vars: [], fns: [] };
    }

    let fns = [];
    try { fns = findFunctions(prog); } catch (e) { fns = [{ name: null, start: 0, end: instrs.length }]; }

    const floatG = new Set();
    const gmeta = new Map();
    let gdecls = [];
    try { gdecls = dataDecls(prog, floatG, gmeta); } catch (e) { gdecls = []; }

    // 先扫一遍各函数的参数个数，供"调用点只取这么多个参数"使用
    const sigCount = {};
    const sigFloat = {};
    fns.forEach(f => {
      if (!f.name) return;
      try {
        sigCount[f.name] = detectParamRegs(prog, f.start, f.end).length;
        sigFloat[f.name] = detectRetFloat(prog, f.start, f.end);
      } catch (e) { }
    });

    const subCtx = Object.assign({}, ctx, { floatG: floatG, gmeta: gmeta, sigCount: sigCount, sigFloat: sigFloat });

    const parts = [];
    const allNotes = [];
    const allVars = [];
    const allTree = [];
    const allEvents = [];
    const fnsMeta = [];

    fns.forEach(f => {
      if (f.end <= f.start) return;
      let r;
      try {
        r = decompileFn(prog, f, subCtx);
      } catch (e) {
        r = { ok: false, code: '/* 这一段反编译失败：' + e.message + ' */', notes: [], tree: [], events: [], vars: [] };
      }
      parts.push(r.code);
      (r.notes || []).forEach(n => { if (allNotes.indexOf(n) < 0) allNotes.push(n); });
      (r.vars || []).forEach(v => allVars.push(v));
      allTree.push.apply(allTree, r.tree || []);
      allEvents.push.apply(allEvents, r.events || []);
      fnsMeta.push({ name: r.name || f.name, retType: r.retType, params: r.params || [] });
    });

    if (parts.length > 1) {
      const names = fnsMeta.map(f => f.name).filter(Boolean);
      allNotes.unshift('这段汇编里有 ' + parts.length + ' 个函数' + (names.length ? '（' + names.join('、') + '）' : '') +
        '，已按"标签 + 函数序言"自动切开，逐个还原。');
    }

    const head = gdecls.length ? ('/* 数据段里的全局变量 */\n' + gdecls.join('\n')) : '';
    if (gdecls.length) allNotes.push('数据段里的全局变量已按宽度还原（4 字节→int、8 字节→long/double），初值直接读出来的。');

    return {
      ok: true,
      code: (head ? head + '\n\n' : '') + parts.join('\n\n'),
      notes: allNotes,
      tree: allTree,
      events: allEvents,
      vars: allVars,
      fns: fnsMeta,
      hasPrologue: true
    };
  }

  const API = { decompile: decompile, exprText: exprText, findFunctions: findFunctions };
  global.ASM_DECOMP = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
