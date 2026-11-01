/* ============================================================
 * AI 代码解读：独立的分析栏
 * ------------------------------------------------------------
 * 两种模式：
 *   1) 本地分析引擎（默认，完全离线）—— 直接读 AST / 指令流 / 运行结果，
 *      生成"这段代码在做什么"的自然语言解读，不依赖网络。
 *   2) 大模型分析（可选）—— 用户在设置里填 OpenAI 兼容接口的
 *      Base URL / API Key / 模型名，点"AI 深度分析"时把代码和
 *      本地分析结果一起发过去，拿回更细的讲解。
 * 说明：纯前端页面没有内置密钥，所以默认走本地引擎；
 *      密钥只保存在本机 localStorage，不会上传到任何第三方服务。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 1. AST 扫描：从 C 源码里抽取结构信息
   * ============================================================ */
  function walkExpr(e, cb) {
    if (!e || typeof e !== 'object') return;
    cb(e);
    switch (e.k) {
      case 'bin': walkExpr(e.l, cb); walkExpr(e.r, cb); break;
      case 'un': walkExpr(e.e, cb); break;
      case 'addr': case 'deref': case 'incdec': case 'sizeof': walkExpr(e.e, cb); break;
      case 'assign': walkExpr(e.target, cb); walkExpr(e.e, cb); break;
      case 'cond': walkExpr(e.c, cb); walkExpr(e.a, cb); walkExpr(e.b, cb); break;
      case 'call': (e.args || []).forEach(a => walkExpr(a, cb)); break;
      case 'index': walkExpr(e.a, cb); walkExpr(e.i, cb); break;
      case 'field': walkExpr(e.b, cb); break;
      case 'arrow': walkExpr(e.p, cb); break;
    }
  }

  function walkStmt(s, cb) {
    if (!s || typeof s !== 'object') return;
    cb(s);
    switch (s.k) {
      case 'block': (s.body || []).forEach(x => walkStmt(x, cb)); break;
      case 'if': walkExpr(s.c, cb); walkStmt(s.then, cb); if (s.els) walkStmt(s.els, cb); break;
      case 'while': walkExpr(s.c, cb); walkStmt(s.body, cb); break;
      case 'dowhile': walkStmt(s.body, cb); walkExpr(s.c, cb); break;
      case 'for':
        if (s.init) { if (s.init.k === 'decl') walkStmt(s.init, cb); else walkExpr(s.init, cb); }
        if (s.cond) walkExpr(s.cond, cb);
        if (s.step) walkExpr(s.step, cb);
        walkStmt(s.body, cb);
        break;
      case 'decl': (s.items || []).forEach(it => { if (it.init) walkExpr(it.init, cb); }); break;
      case 'expr': walkExpr(s.e, cb); break;
      case 'return': walkExpr(s.e, cb); break;
    }
  }

  function scanAst(ast) {
    const info = {
      funcs: [], loops: 0, maxLoopDepth: 0, ifs: 0, calls: [], varTypes: {},
      hasPtr: false, hasStruct: false, hasFloat: false, hasArray: false,
      structs: [], returns: 0, breaks: 0
    };
    const loopKinds = [];
    let depth = 0;

    (ast || []).forEach(fn => {
      if (fn.k !== 'func') return;
      info.funcs.push({
        name: fn.name, ret: fn.ret ? fn.ret.k : 'int',
        params: (fn.params || []).map(p => p.name + ': ' + typeText(p.type))
      });
      const visit = (s) => {
        if (!s || typeof s !== 'object') return;
        if (['while', 'for', 'dowhile'].indexOf(s.k) >= 0) {
          info.loops++;
          loopKinds.push(s.k);
          depth++;
          info.maxLoopDepth = Math.max(info.maxLoopDepth, depth);
        }
        if (s.k === 'if') info.ifs++;
        if (s.k === 'return') info.returns++;
        if (s.k === 'break') info.breaks++;
        if (s.k === 'decl') {
          (s.items || []).forEach(it => {
            const t = typeText(it.type);
            info.varTypes[it.name] = t;
            if (it.type && it.type.k === 'ptr') info.hasPtr = true;
            if (it.type && it.type.k === 'array') info.hasArray = true;
            if (it.type && it.type.k === 'struct') info.hasStruct = true;
            if (it.type && (it.type.k === 'float' || it.type.k === 'double')) info.hasFloat = true;
          });
        }
        if (s.k === 'block') (s.body || []).forEach(visit);
        else if (s.k === 'if') { visit(s.then); visit(s.els); }
        else if (s.k === 'while' || s.k === 'dowhile') { visit(s.body); depth--; }
        else if (s.k === 'for') { visit(s.init); visit(s.body); depth--; }
        else if (s.k === 'switch') {
          info.switches = (info.switches || 0) + 1;
          (s.cases || []).forEach(c => (c.body || []).forEach(visit));
        }
        walkExpr(
          s.k === 'expr' ? s.e : s.k === 'return' ? s.e : s.k === 'if' ? s.c : null,
          e => {
            if (e.k === 'call' && info.calls.indexOf(e.name) < 0) info.calls.push(e.name);
            if (e.k === 'addr' || e.k === 'deref') info.hasPtr = true;
          }
        );
        if (s.k === 'decl') (s.items || []).forEach(it => walkExpr(it.init, e => {
          if (e.k === 'call' && info.calls.indexOf(e.name) < 0) info.calls.push(e.name);
          if (e.k === 'addr' || e.k === 'deref') info.hasPtr = true;
        }));
      };
      visit(fn.body);
    });

    // 全局变量
    (ast || []).forEach(x => {
      if (x.k !== 'gvar') return;
      info.varTypes[x.name] = typeText(x.type) + '（全局）';
      if (x.type && x.type.k === 'ptr') info.hasPtr = true;
      if (x.type && x.type.k === 'array') info.hasArray = true;
      if (x.type && x.type.k === 'struct') info.hasStruct = true;
      if (x.type && (x.type.k === 'float' || x.type.k === 'double')) info.hasFloat = true;
    });

    // 顶层结构体定义
    (ast || []).forEach(x => { if (x.k === 'structdef') info.structs.push(x.name); });
    info.loopKinds = loopKinds;
    return info;
  }

  function typeText(t) {
    if (!t) return '?';
    if (t.k === 'ptr') return typeText(t.to) + '*';
    if (t.k === 'array') return typeText(t.to) + '[' + t.n + ']';
    if (t.k === 'struct') return 'struct ' + t.name;
    return t.k;
  }

  /* ============================================================
   * 2. 本地分析：生成结构化解读
   * ============================================================ */
  function runToEnd(payload) {
    // 用一份克隆跑到底，拿"最终变量值"和"程序输出"
    const VM = global.ASM_VM;
    if (!payload || !payload.prog || !VM) return null;
    try {
      const m = new VM.Machine(payload.prog);
      let guard = 0;
      while (!m.halted && guard++ < 200000) m.step();
      const vars = [];
      const map = payload.varMap || new Map();
      map.forEach((name, off) => {
        const rt = global.C2ASM ? null : null;
        let val = null, isFloat = false;
        // 尝试按 4/8 字节读取，浮点值用范围判断
        const i4 = m.readMem(m.regs.rbp - off, 4);
        const i8 = m.readMem(m.regs.rbp - off, 8);
        val = i4;
        if (Math.abs(i4) > 1000000 && Math.abs(i8) < 1e12) val = i8;
        vars.push({ name: name, value: val, raw4: i4, raw8: i8, isFloat: isFloat });
      });
      return { output: m.output || '', halted: m.halted, reason: m.haltReason, steps: m.steps, vars: vars, machine: m };
    } catch (e) {
      return null;
    }
  }

  function describePurpose(scan, extra) {
    const bits = [];
    if (scan.hasStruct) bits.push('结构体');
    if (scan.hasPtr) bits.push('指针');
    if (scan.hasFloat) bits.push('浮点数');
    if (scan.hasArray) bits.push('数组');
    const kind = bits.length ? bits.join(' / ') + ' 相关' : '基本变量';

    const flow = [];
    if (scan.calls.indexOf('printf') >= 0 || scan.calls.indexOf('puts') >= 0) flow.push('把结果打印出来');
    if (scan.loops > 0) flow.push('用循环重复' + (scan.maxLoopDepth > 1 ? '（还有嵌套）' : '') + '处理数据');
    if (scan.ifs > 0) flow.push('根据条件走不同分支');
    if (scan.funcs.length > 1) flow.push('拆分出 ' + (scan.funcs.length - 1) + ' 个自定义函数分工完成');

    let s = '这是一个以' + kind + '为主的程序';
    if (flow.length) s += '：它' + flow.join('、') + '。';
    else s += '：顺序执行若干计算并返回结果。';
    if (extra && extra.output) {
      const first = extra.output.trim().split('\n')[0];
      if (first) s += '运行时第一行输出是「' + first.slice(0, 40) + '」。';
    }
    return s;
  }

  function localAnalyze(payload) {
    payload = payload || {};
    const scan = payload.ast ? scanAst(payload.ast) : {
      funcs: [], loops: 0, maxLoopDepth: 0, ifs: 0, calls: [], varTypes: {},
      hasPtr: false, hasStruct: false, hasFloat: false, hasArray: false, structs: [], returns: 0
    };
    const run = runToEnd(payload);
    const stats = payload.stats || {};
    const prog = payload.prog || { instrs: [] };

    const blocks = [];
    blocks.push({
      t: '一句话结论',
      type: 'lead',
      text: describePurpose(scan, run)
    });

    /* --- 它在做什么 --- */
    const steps = [];
    if (scan.funcs.length > 1) {
      steps.push('定义了 ' + scan.funcs.length + ' 个函数：' + scan.funcs.map(f => f.name + '()').join('、') +
        '，入口是 main()。');
    }
    if (scan.structs.length) {
      steps.push('先用 struct 描述了数据的形状（' + scan.structs.join('、') + '），把相关的几个字段打包在一起。');
    }
    const declNames = Object.keys(scan.varTypes);
    if (declNames.length) {
      const grouped = {};
      declNames.forEach(n => {
        const t = scan.varTypes[n];
        grouped[t] = (grouped[t] || 0) + 1;
      });
      steps.push('声明了 ' + declNames.length + ' 个局部变量（' +
        Object.keys(grouped).map(t => t + ' × ' + grouped[t]).join('、') + '），它们都放在栈帧里。');
    }
    if (scan.hasPtr) steps.push('用指针保存地址：& 取地址、* 解引用，函数之间靠地址共享同一块数据，而不是复制。');
    if (scan.hasFloat) steps.push('有小数参与运算，这部分走 SSE 指令和 xmm 寄存器（addsd / mulsd 等），和整数通路分开。');
    if (scan.loops) steps.push('共有 ' + scan.loops + ' 处循环' + (scan.maxLoopDepth > 1 ? '，最深层嵌套 ' + scan.maxLoopDepth + ' 层' : '') + '，用来反复处理数据。');
    if (scan.ifs) steps.push('有 ' + scan.ifs + ' 处条件判断，按比较结果选择执行路径（cmp + 条件跳转）。');
    if (scan.calls.length) steps.push('调用了：' + scan.calls.map(c => c + '()').join('、') + '。');
    if (steps.length) blocks.push({ t: '它在做什么', type: 'ol', items: steps });

    /* --- 数据结构与最终状态 --- */
    if (run && run.vars.length) {
      const rows = run.vars.slice(0, 12).map(v => {
        const t = scan.varTypes[v.name] || '';
        return [v.name + (t ? '（' + t + '）' : ''), fmtVal(v)];
      });
      blocks.push({ t: '跑完之后各变量的值', type: 'kv', items: rows });
    }

    /* --- 输出 --- */
    if (run) {
      blocks.push({
        t: '程序输出',
        type: 'code',
        text: run.output ? run.output.replace(/\n$/, '') : '（没有输出：程序没有调用 printf / puts / putchar）',
        note: '执行了 ' + run.steps + ' 条指令后' + (run.reason ? '，' + run.reason : '')
      });
    }

    /* --- 结构画像 --- */
    const instrCount = prog.instrs ? prog.instrs.length : 0;
    const cmp = {
      '指令条数': instrCount,
      '函数个数': scan.funcs.length || 1,
      '循环': scan.loops,
      '条件分支': scan.ifs,
      '函数调用': scan.calls.length,
      '栈帧大小': (stats.frame || 0) + ' 字节'
    };
    blocks.push({
      t: '结构画像',
      type: 'badges',
      items: Object.keys(cmp).map(k => ({ k: k, v: cmp[k] }))
    });

    /* --- 值得注意 --- */
    const notes = [];
    if (instrCount > 120) notes.push('指令已经超过 120 条，建议配合「逐行分析」按段阅读，先看函数序言和循环骨架。');
    if (scan.maxLoopDepth > 1) notes.push('有嵌套循环：外层每走一步，内层要完整跑一遍，总执行次数是相乘关系。');
    if (scan.hasFloat && scan.calls.indexOf('printf') >= 0) notes.push('printf 里的 %f 参数走的是 xmm 寄存器，不是 rsi/rdx，看汇编时不要找错地方。');
    if (scan.hasPtr) notes.push('指针修改的是"地址指向的内容"，函数调用结束后调用方的变量也会变——这是指针最容易出错的地方。');
    if (scan.hasStruct) notes.push('结构体成员在栈上是按偏移排列的（有对齐填充），所以 sizeof 往往大于各字段之和。');
    if (!scan.hasPtr && !scan.hasStruct) notes.push('这段代码只用了基本类型，适合先弄清栈帧与算术指令，再过渡到指针与结构体。');
    if (notes.length) blocks.push({ t: '值得注意', type: 'ul', items: notes });

    /* --- 追问建议 --- */
    blocks.push({
      t: '可以接着问',
      type: 'ul',
      items: [
        '这段代码里哪几行是"函数序言"和"函数尾声"？它们为什么必须成对出现？',
        scan.loops ? '循环条件在汇编里变成了哪一条 cmp + 跳转？' : '如果没有循环，这段代码的指令为什么是顺序执行的？',
        scan.hasFloat ? '浮点参数为什么用 xmm 而不是通用寄存器？' : '整数参数是怎么通过 rdi/rsi/rdx 传进函数的？'
      ]
    });

    return {
      ok: true,
      engine: 'local',
      headline: describePurpose(scan, run),
      blocks: blocks,
      scan: scan,
      run: run
    };
  }

  function fmtVal(v) {
    const n = v.value;
    if (n === null || n === undefined) return '—';
    if (Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return String(n);
    if (Math.abs(n) > 1e6) return '0x' + Number(BigInt.asUintN(32, BigInt(Math.trunc(n)))).toString(16);
    return String(n);
  }

  /* ============================================================
   * 3. 大模型接入（OpenAI 兼容接口）
   * ============================================================ */
  const CFG_KEY = 'asm.helper.ai.cfg';

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {})); } catch (e) { /* 忽略 */ }
  }

  function buildPrompt(payload, local) {
    const parts = [];
    parts.push('你是一位 x86-64 汇编与 C 语言的助教。请用中文分析下面这段代码，讲清"它在做什么"，并指出关键的汇编现象。');
    parts.push('输出要求：分 4 段 ——【整体作用】【执行流程】【关键指令或语法点】【容易踩的坑】。总字数控制在 500 字以内，不要复述代码。');
    if (payload.cSrc) parts.push('==== C 源码 ====\n' + payload.cSrc.slice(0, 4000));
    if (payload.asm) parts.push('==== 生成的 x86-64 汇编（Intel 语法）====\n' + payload.asm.slice(0, 6000));
    if (local) parts.push('==== 本地分析引擎的初步结论（可参考、可纠正）====\n' + local.headline);
    return parts.join('\n\n');
  }

  async function callLLM(cfg, prompt) {
    const url = (cfg.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (cfg.key || '')
      },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你是严谨的计算机系统课程助教，只讲事实，不说客套话。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('接口返回 ' + res.status + '：' + t.slice(0, 160));
    }
    const data = await res.json();
    const txt = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!txt) throw new Error('接口没有返回内容');
    return txt;
  }

  global.ASM_AI = {
    localAnalyze: localAnalyze,
    buildPrompt: buildPrompt,
    callLLM: callLLM,
    loadCfg: loadCfg,
    saveCfg: saveCfg,
    scanAst: scanAst
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ASM_AI;
})(typeof window !== 'undefined' ? window : globalThis);
