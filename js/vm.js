/* ============================================================
 * 汇编器 + x86-64 子集模拟器
 * 目的：让"逐行分析"和"内存动画"基于真实执行结果，而不是编造
 * 支持：mov/movzx/movsx/lea/push/pop/add/sub/inc/dec/imul/idiv/div
 *       cdq/cqo/neg/and/or/xor/not/shl/shr/sar/cmp/test/setcc/jmp/jcc
 *       call/ret/leave/nop/xchg，以及 .section/.string/.long 等伪指令
 * ============================================================ */
(function (global) {
  'use strict';

  const CODE_BASE = 0x401000;
  const DATA_BASE = 0x404000;
  const STACK_TOP = 0x7ffd0000;
  const RET_SENTINEL = 0xdead0000;
  const MAX_STEPS = 200000;

  /* ---------------- 寄存器表 ---------------- */
  const FAM = [
    ['rax', 'eax', 'ax', 'al', 'ah'],
    ['rbx', 'ebx', 'bx', 'bl', 'bh'],
    ['rcx', 'ecx', 'cx', 'cl', 'ch'],
    ['rdx', 'edx', 'dx', 'dl', 'dh'],
    ['rsi', 'esi', 'si', 'sil', null],
    ['rdi', 'edi', 'di', 'dil', null],
    ['rbp', 'ebp', 'bp', 'bpl', null],
    ['rsp', 'esp', 'sp', 'spl', null]
  ];
  for (let i = 8; i <= 15; i++) FAM.push(['r' + i, 'r' + i + 'd', 'r' + i + 'w', 'r' + i + 'b', null]);

  const RMAP = {};
  FAM.forEach(f => {
    const add = (n, size, off) => { if (n) RMAP[n] = { parent: f[0], size, off }; };
    add(f[0], 8, 0); add(f[1], 4, 0); add(f[2], 2, 0);
    add(f[3], 1, 0); add(f[4], 1, 1);
  });
  RMAP['rip'] = { parent: 'rip', size: 8, off: 0 };
  RMAP['eip'] = { parent: 'rip', size: 4, off: 0 };

  // SSE 寄存器：xmm0~xmm15（教学模拟器中每个都能存一个 double）
  const XMMS = [];
  for (let i = 0; i <= 15; i++) {
    const nm = 'xmm' + i;
    XMMS.push(nm);
    RMAP[nm] = { parent: nm, size: 16, xmm: true, idx: i };
  }

  const GPRS = FAM.map(f => f[0]).concat(['rip']);

  function regInfo(name) { return RMAP[String(name).toLowerCase()] || null; }

  /* ---------------- 位运算工具（BigInt 保证 64 位精确） ---------------- */
  const ONE = 1n;
  function bigBits(bits) { return BigInt(bits); }
  function maskOf(bits) { return (ONE << bigBits(bits)) - ONE; }
  const toBig = v => (typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v))));
  const uN = (v, bits) => BigInt.asUintN(bits, toBig(v));
  function signedOf(v, bits) {
    const half = ONE << (bigBits(bits) - ONE);
    const m = uN(v, bits);
    return m >= half ? m - (ONE << bigBits(bits)) : m;
  }
  function arith(op, a, b, bits) {
    const A = uN(a, bits), Bv = uN(b, bits), mask = maskOf(bits), half = ONE << (bigBits(bits) - ONE);
    let r, cf = false, of = false;
    if (op === 'add') { const s = A + Bv; cf = s > mask; r = BigInt.asUintN(bits, s); of = (signedOf(A, bits) + signedOf(Bv, bits)) !== signedOf(r, bits); }
    else if (op === 'sub') { const s = A - Bv; cf = A < Bv; r = BigInt.asUintN(bits, s); of = (signedOf(A, bits) - signedOf(Bv, bits)) !== signedOf(r, bits); }
    else if (op === 'and') { r = A & Bv; }
    else if (op === 'or') { r = A | Bv; }
    else if (op === 'xor') { r = A ^ Bv; }
    else if (op === 'mul') { r = BigInt.asUintN(bits, signedOf(A, bits) * signedOf(Bv, bits)); of = BigInt.asUintN(bits, signedOf(A, bits) * signedOf(Bv, bits)) !== signedOf(A, bits) * signedOf(Bv, bits); }
    else throw new Error('未知运算 ' + op);
    return { res: Number(BigInt.asIntN(bits, r)), cf, of, zf: r === 0n, sf: (r & half) !== 0n, big: r };
  }

  /* ---------------- 汇编器 ---------------- */
  function splitComment(line) {
    let inQ = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === '\\') { i++; continue; } if (c === inQ) inQ = null; continue; }
      if (c === '"' || c === "'") { inQ = c; continue; }
      if (c === ';' || c === '#') return { code: line.slice(0, i), comment: line.slice(i + 1).trim() };
    }
    return { code: line, comment: '' };
  }

  function unescapeStr(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') {
        const c = s[++i];
        out += ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" })[c] !== undefined
          ? ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" })[c] : c;
      } else out += s[i];
    }
    return out;
  }

  function splitOps(s) {
    const out = []; let depth = 0, cur = '', inQ = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) { cur += c; if (c === inQ) inQ = null; continue; }
      if (c === '"' || c === "'") { inQ = c; cur += c; continue; }
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseMemExpr(str, labels, errs, lineNo) {
    let s = str.replace(/\s+/g, '');
    if (s[0] === '+') s = s.slice(1);
    const parts = s.match(/[+\-][^+\-]+|[^+\-]+/g) || [];
    let base = null, index = null, scale = 1, disp = 0, sym = null;
    parts.forEach(p => {
      let sg = 1;
      if (p[0] === '+') p = p.slice(1);
      else if (p[0] === '-') { sg = -1; p = p.slice(1); }
      if (!p) return;
      if (/^(rip|eip)$/i.test(p)) return;          // 位置无关代码：本模拟器直接按绝对地址处理
      if (p.indexOf('*') >= 0) {
        const seg = p.split('*');
        const r1 = regInfo(seg[0]), r2 = regInfo(seg[1]);
        if (r1) { index = r1.parent; scale = parseInt(seg[1], 10) || 1; }
        else if (r2) { index = r2.parent; scale = parseInt(seg[0], 10) || 1; }
        return;
      }
      const ri = regInfo(p);
      if (ri) { base = ri.parent; return; }
      if (/^(0x[0-9a-f]+|\d+)$/i.test(p)) { disp += sg * (/^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10)); return; }
      // 符号（标签）
      const L = labels.get(p);
      if (L) { disp += sg * (L.kind === 'data' ? L.addr : CODE_BASE + L.index); }
      else {
        sym = p;
        if (errs) errs.push('第 ' + lineNo + ' 行：找不到标签 "' + p + '"');
      }
    });
    return { base, index, scale, disp, sym };
  }

  function parseOperand(text, labels, errs, lineNo) {
    let raw = text.trim();
    let size = 0;
    const m = raw.match(/^(byte|word|dword|qword)\s+ptr\s*(.*)$/i);
    if (m) { size = { byte: 1, word: 2, dword: 4, qword: 8 }[m[1].toLowerCase()]; raw = m[2].trim(); }
    // GCC 风格：.LC0[rip] / arr[rip+rax*4]
    const ripForm = raw.match(/^(.*)\[\s*(?:rip|eip)\s*([+\-][^\]]*)?\]$/i);
    if (ripForm && ripForm[1].trim()) {
      const mem = parseMemExpr(ripForm[1] + (ripForm[2] || ''), labels, errs, lineNo);
      mem.kind = 'mem'; mem.size = size; mem.text = text.trim(); mem.rip = true;
      return mem;
    }
    if (raw[0] === '[' && raw[raw.length - 1] === ']') {
      const mem = parseMemExpr(raw.slice(1, -1), labels, errs, lineNo);
      mem.kind = 'mem'; mem.size = size; mem.text = text.trim();
      return mem;
    }
    const ri = regInfo(raw);
    if (ri) return { kind: 'reg', name: raw.toLowerCase(), size: ri.size, reg: ri, text: text.trim() };
    if (/^-?(0x[0-9a-f]+|\d+)$/i.test(raw)) {
      const v = /^-?0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
      return { kind: 'imm', value: v, size: size || 4, text: text.trim() };
    }
    if (/^[+-]?(0x[0-9a-f]+|\d+)([+\-](0x[0-9a-f]+|\d+))+$/i.test(raw)) {
      // 简单常量表达式，如 10+5
      let total = 0;
      (raw.match(/[+\-]?[^+\-]+/g) || []).forEach(p => {
        let sg = 1; if (p[0] === '+') p = p.slice(1); else if (p[0] === '-') { sg = -1; p = p.slice(1); }
        total += sg * (/0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10));
      });
      return { kind: 'imm', value: total, size: size || 4, text: text.trim() };
    }
    const L = labels.get(raw);
    if (L) {
      const v = L.kind === 'data' ? L.addr : CODE_BASE + L.index;
      return { kind: 'imm', value: v, size: 8, text: text.trim(), label: raw, labelKind: L.kind };
    }
    return { kind: 'imm', value: 0, size: 4, text: text.trim(), suspect: raw };
  }

  function assemble(src) {
    const errs = [];
    const rawLines = (src || '').split('\n');
    const labels = new Map();
    const instrRaw = [];   // 待解析的指令 {lineNo, text, comment, mnem, ops:[]}
    const dataMap = new Map();
    let dataPtr = DATA_BASE;
    let section = 'text';
    const stringSegs = [];  // 供界面展示
    const pending = [];      // 第一遍：按顺序记录 label / instruction
    let pendingLabel = null; // 上一个标签名（用于判断它属于数据还是代码）

    // 若上一条标签后面紧跟数据伪指令，则把它改成数据标签
    function bindDataLabel() {
      if (pendingLabel && labels.has(pendingLabel)) {
        const L = labels.get(pendingLabel);
        if (L.kind !== 'data') { L.kind = 'data'; L.addr = dataPtr; }
      }
      pendingLabel = null;
    }

    function writeBytes(addr, bytes) {
      bytes.forEach((b, i) => dataMap.set(addr + i, b & 0xff));
    }

    rawLines.forEach((raw, idx) => {
      const lineNo = idx + 1;
      const sp = splitComment(raw);
      let code = sp.code.trim();
      if (!code) return;

      // 标签（必须在伪指令判断之前，因为 .L1: 也是以点开头）
      const lm = code.match(/^([A-Za-z_.$][\w.$]*)\s*:\s*(.*)$/);
      if (lm) {
        const name = lm[1];
        // 先按代码标签登记（保证前向跳转可解析），紧跟数据伪指令时会改判为数据标签
        labels.set(name, { kind: 'code', index: pending.filter(p => p.kind === 'instr').length });
        pendingLabel = name;
        if (lm[2]) code = lm[2].trim(); else return;
      }

      // 伪指令
      if (code[0] === '.') {
        const dm = code.match(/^\.(\w+)\s*(.*)$/);
        const d = dm ? dm[1].toLowerCase() : '';
        const rest = dm ? dm[2].trim() : '';
        if (['section', 'text', 'data', 'rodata', 'bss', 'globl', 'global', 'type', 'size', 'align', 'p2align', 'intel_syntax', 'att_syntax', 'file', 'ident', 'cfi_startproc', 'cfi_endproc'].indexOf(d) >= 0) {
          if (d === 'section') {
            const nm = rest.replace(/^\./, '');
            section = /data|rodata|bss/.test(nm) ? 'data' : 'text';
          } else if (['text', 'data', 'rodata', 'bss'].indexOf(d) >= 0) {
            section = (d === 'data' || d === 'rodata' || d === 'bss') ? 'data' : 'text';
          }
          return;
        }
        if (d === 'string' || d === 'ascii' || d === 'asciz') {
          bindDataLabel();
          const mm = rest.match(/^"([\s\S]*)"$/);
          const txt = mm ? unescapeStr(mm[1]) : rest;
          const bytes = [];
          for (let i = 0; i < txt.length; i++) bytes.push(txt.charCodeAt(i));
          if (d !== 'ascii') bytes.push(0);
          writeBytes(dataPtr, bytes);
          stringSegs.push({ addr: dataPtr, text: txt, len: bytes.length });
          dataPtr += bytes.length;
          dataPtr = Math.ceil(dataPtr / 8) * 8;
          return;
        }
        if (['byte', 'word', 'long', 'int', 'quad', 'zero', 'space'].indexOf(d) >= 0) {
          bindDataLabel();
          if (d === 'zero' || d === 'space') { dataPtr += parseInt(rest, 10) || 0; return; }
          const unit = { byte: 1, word: 2, long: 4, int: 4, quad: 8 }[d];
          splitOps(rest).forEach(x => {
            const raw = String(x).trim();
            let bv = 0n;
            if (/^[-+]?0x[0-9a-f]+$/i.test(raw)) {
              bv = BigInt(raw.replace(/^[+]/, ''));
            } else if (/^[-+]?\d+$/.test(raw)) {
              bv = BigInt(raw);
            }
            const u = BigInt.asUintN(unit * 8, bv);
            const bytes = [];
            for (let k = 0; k < unit; k++) bytes.push(Number((u >> BigInt(8 * k)) & 0xffn));
            writeBytes(dataPtr, bytes);
            dataPtr += unit;
          });
          dataPtr = Math.ceil(dataPtr / 8) * 8;
          return;
        }
        return; // 其它伪指令忽略
      }

      // 标签
      // （已在上方处理）

      const parts = code.split(/\s+/);
      const mnem = parts[0].toLowerCase();
      const opStr = code.slice(parts[0].length).trim();
      pendingLabel = null; // 标签后面是可执行指令 → 保持代码标签
      pending.push({ kind: 'instr', lineNo, mnem, opStr, text: raw.trim(), comment: sp.comment, addr: CODE_BASE + instrRaw.length });
      instrRaw.push({ lineNo });
    });

    // 第二遍：解析操作数
    const instrs = pending.filter(p => p.kind === 'instr').map((p, i) => {
      const ops = p.opStr ? splitOps(p.opStr).map(o => parseOperand(o, labels, errs, p.lineNo)) : [];
      // 跳转/调用目标允许是"尚未登记为标签"的符号（如 call printf）
      const isBranch = p.mnem === 'call' || p.mnem === 'jmp' || p.mnem[0] === 'j';
      if (isBranch && ops[0] && ops[0].suspect) {
        ops[0] = { kind: 'imm', value: 0, size: 8, text: ops[0].text, label: ops[0].suspect };
      }
      const ins = {
        index: i, addr: CODE_BASE + i, lineNo: p.lineNo, mnem: p.mnem, ops,
        text: p.text, comment: p.comment, opStr: p.opStr
      };
      // 校验
      const need = INSTR_ARITY[p.mnem];
      if (need === undefined) errs.push('第 ' + p.lineNo + ' 行：不认识的指令 "' + p.mnem + '"');
      else if (need >= 0 && ops.length !== need) errs.push('第 ' + p.lineNo + ' 行：' + p.mnem + ' 需要 ' + need + ' 个操作数，实际给了 ' + ops.length + ' 个');
      ops.forEach(o => { if (o.suspect) errs.push('第 ' + p.lineNo + ' 行：无法识别的操作数 "' + o.suspect + '"'); });
      return ins;
    });

    // 标签 → 指令下标（供跳转）
    labels.forEach((v, k) => { if (v.kind === 'code' && v.index > instrs.length) v.index = instrs.length; });

    return { ok: errs.length === 0, instrs, labels, dataMap, strings: stringSegs, errors: errs };
  }

  const INSTR_ARITY = {
    mov: 2, movzx: 2, movsx: 2, movsxd: 2, lea: 2, xchg: 2,
    push: 1, pop: 2, add: 2, sub: 2, imul: -1, idiv: 1, div: 1, cdq: 0, cqo: 0,
    neg: 1, and: 2, or: 2, xor: 2, not: 1, shl: 2, sal: 2, shr: 2, sar: 2,
    cmp: 2, test: 2, inc: 1, dec: 1, jmp: 1, call: 1, ret: 0, leave: 0, nop: 0,
    sete: 1, setne: 1, setl: 1, setle: 1, setg: 1, setge: 1, seta: 1, setae: 1, setb: 1, setbe: 1,
    je: 1, jz: 1, jne: 1, jnz: 1, jl: 1, jle: 1, jg: 1, jge: 1, ja: 1, jae: 1, jb: 1, jbe: 1,
    int3: 0, hlt: 0,
    // ── 浮点 / SSE ──
    movsd: 2, movss: 2, movd: 2, movq: 2, movaps: 2, movups: 2,
    addsd: 2, subsd: 2, mulsd: 2, divsd: 2,
    addss: 2, subss: 2, mulss: 2, divss: 2,
    ucomisd: 2, comisd: 2, ucomiss: 2, comiss: 2,
    cvtsi2sd: 2, cvtsi2ss: 2, cvttsd2si: 2, cvttss2si: 2,
    cvtsd2ss: 2, cvtss2sd: 2,
    xorpd: 2, xorps: 2, pxor: 2,
    sqrtsd: 2,
    // ── 其它整数指令 ──
    cdqe: 0, cltq: 0, cwd: 0, cqto: 0,
    adc: 2, sbb: 2,
    cmove: 2, cmovne: 2, cmovl: 2, cmovg: 2, cmovle: 2, cmovge: 2
  };
  // pop 允许 0 个操作数（极少见），用 -1 宽容处理
  INSTR_ARITY.pop = -1;

  /* ---------------- 机器 ---------------- */
  function Machine(prog) {
    this.prog = prog;
    this.instrs = prog.instrs;
    this.labels = prog.labels;
    this.reset();
  }

  Machine.prototype.reset = function () {
    this.regs = {};
    GPRS.forEach(r => this.regs[r] = 0);
    this.xmm = new Float64Array(16);
    this.regs.rsp = STACK_TOP;
    // 模拟"被调用"的状态：rbp 已有一个合理的正值，[rsp] 处是返回地址，
    // 这样即使代码没有序言，rbp 相对寻址也能落在正确区间
    this.regs.rbp = STACK_TOP;
    this.regs.rip = CODE_BASE;
    this.flags = { ZF: 0, SF: 0, CF: 0, OF: 0 };
    this.mem = new Map();
    this.prog.dataMap.forEach((v, k) => this.mem.set(k, v));
    this.halted = false;
    this.haltReason = '';
    this.steps = 0;
    this.output = '';
    this.lastStep = null;
    this.errorMsg = '';
    this.frameRbp = 0;   // 记录执行过程中最深的栈帧基址，供程序结束后回看

    // 入口
    const entry = this.labels.get('main') || this.labels.get('_start') || this.labels.get('start');
    this.ip = entry ? entry.index : 0;
    this.entryIsMain = !!entry;
    if (this.entryIsMain) {
      // 模拟"被 C 运行时调用"：返回地址已经在 [rsp] 上（不额外移动 rsp）
      this.writeMem(this.regs.rsp, 8, RET_SENTINEL);
    }
  };

  Machine.prototype.readMem = function (addr, size) {
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) {
      const b = this.mem.get(addr + i) || 0;
      v = (v << 8n) | BigInt(b & 0xff);
    }
    // 8 字节读按有符号解释，避免超过 2^53 时丢精度
    return size === 8 ? Number(BigInt.asIntN(64, v)) : Number(v);
  };
  Machine.prototype.writeMem = function (addr, size, value) {
    const bv = uN(value, Math.max(size * 8, 8));
    for (let i = 0; i < size; i++) {
      this.mem.set(addr + i, Number((bv >> BigInt(8 * i)) & 0xffn));
    }
  };
  Machine.prototype.readReg = function (name) {
    const ri = RMAP[name];
    if (!ri) return 0;
    if (ri.xmm) return this.xmm[ri.idx];
    const full = this.regs[ri.parent] || 0;
    if (ri.size === 8) return full;
    const bv = uN(full, 64) >> BigInt(8 * ri.off);
    const m = (ONE << BigInt(8 * ri.size)) - ONE;
    return Number(bv & m);
  };
  Machine.prototype.writeReg = function (name, value) {
    const ri = RMAP[name];
    if (!ri) return;
    if (ri.xmm) { this.xmm[ri.idx] = Number(value) || 0; return; }
    if (ri.parent === 'rip') { this.regs.rip = Number(value); return; }
    const bits = ri.size * 8;
    if (ri.size === 8) { this.regs[ri.parent] = Number(BigInt.asIntN(64, uN(value, 64))); return; }
    if (ri.size === 4) { this.regs[ri.parent] = Number(uN(value, 32)); return; } // 写 32 位自动清零高位
    const old = uN(this.regs[ri.parent] || 0, 64);
    const lowMask = (ONE << BigInt(8 * ri.off)) - ONE;
    const highShift = BigInt(8 * (ri.off + ri.size));
    const low = old & lowMask;
    const high = (old >> highShift) << highShift;
    const mid = (uN(value, bits) & ((ONE << BigInt(bits)) - ONE)) << BigInt(8 * ri.off);
    this.regs[ri.parent] = Number(low | mid | high);
  };

  Machine.prototype.effAddr = function (op) {
    let a = op.disp;
    if (op.base) a += this.regs[op.base] || 0;
    if (op.index) a += (this.regs[op.index] || 0) * (op.scale || 1);
    return a;
  };
  Machine.prototype.opSize = function (op, other) {
    if (op.size) return op.size;
    if (other && other.size) return other.size;
    return 4;
  };

  Machine.prototype.readOp = function (op) {
    if (op.kind === 'reg') {
      const v = this.readReg(op.name);
      this._reads.push({ kind: 'reg', name: op.name, value: v, size: op.size, text: op.text });
      return v;
    }
    if (op.kind === 'imm') return op.value;
    const addr = this.effAddr(op);
    const size = op.size || 4;
    const v = this.readMem(addr, size);
    this._reads.push({ kind: 'mem', addr, size, value: v, text: op.text });
    return v;
  };
  Machine.prototype.writeOp = function (op, value) {
    if (op.kind === 'reg') {
      this.writeReg(op.name, value);
      this._writes.push({ kind: 'reg', name: op.name, value: this.readReg(op.name), size: op.size, text: op.text });
      return;
    }
    const addr = this.effAddr(op);
    const size = op.size || 4;
    this.writeMem(addr, size, value);
    this._writes.push({ kind: 'mem', addr, size, value: this.readMem(addr, size), text: op.text });
  };

  /* ---------------- 浮点内存读写（IEEE-754，小端） ---------------- */
  const FBUF = new ArrayBuffer(8);
  const FDV = new DataView(FBUF);
  Machine.prototype.readMemF = function (addr, size) {
    FDV.setUint8(0, this.mem.get(addr) || 0);
    FDV.setUint8(1, this.mem.get(addr + 1) || 0);
    FDV.setUint8(2, this.mem.get(addr + 2) || 0);
    FDV.setUint8(3, this.mem.get(addr + 3) || 0);
    if (size === 4) return FDV.getFloat32(0, true);
    FDV.setUint8(4, this.mem.get(addr + 4) || 0);
    FDV.setUint8(5, this.mem.get(addr + 5) || 0);
    FDV.setUint8(6, this.mem.get(addr + 6) || 0);
    FDV.setUint8(7, this.mem.get(addr + 7) || 0);
    return FDV.getFloat64(0, true);
  };
  Machine.prototype.writeMemF = function (addr, size, value) {
    const v = Number(value);
    if (size === 4) {
      FDV.setFloat32(0, v, true);
      for (let i = 0; i < 4; i++) this.mem.set(addr + i, FDV.getUint8(i));
      return;
    }
    FDV.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.mem.set(addr + i, FDV.getUint8(i));
  };
  // 浮点操作数：xmm 寄存器或 4/8 字节内存
  Machine.prototype.readOpF = function (op, defSize) {
    const ri = op.kind === 'reg' ? RMAP[op.name] : null;
    if (ri && ri.xmm) {
      const v = this.xmm[ri.idx];
      this._reads.push({ kind: 'reg', name: op.name, value: v, size: 16, text: op.text, fp: true });
      return v;
    }
    const addr = this.effAddr(op);
    const size = op.size || defSize || 8;
    const v = this.readMemF(addr, size);
    this._reads.push({ kind: 'mem', addr: addr, size: size, value: v, text: op.text, fp: true });
    return v;
  };
  Machine.prototype.writeOpF = function (op, value, defSize) {
    const ri = op.kind === 'reg' ? RMAP[op.name] : null;
    if (ri && ri.xmm) {
      this.xmm[ri.idx] = Number(value) || 0;
      this._writes.push({ kind: 'reg', name: op.name, value: this.xmm[ri.idx], size: 16, text: op.text, fp: true });
      return;
    }
    const addr = this.effAddr(op);
    const size = op.size || defSize || 8;
    this.writeMemF(addr, size, value);
    this._writes.push({ kind: 'mem', addr: addr, size: size, value: this.readMemF(addr, size), text: op.text, fp: true });
  };

  Machine.prototype.dstSize = function (ins) {
    const d = ins.ops[0], s = ins.ops[1];
    if (!d) return 4;
    if (d.kind === 'reg') return d.size;
    if (d.size) return d.size;
    if (s && s.kind === 'reg') return s.size;
    return 4;
  };

  function condTrue(mnem, f) {
    switch (mnem) {
      case 'je': case 'jz': return f.ZF === 1;
      case 'jne': case 'jnz': return f.ZF === 0;
      case 'jl': return f.SF !== f.OF;
      case 'jle': return f.ZF === 1 || f.SF !== f.OF;
      case 'jg': return f.ZF === 0 && f.SF === f.OF;
      case 'jge': return f.SF === f.OF;
      case 'jb': return f.CF === 1;
      case 'jbe': return f.CF === 1 || f.ZF === 1;
      case 'ja': return f.CF === 0 && f.ZF === 0;
      case 'jae': return f.CF === 0;
      default: return false;
    }
  }

  Machine.prototype.setFlagsFrom = function (r) {
    this.flags.ZF = r.zf ? 1 : 0;
    this.flags.SF = r.sf ? 1 : 0;
    this.flags.CF = r.cf ? 1 : 0;
    this.flags.OF = r.of ? 1 : 0;
  };

  Machine.prototype.push = function (value) {
    this.regs.rsp -= 8;
    this.writeMem(this.regs.rsp, 8, value);
    this._writes.push({ kind: 'mem', addr: this.regs.rsp, size: 8, value: value, text: '[rsp]', push: true });
  };
  Machine.prototype.pop = function () {
    const v = this.readMem(this.regs.rsp, 8);
    this._reads.push({ kind: 'mem', addr: this.regs.rsp, size: 8, value: v, text: '[rsp]', pop: true });
    this.regs.rsp += 8;
    return v;
  };

  Machine.prototype.step = function () {
    if (this.halted) return null;
    if (this.ip < 0 || this.ip >= this.instrs.length) {
      this.halted = true;
      this.haltReason = this.haltReason || '程序执行到了最后一条指令之后';
      return null;
    }
    if (this.steps++ > MAX_STEPS) {
      this.halted = true;
      this.haltReason = '步数超过 ' + MAX_STEPS + ' 步，已强制停止（可能死循环）';
      return null;
    }
    const ins = this.instrs[this.ip];
    if (!ins) {
      this.halted = true;
      this.haltReason = this.haltReason || '执行流跳到了程序之外（检查跳转目标或栈是否被破坏）';
      return null;
    }
    this._reads = []; this._writes = [];
    const before = { rsp: this.regs.rsp, rbp: this.regs.rbp, eax: this.readReg('rax'), rip: this.regs.rip };
    let nextIp = this.ip + 1;
    const ops = ins.ops;
    const m = ins.mnem;
    this.regs.rip = ins.addr;
    try {
      switch (m) {
        case 'mov': { const v = this.readOp(ops[1]); const sz = this.dstSize(ins); this.writeOp(ops[0], v); break; }
        case 'movzx': { const v = this.readOp(ops[1]); const sz = this.dstSize(ins); this.writeOp(ops[0], Number(uN(v, 64))); break; }
        case 'movsx': { const v = this.readOp(ops[1]); const srcBits = (ops[1].size || this.dstSize(ins)) * 8; this.writeOp(ops[0], Number(signedOf(v, srcBits))); break; }
        case 'lea': { const addr = this.effAddr(ops[1]); this._reads.push({ kind: 'mem', addr: addr, size: 0, value: addr, text: ops[1].text, lea: true }); this.writeOp(ops[0], addr); break; }
        case 'xchg': { const a = this.readOp(ops[0]), b = this.readOp(ops[1]); this.writeOp(ops[0], b); this.writeOp(ops[1], a); break; }
        case 'push': {
          const v = this.readOp(ops[0]);
          const sz = ops[0].kind === 'reg' ? 8 : (ops[0].size || 4);
          this.push(v);
          break;
        }
        case 'pop': { const v = this.pop(); if (ops[0]) this.writeOp(ops[0], v); break; }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]), b = this.readOp(ops[1]);
          const r = arith(m, a, b, sz * 8);
          this.setFlagsFrom(r);
          this.writeOp(ops[0], r.res);
          break;
        }
        case 'cmp': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]), b = this.readOp(ops[1]);
          this.setFlagsFrom(arith('sub', a, b, sz * 8));
          break;
        }
        case 'test': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]), b = this.readOp(ops[1]);
          const r = arith('and', a, b, sz * 8);
          this.setFlagsFrom({ zf: r.zf, sf: r.sf, cf: false, of: false });
          break;
        }
        case 'inc': case 'dec': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]);
          const r = arith(m === 'inc' ? 'add' : 'sub', a, 1, sz * 8);
          this.flags.ZF = r.zf ? 1 : 0; this.flags.SF = r.sf ? 1 : 0; this.flags.OF = r.of ? 1 : 0;
          this.writeOp(ops[0], r.res);
          break;
        }
        case 'neg': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]);
          const r = arith('sub', 0, a, sz * 8);
          this.setFlagsFrom(r);
          this.writeOp(ops[0], r.res);
          break;
        }
        case 'not': { const a = this.readOp(ops[0]); const sz = this.dstSize(ins); this.writeOp(ops[0], Number(uN(~uN(a, sz * 8), sz * 8))); break; }
        case 'imul': {
          const sz = this.dstSize(ins);
          if (ops.length === 3) {
            const a = this.readOp(ops[1]); const b = this.readOp(ops[2]);
            const r = arith('mul', a, b, sz * 8); this.writeOp(ops[0], r.res);
          } else if (ops.length === 2) {
            const a = this.readOp(ops[0]); const b = this.readOp(ops[1]);
            const r = arith('mul', a, b, sz * 8); this.writeOp(ops[0], r.res);
          } else {
            const a = this.readReg('rax'); const b = this.readOp(ops[0]);
            const r = arith('mul', a, b, sz * 8); this.writeReg('rax', r.res);
          }
          break;
        }
        case 'idiv': case 'div': {
          const sz = this.dstSize(ins);
          const d = this.readOp(ops[0]);
          if (d === 0) { this.errorMsg = '除数为 0，程序崩溃（真实 CPU 会触发除法异常）'; this.halted = true; return { index: ins.index, instr: ins, error: this.errorMsg }; }
          const ax = this.readReg('rax');
          // 被除数是「高半 + 低半」拼起来的：32 位形式是 edx:eax，64 位形式是 rdx:rax
          if (sz === 4) {
            const big = (uN(this.readReg('rdx'), 32) << 32n) | uN(ax, 32);
            const dividend = m === 'idiv' ? BigInt.asIntN(64, big) : big;
            const divisor = m === 'idiv' ? signedOf(d, 32) : uN(d, 32);
            const q = dividend / divisor;              // BigInt 除法本身就是向零取整
            const rem = dividend - q * divisor;
            this.writeReg('rax', Number(BigInt.asIntN(64, q)));
            this.writeReg('rdx', Number(BigInt.asIntN(64, rem)));
            this._writes.push({ kind: 'reg', name: 'rdx', value: Number(uN(rem, 32)), size: 4, text: 'edx（余数）' });
          } else {
            const big = (uN(this.readReg('rdx'), 64) << 64n) | uN(ax, 64);
            const dividend = m === 'idiv' ? BigInt.asIntN(128, big) : big;
            const divisor = m === 'idiv' ? signedOf(d, 64) : uN(d, 64);
            const q = dividend / divisor;
            const rem = dividend - q * divisor;
            this.writeReg('rax', Number(BigInt.asIntN(64, q)));
            this.writeReg('rdx', Number(BigInt.asIntN(64, rem)));
          }
          break;
        }
        case 'cdq': this.writeReg('rdx', (this.readReg('rax') & 0x80000000) ? 0xFFFFFFFF : 0); break;
        case 'cqo': this.writeReg('rdx', signedOf(this.readReg('rax'), 64) < 0 ? -1 : 0); break;
        case 'shl': case 'sal': case 'shr': case 'sar': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]);
          const cnt = Number(uN(this.readOp(ops[1]), 64)) & 0x3f;
          const bits = sz * 8;
          let res, cf = false;
          if (m === 'shl' || m === 'sal') { const bv = uN(a, bits) << BigInt(cnt); cf = ((uN(a, bits) >> BigInt(bits - 1)) & ONE) === ONE; res = Number(BigInt.asUintN(bits, bv)); }
          else if (m === 'shr') { cf = (uN(a, bits) >> BigInt(cnt - 1 || 0)) & ONE ? true : false; res = Number(BigInt.asUintN(bits, uN(a, bits) >> BigInt(cnt))); }
          else { cf = Number((uN(a, bits) >> BigInt(cnt ? cnt - 1 : 0)) & ONE) === 1; res = Number(BigInt.asUintN(bits, signedOf(a, bits) >> BigInt(cnt))); }
          const r = { res, cf, of: false, zf: uN(res, bits) === 0n, sf: (uN(res, bits) >> BigInt(bits - 1)) === ONE };
          this.setFlagsFrom(r);
          this.writeOp(ops[0], res);
          break;
        }
        case 'jmp': {
          const t = this.jumpTarget(ops[0]);
          if (t < 0) throw new Error('跳转目标无效');
          nextIp = t;
          break;
        }
        case 'je': case 'jz': case 'jne': case 'jnz': case 'jl': case 'jle': case 'jg': case 'jge':
        case 'ja': case 'jae': case 'jb': case 'jbe': {
          if (condTrue(m, this.flags)) {
            const t = this.jumpTarget(ops[0]);
            if (t < 0) throw new Error('跳转目标无效');
            nextIp = t;
          }
          break;
        }
        case 'call': {
          const name = ops[0].label || ops[0].text;
          if (this.builtin(name)) { this.callBuiltin(name, ins); break; }
          const t = this.jumpTarget(ops[0]);
          if (t < 0) throw new Error('找不到函数 "' + name + '"');
          this.push(CODE_BASE + this.ip + 1);
          this._writes.push({ kind: 'reg', name: 'rip', value: CODE_BASE + t, size: 8, text: 'rip（跳到函数）' });
          nextIp = t;
          break;
        }
        case 'ret': {
          const addr = this.pop();
          if (addr === RET_SENTINEL || addr === 0) {
            this.halted = true;
            this.haltReason = 'ret 返回到调用者，程序正常结束';
            this.regs.rip = ins.addr + 1;
            nextIp = null;
          } else {
            nextIp = addr - CODE_BASE;
          }
          break;
        }
        case 'leave': {
          this.regs.rsp = this.regs.rbp;
          this._writes.push({ kind: 'reg', name: 'rsp', value: this.regs.rsp, size: 8, text: 'rsp（丢弃局部变量）' });
          const v = this.pop();
          this.writeReg('rbp', v);
          this._writes.push({ kind: 'reg', name: 'rbp', value: this.readReg('rbp'), size: 8, text: 'rbp（恢复调用者）' });
          break;
        }
        case 'nop': case 'int3': break;
        case 'hlt': this.halted = true; this.haltReason = 'hlt 指令，程序停止'; nextIp = null; break;
        case 'sete': case 'setne': case 'setl': case 'setle': case 'setg': case 'setge': case 'seta': case 'setae': case 'setb': case 'setbe': {
          const c = m.slice(3);
          const map = { e: 'je', ne: 'jne', l: 'jl', le: 'jle', g: 'jg', ge: 'jge', a: 'ja', ae: 'jae', b: 'jb', be: 'jbe' };
          this.writeOp(ops[0], condTrue(map[c], this.flags) ? 1 : 0);
          break;
        }
        /* ─────────── 浮点 / SSE ─────────── */
        case 'movsd': case 'movss': {
          const w = m === 'movss' ? 4 : 8;
          const v = this.readOpF(ops[1], w);
          this.writeOpF(ops[0], v, w);
          break;
        }
        case 'movaps': case 'movups': {
          this.writeOpF(ops[0], this.readOpF(ops[1], 8), 8);
          break;
        }
        case 'movd': case 'movq': {
          const dstRi = ops[0].kind === 'reg' ? RMAP[ops[0].name] : null;
          const srcRi = ops[1].kind === 'reg' ? RMAP[ops[1].name] : null;
          if (dstRi && dstRi.xmm) {
            const v = this.readOp(ops[1]);
            this.writeOpF(ops[0], m === 'movd' ? (Number(uN(v, 32)) | 0) : v, 8);
          } else if (srcRi && srcRi.xmm) {
            const v = this.readOpF(ops[1], 8);
            this.writeOp(ops[0], m === 'movd' ? (v | 0) : v);
          } else {
            this.writeOpF(ops[0], this.readOpF(ops[1], 8), 8);
          }
          break;
        }
        case 'addsd': case 'subsd': case 'mulsd': case 'divsd':
        case 'addss': case 'subss': case 'mulss': case 'divss': {
          const w = /ss$/.test(m) ? 4 : 8;
          const a = this.readOpF(ops[0], w);
          const b = this.readOpF(ops[1], w);
          const base = m.slice(0, 3);
          let r;
          if (base === 'add') r = a + b;
          else if (base === 'sub') r = a - b;
          else if (base === 'mul') r = a * b;
          else r = a / b;
          this.writeOpF(ops[0], w === 4 ? Math.fround(r) : r, w);
          break;
        }
        case 'sqrtsd': case 'sqrtss': {
          const w = m === 'sqrtss' ? 4 : 8;
          this.writeOpF(ops[0], Math.sqrt(this.readOpF(ops[1], w)), w);
          break;
        }
        case 'ucomisd': case 'comisd': case 'ucomiss': case 'comiss': {
          const w = /ss$/.test(m) ? 4 : 8;
          const a = this.readOpF(ops[0], w);
          const b = this.readOpF(ops[1], w);
          const un = isNaN(a) || isNaN(b);
          this.flags.ZF = (!un && a === b) ? 1 : 0;
          this.flags.CF = (!un && a < b) ? 1 : 0;
          this.flags.PF = un ? 1 : 0;
          this.flags.OF = 0;
          this.flags.SF = 0;
          break;
        }
        case 'cvtsi2sd': case 'cvtsi2ss': {
          const v = this.readOp(ops[1]);
          const srcBits = (ops[1].size || 4) === 8 ? 64 : 32;
          const sv = Number(signedOf(v, srcBits));
          this.writeOpF(ops[0], m === 'cvtsi2ss' ? Math.fround(sv) : sv, m === 'cvtsi2ss' ? 4 : 8);
          break;
        }
        case 'cvttsd2si': case 'cvttss2si': {
          const v = this.readOpF(ops[0], m === 'cvttss2si' ? 4 : 8);
          const iv = Math.trunc(v);
          this.writeOp(ops[1], Number.isFinite(iv) ? iv : 0);
          break;
        }
        case 'cvtsd2ss': this.writeOpF(ops[0], Math.fround(this.readOpF(ops[1], 8)), 4); break;
        case 'cvtss2sd': this.writeOpF(ops[0], this.readOpF(ops[1], 4), 8); break;
        case 'xorpd': case 'xorps': case 'pxor': {
          const ri0 = ops[0].kind === 'reg' ? RMAP[ops[0].name] : null;
          if (ri0 && ri0.xmm) this.writeOpF(ops[0], 0, 8);
          else this.writeOp(ops[0], 0);
          break;
        }
        /* ─────────── 其它整数指令 ─────────── */
        case 'movsxd': {
          const v = this.readOp(ops[1]);
          this.writeOp(ops[0], Number(signedOf(v, (ops[1].size || 4) * 8)));
          break;
        }
        case 'cdqe': case 'cltq':
          this.writeReg('rax', Number(signedOf(this.readReg('rax'), 32)));
          break;
        case 'cwd':
          this.writeReg('rdx', (this.readReg('rax') & 0x8000) ? 0xFFFF : 0);
          break;
        case 'cqto':
          this.writeReg('rdx', signedOf(this.readReg('rax'), 64) < 0 ? -1 : 0);
          break;
        case 'adc': case 'sbb': {
          const sz = this.dstSize(ins);
          const a = this.readOp(ops[0]);
          const b = this.readOp(ops[1]) + (this.flags.CF ? 1 : 0);
          const r = arith(m === 'adc' ? 'add' : 'sub', a, b, sz * 8);
          this.setFlagsFrom(r);
          this.writeOp(ops[0], r.res);
          break;
        }
        case 'cmove': case 'cmovne': case 'cmovl': case 'cmovle': case 'cmovg': case 'cmovge': {
          const map = { cmove: 'je', cmovne: 'jne', cmovl: 'jl', cmovle: 'jle', cmovg: 'jg', cmovge: 'jge' };
          if (condTrue(map[m], this.flags)) this.writeOp(ops[0], this.readOp(ops[1]));
          break;
        }
        default:
          throw new Error('暂不支持的指令 ' + m);
      }
    } catch (err) {
      this.errorMsg = err.message;
      this.halted = true;
      this.lastStep = { index: ins.index, instr: ins, reads: this._reads, writes: this._writes, error: err.message };
      return this.lastStep;
    }

    if (this.regs.rbp && (this.frameRbp === 0 || this.regs.rbp < this.frameRbp)) this.frameRbp = this.regs.rbp;
    const after = { rsp: this.regs.rsp, rbp: this.regs.rbp, eax: this.readReg('rax') };
    this.regs.rip = nextIp === null ? ins.addr + 1 : (this.instrs[nextIp] ? this.instrs[nextIp].addr : this.regs.rip);
    if (nextIp !== null) this.ip = nextIp;
    this.lastStep = {
      index: ins.index, instr: ins, reads: this._reads, writes: this._writes,
      before, after, output: this.output.length
    };
    return this.lastStep;
  };

  Machine.prototype.jumpTarget = function (op) {
    if (op.kind === 'imm') {
      if (op.label && this.labels.has(op.label)) {
        const L = this.labels.get(op.label);
        if (L.kind === 'code') return L.index;
      }
      return op.value - CODE_BASE;
    }
    return -1;
  };

  Machine.prototype.builtin = function (name) {
    return ['printf', 'puts', 'putchar', 'exit', '__isoc99_scanf'].indexOf(name) >= 0;
  };

  Machine.prototype.readCString = function (addr) {
    let s = '';
    for (let i = 0; i < 4096; i++) {
      const b = this.mem.get(addr + i) || 0;
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  };

  Machine.prototype.callBuiltin = function (name, ins) {
    const regs = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
    if (name === 'printf') {
      const fmtAddr = this.readReg('rdi');
      const fmt = this.readCString(fmtAddr);
      const GPR_ARGS = ['rsi', 'rdx', 'rcx', 'r8', 'r9'];
      let gi = 0, xi = 0, si = 0;
      // 寄存器装不下的参数按 System V 约定放在 [rsp]、[rsp+8]…
      const stackArg = () => {
        const v = this.readMem(this.regs.rsp + 8 * si, 8);
        si++;
        return v;
      };
      const stackArgF = () => {
        const v = this.readMemF(this.regs.rsp + 8 * si, 8);
        si++;
        return v;
      };
      const out = fmt.replace(/%(-?\d*)(?:\.(\d+))?(l{0,2}|h{0,2}|z)?([diuoxXcsfgeEFGp%])/g,
        (all, wstr, prec, len, conv) => {
          if (conv === '%') return '%';
          const isLong = len === 'l' || len === 'll' || len === 'z';
          let s;
          if ('fgeEFG'.indexOf(conv) >= 0) {
            // 浮点参数走 xmm0、xmm1…
            const v = xi < 8 ? this.readReg('xmm' + xi) : stackArgF();
            xi++;
            const p = prec === undefined ? 6 : parseInt(prec, 10);
            if (conv === 'f') s = v.toFixed(p);
            else if (conv === 'e' || conv === 'E') s = v.toExponential(p);
            else {
              const av = Math.abs(v);
              s = (av !== 0 && (av < 1e-4 || av >= 1e6)) ? v.toExponential(3) : String(parseFloat(v.toPrecision(6)));
            }
            if (conv === 'E' || conv === 'G') s = s.toUpperCase();
          } else {
            const v = gi < GPR_ARGS.length ? this.readReg(GPR_ARGS[gi]) : stackArg();
            gi++;
            const bits = isLong ? 64 : 32;
            if (conv === 's') s = this.readCString(v);
            else if (conv === 'c') s = String.fromCharCode(v & 0xff);
            else if (conv === 'x') s = BigInt.asUintN(bits, BigInt(v)).toString(16);
            else if (conv === 'X') s = BigInt.asUintN(bits, BigInt(v)).toString(16).toUpperCase();
            else if (conv === 'o') s = BigInt.asUintN(bits, BigInt(v)).toString(8);
            else if (conv === 'u') s = BigInt.asUintN(bits, BigInt(v)).toString(10);
            else if (conv === 'p') s = '0x' + BigInt.asUintN(64, BigInt(v)).toString(16);
            else s = String(BigInt.asIntN(bits, BigInt(v)));
          }
          const width = parseInt(wstr, 10);
          const zero = /^0\d/.test(wstr);   // %05d 用 0 补齐
          if (width && s.length < Math.abs(width)) {
            if (width > 0 && zero) {
              s = s[0] === '-' ? '-' + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0');
            } else {
              s = width > 0 ? s.padStart(width, ' ') : s.padEnd(-width, ' ');
            }
          }
          return s;
        });
      this.output += out;
      this.writeReg('rax', out.length);
      this._reads.push({ kind: 'mem', addr: fmtAddr, size: 0, value: fmtAddr, text: '格式串', data: true });
      return;
    }
    if (name === 'puts') {
      const s = this.readCString(this.readReg('rdi'));
      this.output += s + '\n';
      this.writeReg('rax', 0);
      return;
    }
    if (name === 'putchar') {
      const c = this.readReg('rdi') & 0xff;
      this.output += String.fromCharCode(c);
      this.writeReg('rax', c);
      return;
    }
    if (name === 'exit') {
      this.halted = true;
      this.haltReason = '调用 exit()，程序提前结束';
    }
  };

  Machine.prototype.snapshot = function () {
    return {
      regs: Object.assign({}, this.regs),
      flags: Object.assign({}, this.flags),
      ip: this.ip,
      halted: this.halted,
      output: this.output
    };
  };

  // 深拷贝一个机器（用于"预演一步"而不影响当前状态）
  Machine.prototype.clone = function () {
    const m = Object.create(Machine.prototype);
    m.prog = this.prog;
    m.instrs = this.instrs;
    m.labels = this.labels;
    m.regs = Object.assign({}, this.regs);
    m.xmm = new Float64Array(this.xmm);
    m.flags = Object.assign({}, this.flags);
    m.mem = new Map(this.mem);
    m.halted = this.halted;
    m.haltReason = this.haltReason;
    m.steps = this.steps;
    m.output = this.output;
    m.ip = this.ip;
    m.entryIsMain = this.entryIsMain;
    m.errorMsg = this.errorMsg;
    m.lastStep = null;
    m._reads = [];
    m._writes = [];
    return m;
  };

  Machine.prototype.instrIndexForLine = function (lineNo) {
    let best = -1;
    for (let i = 0; i < this.instrs.length; i++) {
      if (this.instrs[i].lineNo >= lineNo) { best = i; break; }
    }
    return best;
  };

  const API = {
    assemble, Machine, regInfo, RMAP, GPRS, FAM, XMMS, INSTR_ARITY,
    CODE_BASE, DATA_BASE, STACK_TOP, RET_SENTINEL,
    uN, signedOf, arith, condTrue
  };
  global.ASM_VM = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
