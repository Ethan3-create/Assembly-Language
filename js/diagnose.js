/* ============================================================
 * diagnose.js · 代码检查与报错系统
 * 把"汇编解析失败 / C 编译失败 / 静态可疑写法 / 运行期错误"
 * 统一成一组结构化问题：{ level, line, msg, fix, code }
 *   level: 'error' 必须修 | 'warn' 很可能有问题 | 'info' 值得注意
 * 纯静态分析，不改动 prog，也不抛异常。
 * ============================================================ */
(function (global) {
  'use strict';

  const LEVEL_CN = { error: '错误', warn: '警告', info: '提示' };

  /* 这些指令的两个操作数宽度必须一致（同宽度寄存器 / 同宽度内存） */
  const SAME_WIDTH = {
    mov: 1, add: 1, sub: 1, adc: 1, sbb: 1, and: 1, or: 1, xor: 1,
    cmp: 1, test: 1, xchg: 1
  };
  /* 会"写"目的操作数（第一个操作数）的指令 —— 用来判断离奇写 32 位寄存器 */
  const WRITES_DST = {
    mov: 1, movzx: 1, movsx: 1, movsxd: 1, lea: 1, movsd: 1, movss: 1,
    add: 1, sub: 1, adc: 1, sbb: 1, and: 1, or: 1, xor: 1, imul: 1,
    shl: 1, sal: 1, shr: 1, sar: 1, neg: 1, not: 1, inc: 1, dec: 1
  };

  const isMem = o => !!o && o.kind === 'mem';
  const isReg = o => !!o && o.kind === 'reg';
  const isImm = o => !!o && o.kind === 'imm';

  function regW(o) { return o && o.size ? o.size : 0; }

  function splitLines(src) { return String(src == null ? '' : src).split('\n'); }

  /**
   * 主入口
   * @param prog   VM.assemble 的结果（可为 null，比如 C 编译就失败了）
   * @param ctx    { srcText, varMapRaw[], cError, runtimeError:{msg,line} }
   */
  function check(prog, ctx) {
    ctx = ctx || {};
    const srcLines = splitLines(ctx.srcText);
    const issues = [];
    const seen = {};

    function add(level, line, msg, fix, src) {
      line = line | 0;
      const key = level + '|' + line + '|' + msg;
      if (seen[key]) return;
      seen[key] = 1;
      issues.push({
        level: level,
        line: line,
        msg: msg,
        fix: fix || '',
        src: src || 'asm',
        code: line > 0 ? (srcLines[line - 1] || '').replace(/^\s+|\s+$/g, '') : ''
      });
    }

    /* ---------- 1. C 编译失败 ---------- */
    if (ctx.cError) {
      const msg = String(ctx.cError);
      const m = msg.match(/第\s*(\d+)\s*行/);
      add('error', m ? parseInt(m[1], 10) : 0,
        'C 编译失败：' + msg.replace(/（第\s*\d+\s*行）/, ''),
        '这一行没法翻译成汇编时不会生成任何汇编。先把该行的语法/类型问题修掉，再点「编译并加载」。', 'c');
    }

    /* ---------- 2. 汇编解析错误（一条错误串里可能带行号） ---------- */
    (prog && prog.errors ? prog.errors : []).forEach(e => {
      const m = String(e).match(/第\s*(\d+)\s*行[：:]\s*([\s\S]+)/);
      const line = m ? parseInt(m[1], 10) : 0;
      const body = m ? m[2] : String(e);
      let fix = '';
      if (/不认识的指令/.test(body)) {
        fix = '检查拼写（例如 mov / movsxd / cvtsi2sd），Intel 语法里指令名全是小写，后面跟操作数。';
      } else if (/需要\s*\d+\s*个操作数/.test(body)) {
        const need = (body.match(/需要\s*(\d+)\s*个操作数/) || [])[1];
        fix = '这条指令需要 ' + need + ' 个操作数，用逗号隔开，例如 ' +
          (need === '2' ? 'mov eax, DWORD PTR [rbp-4]' : need === '1' ? 'push rax' : '不需要操作数');
      } else if (/找不到标签/.test(body)) {
        fix = '标签要先定义再用，定义时末尾带冒号，例如 .L1:  ；跳转时写 jmp .L1。';
      } else if (/无法识别的操作数/.test(body)) {
        fix = '操作数只能是：寄存器（eax/rbp…）、内存（[rbp-4] 或 DWORD PTR [rbp-4]）、立即数（10 / 0x10）、标签。';
      }
      add('error', line, body, fix);
    });

    const instrs = prog && prog.instrs ? prog.instrs : [];

    /* ---------- 3. 运行期错误 ---------- */
    if (ctx.runtimeError) {
      add('error', ctx.runtimeError.line || 0,
        '运行时出错：' + ctx.runtimeError.msg,
        '常见原因：除数为 0、访问了未初始化的指针、栈越界。先看这一行的操作数是不是有 0 或空指针。');
    }

    if (instrs.length) {
      /* ---------- 4. 逐条指令的静态检查 ---------- */
      instrs.forEach(ins => {
        const ops = ins.ops || [];
        const m = ins.mnem;
        const a = ops[0], b = ops[1];

        // 4.1 内存 → 内存
        if ((m === 'mov' || m === 'add' || m === 'sub' || m === 'cmp') && isMem(a) && isMem(b)) {
          add('error', ins.lineNo,
            m + ' 不能直接把内存搬到内存（x86 没有这种指令）',
            '借助一个寄存器中转：先 mov eax, ' + b.text + '，再 mov ' + a.text + ', eax。');
        }

        // 4.2 除数为常量 0
        if ((m === 'idiv' || m === 'div') && isImm(a) && Number(a.value) === 0) {
          add('error', ins.lineNo, '除数是 0，运行到这里会因为除以零而崩溃',
            '把除数换成非 0 的值，或者先用 cmp 判断除数再决定是否相除。');
        }

        // 4.3 读写返回地址
        if (ops.some(o => isMem(o) && o.base === 'rbp' && (o.disp | 0) === 8)) {
          add('error', ins.lineNo, '[rbp+8] 是「返回地址」的位置，不是你的变量',
            '局部变量都在 rbp 的下面，用负偏移，例如 [rbp-4]；栈上的入参从 [rbp+16] 开始。');
        }

        // 4.4 操作数宽度不一致
        if (SAME_WIDTH[m] && isReg(a) && isReg(b) && regW(a) && regW(b) && regW(a) !== regW(b)) {
          add('warn', ins.lineNo,
            m + ' 的两个寄存器宽度不同（' + a.name + ' 是 ' + (regW(a) * 8) + ' 位，' + b.name + ' 是 ' + (regW(b) * 8) + ' 位）',
            '宽度要一致：32 位对 32 位（eax/ecx）、64 位对 64 位（rax/rcx）。要把 32 位变 64 位用 movsxd，无符号用 mov eax, eax 清零高位。');
        }

        // 4.5 立即数超过目标宽度
        if (WRITES_DST[m] && isReg(a) && regW(a) === 4 && isImm(b) && Math.abs(Number(b.value)) > 0xffffffff) {
          add('warn', ins.lineNo,
            '常量 ' + b.text + ' 超出 32 位寄存器能表示的范围',
            '改用 64 位寄存器（rax 而不是 eax）来装这个大常量。');
        }

        // 4.6 读写 4 字节内存却用 64 位寄存器 / 反之（只提示，避免误报）
        if (m === 'mov' && isMem(a) && isReg(b) && a.size && regW(b) && a.size !== regW(b)) {
          add('warn', ins.lineNo,
            '写入的内存宽度（' + a.size + ' 字节）与源寄存器 ' + b.name + '（' + regW(b) + ' 字节）不一致',
            'DWORD PTR 配 32 位寄存器（eax），QWORD PTR 配 64 位（rax），BYTE PTR 配 al。');
        }

        // 4.7 无条件跳到自身
        if (m === 'jmp' && isImm(a) && a.label && prog.labels.has(a.label)) {
          const tgt = prog.labels.get(a.label);
          if (tgt.kind === 'code' && tgt.index === ins.index) {
            add('info', ins.lineNo, '这一行跳到它自己，是个死循环（除非只是占位）',
              '真要循环通常写成：.L1: … ; add eax, 1 ; cmp eax, 10 ; jl .L1');
          }
        }

        // 4.8 rsp 调整不是 8 的倍数
        if ((m === 'sub' || m === 'add') && isReg(a) && a.name === 'rsp' && isImm(b)) {
          const n = Number(b.value) | 0;
          if (n % 8 !== 0) {
            add('warn', ins.lineNo, 'rsp 一次调整 ' + n + " 字节，不是 8 的倍数，栈会错位",
              '栈按 8 字节（64 位）对齐，开空间用 sub rsp, 16/32/48 这种 16 的倍数。');
          }
        }
      });

      /* ---------- 5. 栈帧平衡 / 调用对齐 ---------- */
      const labels = prog.labels || new Map();
      // 已知函数入口（非 .L 局部标签，或 main/_start）
      const fnStarts = new Map();
      labels.forEach((v, k) => {
        if (v.kind !== 'code') return;
        if (/^\.L/.test(k)) return;
        fnStarts.set(v.index, k);
      });

      let delta = 0;         // rsp 相对函数入口的偏移
      let hasFrame = false;
      let unknown = false;   // 遇到 add rsp, <寄存器> 之类无法静态确定的调整
      let curFn = '(顶层)';
      let fnHasRet = false;

      instrs.forEach((ins, i) => {
        if (fnStarts.has(i)) {
          delta = 0; hasFrame = false; unknown = false; curFn = fnStarts.get(i); fnHasRet = false;
        }
        const ops = ins.ops || [];
        const m = ins.mnem;
        const a = ops[0], b = ops[1];

        if (m === 'push') {
          delta -= 8;
          if (isReg(a) && a.name === 'rbp') hasFrame = true;   // 建立了栈帧，可以用 rbp 相对偏移
        }
        else if (m === 'pop') { delta += 8; }
        else if (m === 'leave') { delta = 0; if (hasFrame) unknown = false; }
        else if ((m === 'sub' || m === 'add') && isReg(a) && a.name === 'rsp') {
          if (isImm(b)) delta += (m === 'sub' ? -1 : 1) * (Number(b.value) | 0);
          else unknown = true;
        } else if (m === 'call') {
          if (hasFrame && !unknown && ((8 + delta) % 16 + 16) % 16 !== 0) {
            add('warn', ins.lineNo,
              '调用前 rsp 没有 16 字节对齐（"' + curFn + '" 里当前差 ' + (((8 + delta) % 16 + 16) % 16) + ' 字节）',
              'System V 约定要求 call 之前 rsp 是 16 的倍数。开栈时用 sub rsp, 16 的倍数；参数压栈后要补 sub rsp, 8 对齐。');
          }
        } else if (m === 'ret') {
          fnHasRet = true;
          if (hasFrame && !unknown && delta !== 0) {
            add('warn', ins.lineNo,
              '"' + curFn + '" 返回前栈指针没恢复（还差 ' + delta + ' 字节）',
              '开了多少栈就要还多少：sub rsp, N 之后用 add rsp, N 或 leave 恢复。');
          }
        }
      });

      if (!instrs.some(x => x.mnem === 'ret')) {
        add('info', 0, '整段代码里没有 ret（也没有 exit），会顺序执行到末尾就停',
          '当作"片段练习"没问题；写完整程序时，函数末尾通常 leave → ret，主程序可以 call exit。');
      }

      if (!labels.has('main') && !labels.has('_start')) {
        add('info', 0, '没有 main 或 _start 标签，执行会从第一条指令开始', '不影响练习，写完整程序时加上 main: 更规范。');
      }

      /* ---------- 6. 只被赋值、从没被读过的变量 ---------- */
      const raw = ctx.varMapRaw || [];
      if (raw.length) {
        const readDisp = new Set();
        instrs.forEach(ins => {
          (ins.ops || []).forEach((o, idx) => {
            if (!(o.kind === 'mem' && o.base === 'rbp' && (o.disp | 0) < 0)) return;
            if (ins.mnem === 'lea') { readDisp.add(o.disp | 0); return; }   // 取地址也算用到
            const writes = idx === 0 && WRITES_DST[ins.mnem];
            if (!writes) readDisp.add(o.disp | 0);
          });
        });
        raw.forEach(v => {
          const base = -Math.abs(v.offset);
          const size = v.size || 4;
          const top = base + Math.max(0, size - 4);
          let read = false;
          readDisp.forEach(d => { if (d >= base && d <= top) read = true; });
          if (!read) {
            add('info', 0, '变量 "' + v.name + '"（在 ' + v.func + ' 里）只被赋值过，从没被读过',
              '不影响运行，只是提醒：要么后面用上它，要么删掉。');
          }
        });
      }
    }

    /* 排序：错误 → 行号小的优先 */
    const rank = { error: 0, warn: 1, info: 2 };
    issues.sort((x, y) => (rank[x.level] - rank[y.level]) || (x.line - y.line));

    const counts = { error: 0, warn: 0, info: 0 };
    issues.forEach(i => { counts[i.level]++; });

    return { issues: issues, counts: counts, levelCN: LEVEL_CN };
  }

  const API = { check: check, LEVEL_CN: LEVEL_CN };
  global.DIAG = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
