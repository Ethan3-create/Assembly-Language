/* ============================================================
 * 分析引擎：单行指令解释 + 整段代码总体分析
 * 依赖 vm.js 提供的真实执行状态，保证"说的"和"跑的"一致
 * ============================================================ */
(function (global) {
  'use strict';

  const D = global.ASM_DATA || (typeof require !== 'undefined' ? require('./data.js') : null);
  const VM = global.ASM_VM || (typeof require !== 'undefined' ? require('./vm.js') : null);

  const hex = v => '0x' + (v >>> 0).toString(16);
  const hex64 = v => '0x' + Number(VM.uN(v, 64)).toString(16);
  function valStr(v) {
    if (v === undefined || v === null) return '—';
    const s = String(Math.trunc(v));
    return s;
  }
  function bothStr(v) {
    const a = Math.trunc(v);
    if (a < 0) return a + '（' + hex64(a) + '）';
    return a + (a > 9 ? '（' + hex(a) + '）' : '');
  }
  // 浮点数显示：去掉多余的 0，但保留小数特征
  function fmtFloat(v) {
    if (!isFinite(v)) return String(v);
    if (Number.isInteger(v)) return v + '.0';
    return String(Number(v.toPrecision(10)));
  }

  /* 把操作数还原成干净的地址表达式，例如 [rbp-4] */
  function memExprText(op) {
    if (!op) return '[?]';
    let out = '';
    if (op.base) out += op.base;
    if (op.index) out += (out ? '+' : '') + op.index + (op.scale && op.scale !== 1 ? '*' + op.scale : '');
    if (op.disp) {
      if (out) out += op.disp > 0 ? '+' + op.disp : '-' + Math.abs(op.disp);
      else out = (op.disp > 0 ? '0x' + op.disp.toString(16) : '-' + Math.abs(op.disp));
    }
    if (!out) out = '0';
    return '[' + out + ']';
  }

  /* ---------- 操作数描述 ---------- */
  function describeOperand(op, m, ctx) {
    ctx = ctx || {};
    if (!op) return { text: '—', kind: 'none', short: '—', detail: '' };
    if (op.kind === 'reg') {
      const ri = VM.regInfo(op.name);
      const value = m ? m.readReg(op.name) : null;
      const bits = op.size * 8;
      if (ri && ri.xmm) {
        return {
          kind: 'reg', name: op.name, size: 16, value: value, fp: true,
          short: op.name,
          text: op.name,
          detail: '浮点寄存器 ' + op.name + (value !== null ? '（当前值 ' + fmtFloat(value) + '）' : '')
        };
      }
      return {
        kind: 'reg', name: op.name, size: op.size, value,
        short: op.name,
        text: op.name,
        detail: bits + ' 位寄存器 ' + op.name + (value !== null ? '（当前值 ' + bothStr(value) + '）' : '')
      };
    }
    if (op.kind === 'imm') {
      if (op.label) {
        const isData = op.labelKind === 'data';
        return {
          kind: 'label', name: op.label, value: op.value, short: op.label,
          text: op.label,
          detail: isData ? '数据标签 ' + op.label + '（地址 ' + hex(op.value) + '）' : '代码标签 ' + op.label + '（地址 ' + hex(op.value) + '）'
        };
      }
      return { kind: 'imm', value: op.value, short: String(op.value), text: String(op.value), detail: '立即数 ' + op.value + (op.value > 9 ? '（' + hex(op.value) + '）' : '') };
    }
    // 内存
    const addr = m ? m.effAddr(op) : null;
    const size = op.size || 4;
    let varName = null;
    if (op.base === 'rbp' && op.disp !== undefined && ctx.varMap) {
      varName = ctx.varMap.get(-op.disp) || null;
    }
    let stackRole = '';
    if (op.base === 'rbp') {
      if (op.disp === 0) stackRole = '保存的调用者 rbp';
      else if (op.disp === 8) stackRole = '函数返回地址';
      else if (op.disp > 8) stackRole = '传入的参数 / 上层数据';
    }
    const value = (m && addr !== null) ? m.readMem(addr, size) : null;
    const expr = memExprText(op);
    let detail = '内存 ' + expr;
    if (addr !== null) detail += '（实际地址 ' + hex(addr) + '）';
    if (varName) detail += '，也就是局部变量 ' + varName;
    else if (stackRole) detail += '，' + stackRole;
    if (value !== null) detail += '，此处当前存放 ' + bothStr(value);
    return {
      kind: 'mem', addr, size, value, varName,
      short: varName || expr,
      text: expr,
      detail,
      expr
    };
  }

  /* ---------- 形容词：读写方向 ---------- */
  function memRole(op, m, ctx, isWrite) {
    if (op.base === 'rbp' && ctx.varMap) {
      const n = ctx.varMap.get(-(op.disp || 0));
      if (n) return '局部变量 ' + n;
    }
    if (op.base === 'rbp' && (op.disp || 0) === 0) return '保存的 rbp';
    if (op.base === 'rbp' && (op.disp || 0) === 8) return '返回地址';
    if (op.base === 'rsp') return '栈顶';
    return '内存单元';
  }

  /* ---------- 单行解释 ---------- */
  // 别名归一到同一个解释分支：写法不同，做的事完全一样
  const MNEM_ALIAS = { sal: 'shl', cqto: 'cqo', cltq: 'cdqe', cwd: 'cdq' };
  const SET_CN = {
    sete: '相等（ZF=1）', setne: '不相等（ZF=0）',
    setl: '小于（有符号）', setle: '小于等于（有符号）', setg: '大于（有符号）', setge: '大于等于（有符号）',
    setb: '小于（无符号）', setbe: '小于等于（无符号）', seta: '大于（无符号）', setae: '大于等于（无符号）'
  };

  function explainLine(ins, m, ctx) {
    ctx = ctx || {};
    const rawMn = ins.mnem;
    const mn = MNEM_ALIAS[rawMn] || rawMn;
    const ops = ins.ops;
    const info = D.INSTR_MAP[rawMn] || D.INSTR_MAP[mn];
    const cat = info ? D.CAT[info.cat] : D.CAT.misc;
    const d0 = describeOperand(ops[0], m, ctx);
    const d1 = describeOperand(ops[1], m, ctx);
    const r = {
      line: ins.lineNo,
      addr: ins.addr,
      text: ins.text,
      mnem: rawMn,
      cat,
      cn: info ? info.cn : mn,
      headline: '',
      detail: '',
      flags: info ? info.flags : '未知',
      tip: '',
      src: ins.comment || '',
      ops: [d0, d1],
      memAddr: null
    };

    const dstMem = ops[0] && ops[0].kind === 'mem';
    const srcMem = ops[1] && ops[1].kind === 'mem';
    if (dstMem && d0.addr !== null) r.memAddr = d0.addr;
    else if (srcMem && d1.addr !== null) r.memAddr = d1.addr;

    // 序言/尾声识别
    const isFirst = ins.index === 0;
    const nextIns = ctx.prog ? ctx.prog.instrs[ins.index + 1] : null;

    switch (mn) {
      case 'mov':
        if (dstMem && ops[1].kind === 'reg') {
          r.headline = '把 ' + d1.short + ' 的值写入 ' + memRole(ops[0], m, ctx, true);
          r.detail = '读 ' + d1.detail + '，把它的低 ' + ((ops[0].size || ops[1].size) * 8) + ' 位写进 ' + d0.detail + '。原来存放的 ' + (d0.value !== null ? bothStr(d0.value) : '值') + ' 会被覆盖。';
        } else if (dstMem && ops[1].kind === 'imm') {
          r.headline = '把立即数 ' + d1.short + ' 存入 ' + memRole(ops[0], m, ctx, true);
          r.detail = '这是一个常量赋值：把 ' + d1.detail + ' 直接写进 ' + d0.detail + '。C 里的 int x = ' + d1.short + '; 往往编译成这一句。';
        } else if (ops[0].kind === 'reg' && srcMem) {
          r.headline = '从 ' + memRole(ops[1], m, ctx) + ' 读一个数据放进 ' + d0.short;
          r.detail = '按 ' + ((ops[0].size === 8) ? 32 : (ops[0].size * 8)) + ' 位从 ' + d1.detail + ' 读出，送到寄存器 ' + d0.short + '。' +
            (ops[0].name === 'eax' ? '注意：写 eax 会自动把 rax 的高 32 位清零。' : '');
        } else if (ops[0].kind === 'reg' && ops[1].kind === 'reg') {
          r.headline = '把 ' + d1.short + ' 复制到 ' + d0.short;
          r.detail = '寄存器之间搬数据：' + d1.detail + ' → ' + d0.detail + '。源寄存器的内容不变。';
        } else if (ops[0].kind === 'reg' && ops[1].kind === 'imm') {
          r.headline = '把立即数 ' + d1.short + ' 放进 ' + d0.short;
          r.detail = '直接把常量 ' + d1.short + ' 送进寄存器 ' + d0.short + '。' +
            (ops[0].size === 4 ? '写 32 位寄存器会自动把 ' + 'r' + ops[0].name.slice(1) + ' 的高 32 位清零，所以常量的高 32 位不会被保留。' : '');
        } else {
          r.headline = '传送数据：' + d1.short + ' → ' + d0.short;
          r.detail = d1.detail + ' → ' + d0.detail;
        }
        r.tip = r.tip || 'mov 不影响任何标志位，所以它不会"顺便"改变后面条件跳转的结果。';
        break;

      case 'lea': {
        const label = ops[1] && ops[1].label;
        const strSeg = (ctx.prog && ctx.prog.strings || []).find(x => x.addr === (ops[1].disp || 0) && !ops[1].base);
        if (strSeg) {
          r.headline = '取字符串常量 "' + strSeg.text.replace(/\n/g, '\\n') + '" 的地址，放进 ' + d0.short;
          r.detail = 'lea 只计算地址，不读内容。这里把只读数据段里这段文字的起始地址（' + hex(ops[1].disp) + '）送入 ' + d0.short + '，因为 printf 需要的是"字符串在哪"而不是"字符串是什么"。';
        } else {
          r.headline = '计算地址 ' + d1.short + ' 并存入 ' + d0.short;
          r.detail = 'lea 用的是 CPU 的地址计算器：算出 [' + (ops[1].text || '').replace(/^\[|\]$/g, '') + '] 的地址值' +
            (m ? '（= ' + hex(m.effAddr(ops[1])) + '）' : '') + '，把这个"地址"放进 ' + d0.short + '，不访问该内存。';
        }
        r.tip = '编译器常用 lea 做加法：lea eax, [rbp-4] 相当于取地址，lea eax, [eax+eax*2] 相当于 ×3。';
        break;
      }

      case 'push':
        if (ops[0].name === 'rbp' && isFirst) {
          r.headline = '函数序言第 1 步：把调用者的 rbp 压栈保存';
          r.detail = 'rsp 先减 8（' + (m ? hex64(m.regs.rsp) + ' → ' + hex64(m.regs.rsp - 8) : '向下移 8 字节') + '），再把调用者的 rbp 值写进新的栈顶。这样函数返回时才能恢复调用者的栈。';
          r.tip = 'push rbp 与结尾的 pop/leave 是配对的，少一个就会破坏调用者的栈帧。';
        } else {
          r.headline = '把 ' + d0.short + ' 压入栈顶';
          r.detail = 'rsp 先减 8，再把 ' + d0.detail + ' 写进新栈顶 [rsp]。栈向低地址方向生长。';
        }
        break;

      case 'pop':
        r.headline = '从栈顶弹出一个值到 ' + d0.short;
        r.detail = '读取 [rsp] 处的 8 字节（当前 ' + (d1.value !== null && !isNaN(d1.value) ? '' : '') + '），送入 ' + d0.short + '，然后 rsp 加 8。';
        break;

      case 'add': case 'sub': case 'imul': case 'and': case 'or': case 'xor': {
        const sym = { add: '+', sub: '−', imul: '×', and: 'AND', or: 'OR', xor: 'XOR' }[mn];
        const old = d0.value;
        const b = d1.value;
        let res = null;
        if (old !== null && b !== null && old !== undefined && b !== undefined) {
          const bits = (ops[0].kind === 'reg' ? ops[0].size : (ops[0].size || 4)) * 8;
          res = VM.arith(mn === 'imul' ? 'mul' : mn, old, b, bits).res;
        }
        if (dstMem) {
          r.headline = memRole(ops[0], m, ctx) + ' ' + sym + '= ' + d1.short + (res !== null ? '（' + bothStr(old) + ' → ' + bothStr(res) + '）' : '');
          r.detail = '取出 ' + d0.detail + '，与 ' + d1.detail + ' 做' + (info ? info.cn : '运算') + '，结果写回同一块内存。' +
            (res !== null ? '计算：' + old + ' ' + sym + ' ' + b + ' = ' + res + '。' : '');
        } else {
          r.headline = d0.short + ' ' + sym + '= ' + d1.short + (res !== null ? '（' + bothStr(old) + ' → ' + bothStr(res) + '）' : '');
          r.detail = '把 ' + d0.detail + ' 与 ' + d1.detail + ' 做' + (info ? info.cn : '运算') + '，结果留在 ' + d0.short + '。' +
            (res !== null ? '计算：' + old + ' ' + sym + ' ' + b + ' = ' + res + '。' : '');
        }
        if (mn === 'sub' && ops[0].name === 'rsp') {
          r.headline = '在栈上开辟 ' + d1.short + ' 字节的局部变量空间';
          r.detail = 'rsp 从 ' + (m ? hex64(m.regs.rsp) : '栈顶') + ' 向下移动 ' + d1.short + ' 字节。这块空间就是后面 [rbp-4]、[rbp-8] 等局部变量的家。' +
            '编译器会按 16 字节对齐，所以即使只有 1 个 int，也常看到 sub rsp, 16。';
        }
        if (mn === 'add' && ops[0].name === 'rsp') r.detail += '这是释放栈空间（函数返回前常见）。';
        break;
      }

      case 'inc': case 'dec': {
        const step = mn === 'inc' ? '+1' : '−1';
        const old = d0.value;
        r.headline = (dstMem ? memRole(ops[0], m, ctx) : d0.short) + ' ' + step + (old !== null ? '（' + old + ' → ' + (old + (mn === 'inc' ? 1 : -1)) + '）' : '');
        r.detail = '把 ' + d0.detail + ' 加/减 1 后写回。比 add 目标, 1 更短，但注意：inc/dec 不改变 CF 标志。';
        r.tip = '循环里 i++ 编译后通常就是这一条（或 add ..., 1）。';
        break;
      }

      case 'cmp': {
        const a = d0.value, b = d1.value;
        let extra = '';
        if (a !== null && b !== null) {
          const bits = (ops[0].kind === 'reg' ? ops[0].size : (ops[0].size || 4)) * 8;
          const res = VM.arith('sub', a, b, bits);
          extra = '本例：' + a + ' − ' + b + ' = ' + Math.trunc(a - b) + '，' +
            'ZF=' + (a === b ? 1 : 0) + '，SF=' + (res.sf ? 1 : 0) + '，CF=' + (res.cf ? 1 : 0) + '，OF=' + (res.of ? 1 : 0) + '。';
        }
        r.headline = '比较 ' + d0.short + ' 与 ' + d1.short + '（只改标志位，不改数据）';
        r.detail = 'CPU 内部做一次减法 ' + d0.short + ' − ' + d1.short + '，但结果丢掉，只留下标志位。' + extra +
          '紧接着的条件跳转指令就读这些标志来决定走哪条路。';
        r.tip = 'cmp 必须和后面的 jcc 连起来读：单独一条 cmp 什么也不决定。';
        break;
      }

      case 'test':
        r.headline = '测试 ' + d0.short + ' 是否为 0 / 某些位是否为 1';
        r.detail = '内部做 AND 运算但不保存结果，只更新 ZF（结果为 0 则 ZF=1）。test eax, eax 就是"eax 是不是 0"的标准问法。';
        break;

      case 'jmp': {
        const tgt = ops[0].label || ops[0].text;
        const idx = ctx.prog && ctx.prog.labels.get(tgt);
        const backward = idx && ctx.prog && idx.index <= ins.index;
        r.headline = '无条件跳转到 ' + tgt + (backward ? '（往回跳 → 循环）' : '（往前跳 → 跳过一段代码）');
        r.detail = backward
          ? '跳回 ' + tgt + '（地址比当前指令小），这通常意味着循环进入下一轮。循环体就是"标签 ' + tgt + ' 到这条 jmp 之间"的代码。'
          : '直接跳过 ' + tgt + ' 之前的一段代码。常见于 if/else：then 分支执行完要跳过 else 分支。';
        break;
      }

      case 'je': case 'jz': case 'jne': case 'jnz': case 'jl': case 'jle': case 'jg': case 'jge':
      case 'ja': case 'jae': case 'jb': case 'jbe': {
        const tgt = ops[0].label || ops[0].text;
        const condText = { je: '相等', jz: '结果为零', jne: '不相等', jnz: '结果非零', jl: '小于（有符号）', jle: '小于等于（有符号）', jg: '大于（有符号）', jge: '大于等于（有符号）', ja: '高于（无符号）', jae: '高于等于（无符号）', jb: '低于（无符号）', jbe: '低于等于（无符号）' }[mn];
        const taken = m ? VM.condTrue(mn, m.flags) : null;
        r.headline = '若' + condText + '则跳到 ' + tgt + (taken !== null ? '（本次：' + (taken ? '跳转 ✓' : '不跳 ✗') + '）' : '');
        r.detail = '它读取上一条指令（通常是 cmp/test）留下的标志位：' +
          (m ? '当前 ZF=' + m.flags.ZF + '、SF=' + m.flags.SF + '、CF=' + m.flags.CF + '、OF=' + m.flags.OF + '，' : '') +
          '条件成立就改 rip 跳到 ' + tgt + '，不成立就继续执行下一条。';
        r.tip = '有符号数用 jl/jg，无符号数用 jb/ja，混用会在负数或大数上出错。';
        break;
      }

      case 'call': {
        const name = ops[0].label || ops[0].text;
        const builtin = ['printf', 'puts', 'putchar', 'exit'].indexOf(name) >= 0;
        r.headline = '调用 ' + name + '()';
        if (builtin && m) {
          const fmtAddr = m.readReg('rdi');
          const fmt = m.readCString(fmtAddr);
          const args = ['rsi', 'rdx', 'rcx', 'r8', 'r9'].map(x => m.readReg(x));
          r.detail = '按调用约定：rdi 放格式串（"' + fmt.replace(/\n/g, '\\n') + '"），rsi/rdx/rcx/r8/r9 依次放参数值（' +
            args.slice(0, 3).join(', ') + (args.length > 3 ? ', …' : '') + '）。call 会把返回地址压栈，函数执行完用 ret 跳回来。';
        } else {
          r.detail = '把下一条指令的地址压入栈（返回地址），然后跳到 ' + name + ' 执行；函数结束时的 ret 会把这个地址弹回 rip。';
        }
        r.tip = 'call 等价于 push 返回地址 + jmp 目标，ret 就是 pop rip。';
        break;
      }

      case 'ret':
        r.headline = '函数返回';
        r.detail = '从栈顶弹出返回地址送入 rip，回到调用者的下一条指令。返回值通常已在 eax 中。';
        break;

      case 'leave':
        r.headline = '恢复栈帧（丢弃局部变量）';
        r.detail = '执行 mov rsp, rbp 把栈顶拉回函数开头，再 pop rbp 恢复调用者的栈基址。相当于"把整个局部变量区一次性扔掉"。';
        r.tip = 'leave + ret 与开头的 push rbp / mov rbp,rsp 严格对应。';
        break;

      case 'idiv':
        r.headline = '有符号除法：被除数在 edx:eax 中，除数是 ' + d0.short;
        r.detail = '商存入 eax，余数存入 edx。所以除法前一般会先 cdq（或 64 位用 cqo）把符号扩展进 edx。若除数为 0 会触发除法异常。';
        break;

      case 'div':
        r.headline = '无符号除法：被除数在 edx:eax 中，除数是 ' + d0.short;
        r.detail = '商存入 eax，余数存入 edx。无符号除法不能用 cdq 铺符号位，必须先把 edx 清零（xor edx, edx），否则高位残留会让商溢出。';
        break;

      case 'cdq':
        r.headline = '把 eax 的符号扩展到 edx';
        r.detail = '为 idiv 准备 64 位被除数：正数时 edx=0，负数时 edx=0xFFFFFFFF。';
        break;

      case 'movzx':
        r.headline = '把 ' + d1.short + ' 零扩展后送入 ' + d0.short;
        r.detail = '源只有 ' + ((ops[1].size || 1) * 8) + ' 位，高位一律补 0 后放进 ' + d0.short + '。常用来把 setcc 得到的 0/1 变成 32 位整数。';
        break;

      case 'movsx':
        r.headline = '把 ' + d1.short + ' 符号扩展后送入 ' + d0.short;
        r.detail = '高位用源操作数的符号位填充，这样 -1（0xFF）扩展后仍是 -1（0xFFFFFFFF）。';
        break;

      case 'shl': case 'shr': case 'sar':
        r.headline = { shl: '左移', shr: '逻辑右移', sar: '算术右移' }[mn] + ' ' + d1.short + ' 位';
        r.detail = mn === 'shl' ? '每左移 1 位相当于乘以 2，低位补 0。' :
          mn === 'shr' ? '高位补 0，等价于无符号数除以 2 的幂。' :
            '高位补符号位，负数右移后仍是负数（相当于有符号除以 2 的幂，向负无穷取整）。';
        break;

      case 'neg':
        r.headline = '对 ' + d0.short + ' 取负';
        r.detail = '相当于 0 − 目标，按补码规则把每一位取反再加 1。';
        break;

      case 'not':
        r.headline = '按位取反 ' + d0.short;
        r.detail = '0 变 1、1 变 0。注意 not 不改变任何标志位。';
        break;

      case 'nop':
        r.headline = '空操作（占位）';
        r.detail = '什么也不做。常用于代码对齐或给跳转留出位置。';
        break;

      /* ─────────── 浮点 / SSE ─────────── */
      case 'movsd': case 'movss': {
        const isF32 = mn === 'movss';
        const dstIsXmm = ops[0].kind === 'reg' && ops[0].size === 16;
        if (dstIsXmm) {
          r.headline = '把' + (isF32 ? '单精度' : '双精度') + '浮点数读进 ' + d0.short;
          r.detail = '按 ' + (isF32 ? '32' : '64') + ' 位从 ' + d1.detail + ' 读出一个 IEEE-754 浮点数，放进浮点寄存器 ' +
            d0.short + '。整数走 eax/rcx，小数走 xmm，这是两条并行的数据通路。';
        } else {
          r.headline = '把 ' + d1.short + ' 里的浮点值写进 ' + memRole(ops[0], m, ctx, true);
          r.detail = '把 ' + d1.detail + ' 中的' + (isF32 ? '单精度（32 位）' : '双精度（64 位）') + '浮点数存到 ' + d0.detail + '。';
        }
        break;
      }
      case 'addsd': case 'subsd': case 'mulsd': case 'divsd':
      case 'addss': case 'subss': case 'mulss': case 'divss': {
        const cn = { add: '加', sub: '减', mul: '乘', div: '除' }[mn.slice(0, 3)];
        const w = /ss$/.test(mn) ? 32 : 64;
        r.headline = '浮点' + cn + '：' + d0.short + ' = ' + d0.short + ' ' + { add: '+', sub: '−', mul: '×', div: '÷' }[mn.slice(0, 3)] + ' ' + d1.short;
        r.detail = '两个 ' + w + ' 位浮点数做' + cn + '法，结果写回 ' + d0.short + '。浮点运算<b>不设置</b> ZF/SF/CF/OF，' +
          '所以后面不能直接接 je/jl，要用 ucomisd 重新比较。';
        r.tip = '浮点除零得到 inf（程序继续跑），整数除零会崩溃——这是两类指令的重要区别。';
        break;
      }
      case 'sqrtsd': case 'sqrtss':
        r.headline = '开平方：' + d0.short + ' = √' + d1.short;
        r.detail = '对浮点数开平方，结果写回 ' + d0.short + '。';
        break;
      case 'ucomisd': case 'comisd': case 'ucomiss': case 'comiss':
        r.headline = '比较两个浮点数：' + d0.short + ' 和 ' + d1.short;
        r.detail = '只设置 ZF/PF/CF：相等时 ZF=1，左边更小时 CF=1。因此浮点比较后面跟的是 ' +
          '<b>ja / jb / jae / jbe</b>（无符号系列），而不是 jg / jl。';
        r.tip = '这是浮点最反直觉的地方：因为 CF 在这里表示"小于"，所以要用无符号条件跳转。';
        break;
      case 'cvtsi2sd': case 'cvtsi2ss':
        r.headline = '整数转浮点：' + d1.short + ' → ' + d0.short;
        r.detail = '把通用寄存器里的整数转换成浮点数放进 xmm。C 里 int 与 double 混算时，编译器会插入这条指令。';
        break;
      case 'cvttsd2si': case 'cvttss2si':
        r.headline = '浮点转整数（直接截断小数）';
        r.detail = '丢掉小数部分只留整数部分，写入通用寄存器。所以 (int)3.9 得 3，(int)-3.9 得 -3，都是朝 0 取整。';
        break;
      case 'cvtsd2ss': case 'cvtss2sd':
        r.headline = '单精度 / 双精度互相转换';
        r.detail = '改变浮点数的存储精度。float 只有约 7 位有效数字，转成 float 再转回来可能已经丢了精度。';
        break;
      case 'xorpd': case 'xorps': case 'pxor':
        r.headline = '把 ' + d0.short + ' 清零';
        r.detail = '同一个寄存器和自己异或，结果一定是 0。这是把浮点寄存器置零的标准写法（对应整数里的 xor eax, eax）。';
        break;
      case 'movsxd':
        r.headline = '把 32 位有符号数扩展成 64 位：' + d1.short + ' → ' + d0.short;
        r.detail = '符号位复制到高 32 位。指针做下标运算时常见：先把 int 下标变成 64 位偏移，再乘元素大小。';
        break;
      case 'cdqe': case 'cltq':
        r.headline = '把 eax 符号扩展成 rax';
        r.detail = '32 位有符号数 → 64 位，高位用符号位填满。';
        break;
      case 'cqo':
        r.headline = '把 rax 的符号扩展到 rdx';
        r.detail = '为 64 位 idiv 准备 128 位被除数，作用等同 32 位除法前的 cdq。';
        break;

      default:
        if (mn.indexOf('set') === 0) {
          r.headline = (SET_CN[mn] || '条件成立') + '时把 ' + d0.short + ' 置 1，否则置 0';
          r.detail = '把上一条比较的布尔结果写进 8 位寄存器：条件成立写 1，不成立写 0。' +
            '它只改 1 个字节，所以后面通常跟 movzx 把高 24 位清零，才能得到干净的 0 / 1。';
        } else if (mn.indexOf('cmov') === 0) {
          const c = SET_CN['set' + mn.slice(4)];
          r.headline = (c ? c + '时' : '条件成立时') + '才把 ' + d1.short + ' 搬到 ' + d0.short;
          r.detail = '条件传送：先由上一行的 cmp/test 设好标志位，只有条件成立才真的执行搬运，' +
            '不成立时目标保持原值。它没有跳转，所以不会打断 CPU 的流水线。';
        } else if (info) {
          r.headline = info.cn + '：' + info.desc;
          r.detail = info.desc;
          r.tip = info.tip || '';
        } else {
          r.headline = '指令 ' + mn;
          r.detail = '暂未收录这条指令的详细解释。';
        }
    }

    if (!r.tip && info && info.tip) r.tip = info.tip;
    return r;
  }

  /* ---------- 整体分析 ---------- */
  function analyzeProgram(prog, ctx) {
    ctx = ctx || {};
    const instrs = prog.instrs || [];
    const dec = ctx.dec;
    const byCat = {};
    const regsUsed = new Set();
    const memOffsets = new Map(); // rbp偏移 -> {size}
    let frame = 0, pushCount = 0, popCount = 0;
    let branches = 0, calls = [], condJumps = 0;
    const loopTargets = new Set();
    let prologue = false, epilogue = false;

    instrs.forEach((ins, i) => {
      const info = D.INSTR_MAP[ins.mnem];
      const c = info ? info.cat : 'misc';
      byCat[c] = (byCat[c] || 0) + 1;
      ins.ops.forEach(op => {
        if (op.kind === 'reg') { const ri = VM.regInfo(op.name); if (ri) regsUsed.add(ri.parent); }
        if (op.kind === 'mem' && op.base === 'rbp') {
          const off = op.disp || 0;
          memOffsets.set(off, Math.max(memOffsets.get(off) || 0, op.size || 4));
        }
      });
      if (ins.mnem === 'push') pushCount++;
      if (ins.mnem === 'pop') popCount++;
      if (ins.mnem === 'sub' && ins.ops[0].kind === 'reg' && ins.ops[0].name === 'rsp') {
        const v = ins.ops[1].value || 0;
        if (ins.ops[1].kind === 'imm') frame = Math.max(frame, v);
      }
      if (ins.mnem[0] === 'j' && ins.mnem !== 'jmp') { condJumps++; branches++; }
      if (ins.mnem === 'jmp' || (ins.mnem[0] === 'j' && ins.mnem !== 'jmp')) {
        const t = ins.ops[0] && (ins.ops[0].label);
        if (t) {
          const L = prog.labels.get(t);
          if (L && L.kind === 'code' && L.index <= i) loopTargets.add(t);
        }
      }
      if (ins.mnem === 'call') { const n = ins.ops[0].label || ins.ops[0].text; if (calls.indexOf(n) < 0) calls.push(n); }
      if (ins.mnem === 'push' && ins.ops[0].name === 'rbp' && i === 0) prologue = true;
      if (ins.mnem === 'leave' || ins.mnem === 'ret') epilogue = true;
    });

    const total = instrs.length;
    const cats = Object.keys(byCat).map(k => ({
      key: k, name: D.CAT[k] ? D.CAT[k].name : k, color: D.CAT[k] ? D.CAT[k].color : '#888',
      count: byCat[k], pct: Math.round(byCat[k] / total * 100)
    })).sort((a, b) => b.count - a.count);

    // 栈帧布局
    const frameSlots = [];
    Array.from(memOffsets.keys()).sort((a, b) => b - a).forEach(off => {
      if (off === 0) frameSlots.push({ label: 'rbp+0', desc: '保存的调用者 rbp', size: 8, kind: 'save' });
      else if (off > 0) frameSlots.push({ label: 'rbp+' + off, desc: off === 8 ? '返回地址' : '上层参数 / 数据', size: 8, kind: 'ret' });
      else {
        const name = (ctx.varMap && ctx.varMap.get(-off)) || null;
        frameSlots.push({ label: 'rbp' + off, desc: name ? '局部变量 ' + name : '局部变量 / 临时数据', size: memOffsets.get(off), kind: 'local' });
      }
    });

    // 程序阶段划分
    const phases = [];
    const phaseOf = ins => {
      if (ins.mnem === 'push' && ins.ops[0] && ins.ops[0].name === 'rbp') return { key: 'prologue', name: '函数序言', desc: '保存调用者的栈基址并建立本函数的栈帧' };
      if (ins.mnem === 'sub' && ins.ops[0].name === 'rsp') return { key: 'prologue', name: '函数序言', desc: '在栈上开辟局部变量空间' };
      if (ins.mnem === 'mov' && ins.ops[0].kind === 'reg' && ins.ops[0].name === 'rbp' && ins.ops[1].name === 'rsp') return { key: 'prologue', name: '函数序言', desc: '保存调用者的栈基址并建立本函数的栈帧' };
      if (ins.mnem === 'leave' || ins.mnem === 'ret') return { key: 'epilogue', name: '函数尾声', desc: '恢复栈帧并返回到调用者' };
      if (ins.mnem === 'call') return { key: 'call', name: '函数调用', desc: '调用外部函数（如 printf）完成输入输出' };
      if (ins.mnem === 'cmp' || ins.mnem === 'test' || (ins.mnem[0] === 'j')) return { key: 'ctrl', name: '条件与跳转', desc: '比较数据并决定程序的执行路径（if / 循环都靠它）' };
      return { key: 'calc', name: '数据准备与计算', desc: '在寄存器与栈变量之间搬运数据、做算术运算' };
    };
    let cur = null;
    instrs.forEach(ins => {
      const ph = phaseOf(ins);
      if (!cur || cur.key !== ph.key) {
        cur = { key: ph.key, name: ph.name, desc: ph.desc, from: ins.lineNo, to: ins.lineNo, count: 1 };
        phases.push(cur);
      } else { cur.to = ins.lineNo; cur.count++; }
    });

    // 特征识别（用于生成功能概括）
    const feats = detectFeatures(instrs, dec, ctx);

    const summary = buildSummary(feats, { frame, cats, loopTargets, calls, total, frameSlots });

    // 风险 / 提示
    const tips = [];
    if (pushCount !== popCount && frame === 0) tips.push('push 与 pop 次数不相等（' + pushCount + ' : ' + popCount + '），如果不是有意为之，函数返回时栈可能错位。');
    if (total && !epilogue) tips.push('代码里没有出现 ret，作为完整函数它不会自己返回（可能只是片段）。');
    if (loopTargets.size && !condJumps) tips.push('存在往回跳的 jmp 但没有任何条件跳转，可能是死循环。');
    if (!prologue && total > 4) tips.push('没有 push rbp / mov rbp, rsp 序言，说明这段代码没有使用标准栈帧，可能只是片段或被优化过。');
    // 除法相关提示只看真实指令，不看 C 源码里的大概率匹配（否则纯浮点除法会误报）
    const hasIdiv = instrs.some(i => i.mnem === 'idiv');
    const hasUdiv = instrs.some(i => i.mnem === 'div');
    const hasSignPrep = instrs.some(i => i.mnem === 'cdq' || i.mnem === 'cqo' || i.mnem === 'cwd');
    if (hasIdiv && !hasSignPrep) tips.push('用了 idiv 但前面没有 cdq/cqo，若被除数是负数，商和余数会是错的。');
    if (hasUdiv) {
      const divIdx = instrs.findIndex(i => i.mnem === 'div');
      const prev = divIdx > 0 ? instrs[divIdx - 1] : null;
      const zeroed = prev && ((prev.mnem === 'xor' && prev.ops[0].name === 'edx' && prev.ops[1].name === 'edx') ||
        (prev.mnem === 'mov' && prev.ops[0].name === 'edx' && prev.ops[1].kind === 'imm' && prev.ops[1].value === 0));
      if (!zeroed) tips.push('用了无符号 div，但前面没有把 edx 清零，被除数高位残留会让商溢出（除法异常）。');
    }
    if (frame && frame % 16 !== 0) tips.push('局部空间 ' + frame + ' 字节不是 16 的倍数，调用 printf 等库函数时可能栈未对齐。');

    return {
      total, cats, frame, frameSlots, phases, feats, summary, tips,
      branches, condJumps, loops: loopTargets.size, calls,
      regsUsed: Array.from(regsUsed),
      strings: prog.strings || [],
      pushCount, popCount, prologue, epilogue
    };
  }

  // 累加模式：从某个栈槽读到寄存器 → add 一下 → 又写回同一个栈槽
  function detectAccumulate(instrs) {
    const disp = o => (o && typeof o.disp === 'number' ? o.disp : 0);
    for (let i = 0; i < instrs.length; i++) {
      const a = instrs[i];
      if (a.mnem !== 'add' || !a.ops[0] || a.ops[0].kind !== 'reg') continue;
      const r = a.ops[0].name;
      let slot = null;
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        const b = instrs[k];
        if (b.mnem === 'mov' && b.ops[0] && b.ops[0].kind === 'reg' && b.ops[0].name === r &&
          b.ops[1] && b.ops[1].kind === 'mem') { slot = disp(b.ops[1]); break; }
      }
      if (slot === null) continue;
      for (let k = i + 1; k <= i + 6 && k < instrs.length; k++) {
        const c = instrs[k];
        if (c.mnem === 'mov' && c.ops[0] && c.ops[0].kind === 'mem' && disp(c.ops[0]) === slot &&
          c.ops[1] && c.ops[1].kind === 'reg' && c.ops[1].name === r) return true;
      }
    }
    return false;
  }

  function detectFeatures(instrs, dec, ctx) {
    const f = {
      hasLoop: false, hasBranch: false, hasCall: false, hasPrintf: false,
      hasMul: false, hasDiv: false, hasMod: false, hasSub: false, hasAdd: false,
      accumulate: false, counter: false, compareMax: false,
      loopCount: 0, vars: (dec && dec.vars) || []
    };
    const mnems = instrs.map(i => i.mnem);
    // imul 的三操作数形式（imul reg, reg, 立即数）基本都是「下标 × 元素大小」的地址缩放，
    // 不能当成真正的乘法，否则求平均分那种程序会被说成「做连乘」
    f.hasMul = instrs.some(i => i.mnem === 'imul' &&
      !(i.ops.length === 3 && i.ops[2] && i.ops[2].kind === 'imm'));
    f.hasDiv = mnems.indexOf('idiv') >= 0 || mnems.indexOf('div') >= 0;
    f.hasCall = mnems.indexOf('call') >= 0;
    f.hasPrintf = instrs.some(i => i.mnem === 'call' && /printf|puts|putchar/.test(i.ops[0].label || ''));
    f.hasBranch = instrs.some(i => i.mnem[0] === 'j' && i.mnem !== 'jmp');
    // 回跳 = 循环
    instrs.forEach((ins, i) => {
      if (ins.mnem === 'jmp' || ins.mnem[0] === 'j') {
        const t = ins.ops[0] && ins.ops[0].label;
        if (t) {
          const L = ctx && ctx.prog ? ctx.prog.labels.get(t) : null;
          if (L && L.index <= i) { f.hasLoop = true; f.loopCount = Math.max(f.loopCount, 1); }
        }
      }
    });
    if (dec && dec.tree) {
      const walk = nodes => (nodes || []).forEach(n => {
        if (n.k === 'while') { f.hasLoop = true; f.loopCount++; }
        if (n.k === 'if') f.hasBranch = true;
        if (n.k === 'assign') {
          const t = global.ASM_DECOMP ? global.ASM_DECOMP.exprText(n.expr) : '';
          if (t.indexOf(n.name + ' + ') === 0) f.accumulate = true;
          if (t.indexOf(n.name + ' * ') === 0) { f.hasMul = true; f.accumulate = true; }
          if (/\+ 1\)?$/.test(t) && t.indexOf(n.name) === 0) f.counter = true;
          // 除法只在真的出现 idiv / div 指令时才算（浮点 divsd 不算整数除法）
        }
        if (n.then) walk(n.then);
        if (n.els) walk(n.els);
        if (n.body) walk(n.body);
      });
      walk(dec.tree);
    }
    if (!f.accumulate && detectAccumulate(instrs)) f.accumulate = true;
    return f;
  }

  function buildSummary(f, info) {
    const parts = [];
    const varCount = (f.vars || []).length;
    let behavior = '';
    if (f.hasLoop && f.hasMul) behavior = '在循环里做连乘（常见于阶乘/幂运算）';
    else if (f.hasLoop && f.accumulate) behavior = '用循环把一串数累加起来';
    else if (f.hasLoop && f.counter) behavior = '用循环重复执行若干次操作';
    else if (f.hasLoop) behavior = '用循环反复处理数据';
    else if (f.hasBranch) behavior = '根据条件在两个分支中选择一个执行';
    else if (info.total <= 6) behavior = '按顺序做几步简单计算';
    else behavior = '顺序执行一组计算与数据搬运';

    parts.push(behavior);
    if (f.hasPrintf) parts.push('最后通过 printf 把结果输出到屏幕');
    else if (f.hasCall) parts.push('过程中调用了外部函数');
    if (f.hasDiv) parts.push('其中用到整数除法/取余');
    if (f.hasBranch && f.hasLoop) parts.push('循环内部还夹着条件判断');

    const oneLine = '这段程序的主要功能是：' + parts.join('，') + '。';

    const bullets = [];
    bullets.push('共 ' + info.total + ' 条指令，' + (info.frame ? '在栈上开辟 ' + info.frame + ' 字节局部空间，' : '没有开辟局部栈空间，') + '使用 ' + varCount + ' 个局部变量。');
    if (f.loopCount) bullets.push('包含 ' + f.loopCount + ' 处循环' + (info.loopTargets && info.loopTargets.size ? '（循环入口标签：' + Array.from(info.loopTargets).join('、') + '）' : '') + '。');
    if (f.hasBranch) bullets.push('包含条件分支，程序会根据数据的比较结果走不同路径——这正是汇编里"标志位 + 条件跳转"的用法。');
    if (f.hasPrintf) bullets.push('通过 rdi 传格式串、rsi/rdx/… 传参数调用 printf，这是 x86-64 的系统 V 调用约定。');
    if (!f.hasLoop && !f.hasBranch) bullets.push('没有循环和分支，属于顺序结构：从第一条一路执行到最后一条。');
    if (info.cats.length) bullets.push('指令类型以「' + info.cats[0].name + '」为主（' + info.cats[0].count + ' 条，占 ' + info.cats[0].pct + '%）。');

    return { oneLine, bullets };
  }

  const API = { describeOperand, explainLine, analyzeProgram, bothStr, hex };
  global.ASM_ANALYZE = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
