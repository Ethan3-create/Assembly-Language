/* ============================================================
 * 主应用：编辑器、自动补全、编译器联动、分析渲染、动画控制
 * ============================================================ */
(function () {
  'use strict';

  const D = window.ASM_DATA, VM = window.ASM_VM, C2 = window.C2ASM,
    DEC = window.ASM_DECOMP, AN = window.ASM_ANALYZE, MV = window.ASM_MEMVIEW;

  const $ = id => document.getElementById(id);

  const state = {
    mode: 'c2asm',
    cText: '',
    asmText: '',
    prog: null,
    machine: null,
    history: [],
    varMap: new Map(),
    dec: null,
    stats: null,
    currentLine: -1,
    tab: 'line',
    playing: null,
    errors: [],
    diag: null,          // 诊断结果 { issues, counts }
    varMapRaw: [],       // 编译器给的变量表（含 size / 所属函数）
    cErrorMsg: null,     // 最近一次 C 编译失败的信息
    runtimeError: null   // 最近一次运行期错误 { msg, line }
  };

  /* ============================================================
   * 1. 代码高亮
   * ============================================================ */
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const REG_RE = new RegExp('\\b(' + D.REG_NAMES.join('|') + '|rflags|eflags)\\b', 'g');

  function hlAsmLine(line) {
    let code = line, com = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === ';') { code = line.slice(0, i); com = line.slice(i); break; }
    }
    const colorize = seg => {
      let o = esc(seg);
      o = o.replace(/^(\s*)([A-Za-z_.$][\w.$]*)(:)/, (m, a, b, c) => a + '<span class="tk-lbl">' + b + '</span>' + c);
      o = o.replace(/(^|\s)(\.[A-Za-z_]\w*)/g, (m, a, b) => a + '<span class="tk-dir">' + b + '</span>');
      o = o.replace(/^(\s*)([a-z][a-z0-9]*)\b/, (m, a, b) => a + '<span class="tk-mn">' + b + '</span>');
      o = o.replace(/\b(byte|word|dword|qword)\s+ptr\b/gi, m => '<span class="tk-ptr">' + m.toUpperCase() + '</span>');
      o = o.replace(REG_RE, m => '<span class="tk-reg">' + m + '</span>');
      o = o.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, m => '<span class="tk-num">' + m + '</span>');
      return o;
    };
    const out = code.split(/("(?:[^"\\]|\\.)*")/).map((part, i) =>
      i % 2 ? '<span class="tk-str">' + esc(part) + '</span>' : colorize(part)).join('');
    return out + (com ? '<span class="tk-com">' + esc(com) + '</span>' : '');
  }

  const C_KEYWORDS = /\b(int|char|long|short|void|unsigned|signed|float|double|const|static|return|if|else|while|for|do|break|continue|struct|sizeof)\b/g;

  function hlCLine(line) {
    let code = line, com = '';
    let inQ = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === inQ) inQ = null; continue; }
      if (c === '"' || c === "'") { inQ = c; continue; }
      if (c === '/' && line[i + 1] === '/') { code = line.slice(0, i); com = line.slice(i); break; }
      if (c === '#') { code = ''; com = line; break; }
    }
    const colorize = seg => {
      let o = esc(seg);
      o = o.replace(C_KEYWORDS, m => '<span class="tk-kw">' + m + '</span>');
      o = o.replace(/\b([A-Za-z_]\w*)(\s*\()/g, (m, a, b) => '<span class="tk-fn">' + a + '</span>' + b);
      o = o.replace(/\b(\d+)\b/g, m => '<span class="tk-num">' + m + '</span>');
      return o;
    };
    const out = code.split(/("(?:[^"\\]|\\.)*")/).map((part, i) =>
      i % 2 ? '<span class="tk-str">' + esc(part) + '</span>' : colorize(part)).join('');
    return out + (com ? '<span class="tk-com">' + esc(com) + '</span>' : '');
  }

  /* ============================================================
   * 2. 简单编辑器（textarea + 高亮层 + 行号）
   * ============================================================ */
  function Editor(id, gutterId, activeId, lang) {
    this.ta = $(id);
    this.hl = $(id.replace('Input', 'Hl'));
    this.gutter = $(gutterId);
    this.active = $(activeId);
    this.lang = lang;
    this.onChange = null;
    this.onCaret = null;
    const self = this;
    this.ta.addEventListener('input', () => { self.refresh(); if (self.onChange) self.onChange(); });
    this.ta.addEventListener('scroll', () => self.syncScroll());
    this.ta.addEventListener('click', () => { if (self.onCaret) self.onCaret(); });
    this.ta.addEventListener('keyup', e => { if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) || true) { if (self.onCaret) self.onCaret(); } });
    // 输入法（中文/日文等）组合期间：让文字显示在 textarea 自己身上，
    // 否则透明文字 + 高亮层不刷新，用户看不到正在输入的内容
    this.ta.addEventListener('compositionstart', () => {
      self.ta.parentNode.classList.add('composing');
    });
    this.ta.addEventListener('compositionend', () => {
      self.ta.parentNode.classList.remove('composing');
      self.refresh();
      if (self.onChange) self.onChange();
    });
    this.ta.addEventListener('blur', () => self.ta.parentNode.classList.remove('composing'));
    this.ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        self.insert('    ');
      }
    });
  }
  Editor.prototype.insert = function (text) {
    const ta = this.ta;
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    this.refresh();
    if (this.onChange) this.onChange();
  };
  /* 一行的高度，必须与 CSS 里 .gutter/.hl/textarea 的 line-height 一致 */
  Editor.LINE_H = 20;
  Editor.PAD_TOP = 8;

  Editor.prototype.refresh = function () {
    const lines = this.ta.value.split('\n');
    const fn = this.lang === 'c' ? hlCLine : hlAsmLine;
    /* 空行必须塞一个零宽字符：否则 <pre> 末尾那个空行不生成行盒，
       高亮层的 scrollHeight 会比 textarea 少一行，滚到底时整块行号会错开一行 */
    this.hl.innerHTML = lines.map(l => {
      const o = fn(l);
      return o.length ? o : '\u200b';
    }).join('\n');
    this.gutter.innerHTML = '<div style="will-change:transform">' +
      lines.map((_, i) => '<div class="ln" data-n="' + (i + 1) + '">' + (i + 1) + '</div>').join('') + '</div>';
    if (this.applyMarks) this.applyMarks();
    this.syncScroll();
  };
  /* 出问题的行在行号上加颜色，方便一眼找到 */
  Editor.prototype.setMarks = function (errs, warns) {
    this.marksErr = new Set(errs || []);
    this.marksWarn = new Set(warns || []);
    this.applyMarks();
  };
  Editor.prototype.applyMarks = function () {
    const g = this.gutter && this.gutter.firstChild;
    if (!g) return;
    const e = this.marksErr || new Set(), w = this.marksWarn || new Set();
    Array.from(g.children).forEach(el => {
      const n = parseInt(el.dataset.n, 10);
      el.classList.toggle('err-line', e.has(n));
      el.classList.toggle('warn-line', !e.has(n) && w.has(n));
    });
  };
  Editor.prototype.syncScroll = function () {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    /* 行号跟着"代码层实际滚动到的位置"走，而不是 textarea 自己的 scrollTop：
       两者一旦被浏览器钳到不同值（比如内容高度差一行），就会整块错位 */
    const st = this.hl.scrollTop;
    if (this.gutter.firstChild) this.gutter.firstChild.style.transform = 'translateY(' + (-st) + 'px)';
    if (this.active.style.display !== 'none') {
      const ln = parseInt(this.active.dataset.line || '0', 10);
      this.active.style.top = (Editor.PAD_TOP + (ln - 1) * Editor.LINE_H - st) + 'px';
    }
    this.scrollTopNow = st;
  };
  Editor.prototype.setActiveLine = function (ln) {
    if (!ln || ln < 1) { this.active.style.display = 'none'; return; }
    this.active.dataset.line = ln;
    this.active.style.display = 'block';
    this.active.style.top = (Editor.PAD_TOP + (ln - 1) * Editor.LINE_H - (this.hl.scrollTop || 0)) + 'px';
    // 行号同步高亮
    Array.from(this.gutter.querySelectorAll('.ln')).forEach(el => {
      el.classList.toggle('cur', parseInt(el.dataset.n, 10) === ln);
    });
    // 滚动到视野内
    const top = (ln - 1) * 20;
    const view = this.ta.clientHeight - 20;
    if (top < this.ta.scrollTop || top > this.ta.scrollTop + view) {
      this.ta.scrollTop = Math.max(0, top - view * 0.45);
      this.syncScroll();
    }
  };
  Editor.prototype.caretLine = function () {
    const before = this.ta.value.slice(0, this.ta.selectionStart);
    return before.split('\n').length;
  };
  Editor.prototype.setValue = function (v) {
    this.ta.value = v;
    this.refresh();
  };

  const leftEd = new Editor('leftInput', 'leftGutter', 'leftActiveLine', 'c');
  const asmEd = new Editor('asmInput', 'asmGutter', 'asmActiveLine', 'asm');

  /* ============================================================
   * 3. 自动补全
   *    · 汇编框：在行末按回车后弹出，给出"整行具体写法"（不只是操作码）
   *    · C 框：只补 C 关键字 / 内置函数 / 已声明的名字，不掺汇编
   * ============================================================ */

  /* 每条指令的几种常用具体写法（补全里直接就是能用的整行） */
  const ASM_VARIANTS = {
    mov: ['mov eax, DWORD PTR [rbp-4]', 'mov DWORD PTR [rbp-4], eax', 'mov rax, 0'],
    movzx: ['movzx eax, BYTE PTR [rbp-1]', 'movzx eax, ax'],
    movsx: ['movsx eax, BYTE PTR [rbp-1]', 'movsx rax, eax'],
    movsxd: ['movsxd rax, eax'],
    lea: ['lea rax, [rbp-8]', 'lea rdi, [.LC0]', 'lea rax, [rbp-16]'],
    xchg: ['xchg eax, ecx'],
    push: ['push rbp', 'push rax'],
    pop: ['pop rbp', 'pop rax'],
    add: ['add eax, ecx', 'add DWORD PTR [rbp-4], eax', 'add rsp, 16'],
    sub: ['sub eax, ecx', 'sub rsp, 16'],
    inc: ['inc DWORD PTR [rbp-4]', 'inc eax'],
    dec: ['dec DWORD PTR [rbp-4]', 'dec eax'],
    imul: ['imul eax, ecx', 'imul eax, eax, 4'],
    idiv: ['idiv ecx'],
    div: ['div ecx'],
    cdq: ['cdq'], cqo: ['cqo'], cdqe: ['cdqe'], cltq: ['cltq'],
    neg: ['neg eax'],
    and: ['and eax, 0xff', 'and eax, ecx'],
    or: ['or eax, ecx'],
    xor: ['xor eax, eax', 'xor edx, edx'],
    not: ['not eax'],
    test: ['test eax, eax'],
    shl: ['shl eax, 1', 'shl eax, cl'],
    shr: ['shr eax, 1', 'shr eax, cl'],
    sar: ['sar eax, 1'],
    sal: ['sal eax, 1'],
    cmp: ['cmp eax, ecx', 'cmp DWORD PTR [rbp-4], 10', 'cmp eax, 0'],
    jmp: ['jmp .L2'],
    call: ['call printf'],
    ret: ['ret'],
    leave: ['leave'],
    nop: ['nop'],
    movsd: ['movsd xmm0, QWORD PTR [rbp-8]', 'movsd QWORD PTR [rbp-8], xmm0', 'movsd xmm0, QWORD PTR .LC0[rip]'],
    movss: ['movss xmm0, DWORD PTR [rbp-4]', 'movss DWORD PTR [rbp-4], xmm0'],
    addsd: ['addsd xmm0, xmm1', 'addsd xmm0, QWORD PTR [rbp-8]'],
    subsd: ['subsd xmm0, xmm1'],
    mulsd: ['mulsd xmm0, xmm1'],
    divsd: ['divsd xmm0, xmm1'],
    addss: ['addss xmm0, xmm1'], subss: ['subss xmm0, xmm1'],
    mulss: ['mulss xmm0, xmm1'], divss: ['divss xmm0, xmm1'],
    ucomisd: ['ucomisd xmm0, xmm1'],
    comisd: ['comisd xmm0, xmm1'],
    cvtsi2sd: ['cvtsi2sd xmm0, eax'],
    cvttsd2si: ['cvttsd2si eax, xmm0'],
    cvtsd2ss: ['cvtsd2ss xmm0, xmm1'],
    cvtss2sd: ['cvtss2sd xmm0, xmm1'],
    sqrtsd: ['sqrtsd xmm0, xmm1'],
    xorpd: ['xorpd xmm0, xmm0']
  };
  /* 按分类兜底生成写法 */
  function genericVariants(name) {
    const info = D.INSTR_MAP[name];
    const cat = info ? info.cat : 'misc';
    if (/^j/.test(name)) return [name + ' .L1', name + ' .L2'];
    if (/^set/.test(name)) return [name + ' al'];
    if (/^cmov/.test(name)) return [name + ' eax, ecx'];
    if (cat === 'fpu') return [name + ' xmm0, xmm1'];
    if (cat === 'arith' || cat === 'logic') return [name + ' eax, ecx', name + ' DWORD PTR [rbp-4], eax'];
    if (cat === 'shift') return [name + ' eax, 1'];
    if (cat === 'stack') return [name + ' rax'];
    return [name];
  }
  function asmVariants(name) {
    const out = [];
    if (D.INSTR_MAP[name] && D.INSTR_MAP[name].eg) out.push(D.INSTR_MAP[name].eg);
    (ASM_VARIANTS[name] || []).forEach(v => { if (out.indexOf(v) < 0) out.push(v); });
    genericVariants(name).forEach(v => { if (out.indexOf(v) < 0) out.push(v); });
    return out.slice(0, 3);
  }
  /* 新行默认先给的指令（按上手顺序排） */
  const COMMON_INS = ['mov', 'add', 'sub', 'cmp', 'lea', 'push', 'pop', 'call', 'jmp', 'je', 'imul', 'idiv', 'inc', 'xor', 'test', 'movsd', 'addsd', 'ret'];

  const C_WORDS = ['int', 'long', 'short', 'char', 'void', 'unsigned', 'float', 'double', 'const',
    'return', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'struct', 'sizeof', 'switch', 'case', 'default'];
  const C_BUILTINS = [
    { name: 'printf', cn: '格式化输出', insert: 'printf("%d\\n", x);' },
    { name: 'puts', cn: '输出一行字符串', insert: 'puts("hello");' },
    { name: 'putchar', cn: '输出一个字符', insert: 'putchar(c);' },
    { name: 'exit', cn: '立即结束程序', insert: 'exit(0);' }
  ];
  const C_SNIPPETS = [
    { name: 'for', cn: '循环', insert: 'for (int i = 0; i < n; i++) {\n    \n}' },
    { name: 'if', cn: '条件', insert: 'if () {\n    \n}' },
    { name: 'while', cn: '当型循环', insert: 'while () {\n    \n}' },
    { name: 'printf', cn: '格式化输出', insert: 'printf("%d\\n", );' }
  ];

  /* 汇编框：回车触发的整行补全 */
  function setupAsmAutocomplete(ed, boxId) {
    const box = $(boxId);
    let items = [], sel = 0, shown = false;

    function hide() { box.style.display = 'none'; shown = false; items = []; }

    function lineInfo() {
      const ta = ed.ta;
      const pos = ta.selectionStart;
      const start = ta.value.lastIndexOf('\n', pos - 1) + 1;
      const text = ta.value.slice(start, pos);
      const toEol = ta.value.indexOf('\n', pos);
      const atEnd = toEol === -1 || /^\s*$/.test(ta.value.slice(pos, toEol));
      return { text: text, start: start, pos: pos, atEnd: atEnd };
    }

    function build() {
      const li = lineInfo();
      const raw = li.text;
      const trimmed = raw.trim();
      const lead = raw.slice(0, raw.length - raw.trimStart().length);   // 行首缩进
      const list = [];

      // 首词（助记符）是否已经有操作数
      const m = trimmed.match(/^([a-z][a-z0-9]*)\b(.*)$/i);
      if (m && m[2].trim()) {
        // 已有操作数：补寄存器 / 内存写法 / 标签
        const tail = m[2];
        const wordM = tail.match(/([A-Za-z_][\w.]*)$/);
        const w = wordM ? wordM[1].toLowerCase() : '';
        const head = trimmed.slice(0, trimmed.length - (wordM ? wordM[1].length : 0));
        const add = (line, cn, desc) => list.push({ line: lead + line, cn: cn, desc: desc });
        const regs = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'rsp', 'rbp',
          'rax', 'rdi', 'rsi', 'al', 'cl', 'xmm0', 'xmm1'];
        regs.forEach(r => { if (!w || r.indexOf(w) === 0) add(head + r, '寄存器', '32/64 位通用寄存器'); });
        ['DWORD PTR [rbp-4]', 'QWORD PTR [rbp-8]', 'BYTE PTR [rbp-1]', 'DWORD PTR [rax]'].forEach(mm => {
          if (!w || mm.toLowerCase().indexOf(w) === 0) add(head + mm, '内存操作数', '按指定宽度读写内存');
        });
        if (state.prog) {
          state.prog.labels.forEach((v, k) => {
            if (!w || k.toLowerCase().indexOf(w) === 0) add(head + k, '标签', '代码中已定义的标号');
          });
        }
        return list.slice(0, 14);
      }

      // 空行或只打了助记符前缀：给出"整行写法"
      const pre = m ? m[1].toLowerCase() : '';
      const push = name => {
        const info = D.INSTR_MAP[name];
        if (!info) return;
        asmVariants(name).forEach((v, i) => {
          list.push({
            line: lead + v,
            cn: i === 0 ? info.cn : '',
            desc: i === 0 ? info.desc.slice(0, 44) : '',
            mn: name
          });
        });
      };
      if (!pre) {
        COMMON_INS.forEach(push);
      } else {
        D.INSTRS.forEach(i => { if (i.name.indexOf(pre) === 0) push(i.name); });
      }
      return list.slice(0, 40);
    }

    function render() {
      if (!items.length) { hide(); return; }
      box.innerHTML = items.map((it, i) =>
        '<div class="ac-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ac-line">' + esc(it.line.trim()) + '</span>' +
        '<span class="ac-cn">' + esc(it.cn || '') + '</span>' +
        '<span class="ac-desc">' + esc(it.desc || '') + '</span></div>').join('');
      box.style.display = 'block';
      shown = true;
      const ta = ed.ta, wrap = ta.parentElement;
      const c = caretCoords(ta);
      let left = wrap.offsetLeft + c.left - ta.scrollLeft;
      let top = wrap.offsetTop + c.top - ta.scrollTop + 22;
      left = Math.max(wrap.offsetLeft + 4, Math.min(left, wrap.offsetLeft + ta.clientWidth - 340));
      top = Math.min(top, ta.clientHeight - 40);
      box.style.left = left + 'px';
      box.style.top = Math.max(top, 24) + 'px';
      const selEl = box.querySelector('.ac-item.sel');
      if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    }

    function accept() {
      if (!items.length) return false;
      const it = items[sel];
      const li = lineInfo();
      const ta = ed.ta;
      ta.value = ta.value.slice(0, li.start) + it.line + ta.value.slice(li.pos);
      const caret = li.start + it.line.length;
      ta.selectionStart = ta.selectionEnd = caret;
      hide();
      ed.refresh();
      if (ed.onChange) ed.onChange();
      return true;
    }

    ed.ta.addEventListener('keydown', e => {
      if (shown && items.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return; }
        if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // 行末回车：先换行，再在新行弹出补全
        const li = lineInfo();
        if (li.atEnd) {
          e.preventDefault();
          const ta = ed.ta;
          const indent = (li.text.match(/^\s*/) || [''])[0];
          const ins = '\n' + indent;
          ta.value = ta.value.slice(0, li.pos) + ins + ta.value.slice(ta.selectionEnd);
          ta.selectionStart = ta.selectionEnd = li.pos + ins.length;
          ed.refresh();
          if (ed.onChange) ed.onChange();
          setTimeout(() => { items = build(); sel = 0; if (items.length) render(); else hide(); }, 0);
        }
        return;
      }
      if (e.key === ' ' && e.ctrlKey) {
        e.preventDefault();
        items = build(); sel = 0;
        if (items.length) render(); else hide();
      }
      if (e.key === 'Escape') hide();
    });
    // 继续打字时按当前行内容过滤
    ed.ta.addEventListener('input', () => {
      if (!shown) return;
      items = build(); sel = 0;
      if (items.length) render(); else hide();
    });
    ed.ta.addEventListener('blur', () => setTimeout(hide, 140));
    box.addEventListener('mousedown', e => {
      const it = e.target.closest('.ac-item');
      if (!it) return;
      e.preventDefault();
      sel = parseInt(it.dataset.i, 10);
      accept();
    });
    return { hide: hide };
  }

  /* C 框：只补 C 的东西 */
  function setupCAutocomplete(ed, boxId) {
    const box = $(boxId);
    let items = [], sel = 0, shown = false;
    function hide() { box.style.display = 'none'; shown = false; items = []; }
    function word() {
      const ta = ed.ta, pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const m = before.match(/[A-Za-z_]\w*$/);
      return { w: m ? m[0] : '', start: pos - (m ? m[0].length : 0), pos: pos };
    }
    function build() {
      const { w } = word();
      const lw = w.toLowerCase();
      const list = [];
      if (!w) {
        C_SNIPPETS.forEach(s => list.push({ line: s.insert, name: s.name, cn: s.cn }));
        return list;
      }
      C_WORDS.forEach(k => { if (k.indexOf(lw) === 0) list.push({ line: k, name: k, cn: '关键字' }); });
      C_BUILTINS.forEach(b => { if (b.name.indexOf(lw) === 0) list.push({ line: b.insert, name: b.name, cn: b.cn }); });
      // 已声明的变量名
      if (state.varMapByFunc && state.varMapByFunc.size) {
        const seen = new Set();
        state.varMapByFunc.forEach(e => e.names.forEach((n, off) => {
          if (n && n.toLowerCase().indexOf(lw) === 0 && !seen.has(n)) { seen.add(n); list.push({ line: n, name: n, cn: '变量' }); }
        }));
      }
      return list.slice(0, 16);
    }
    function render() {
      if (!items.length) { hide(); return; }
      box.innerHTML = items.map((it, i) =>
        '<div class="ac-item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ac-line">' + esc(it.name) + '</span>' +
        '<span class="ac-cn">' + esc(it.cn) + '</span></div>').join('');
      box.style.display = 'block';
      shown = true;
      const ta = ed.ta, wrap = ta.parentElement;
      const c = caretCoords(ta);
      box.style.left = Math.max(wrap.offsetLeft + 4, Math.min(wrap.offsetLeft + c.left - ta.scrollLeft, wrap.offsetLeft + ta.clientWidth - 300)) + 'px';
      box.style.top = Math.max(24, Math.min(wrap.offsetTop + c.top - ta.scrollTop + 22, ta.clientHeight - 40)) + 'px';
    }
    function accept() {
      if (!items.length) return false;
      const it = items[sel];
      const { w, start, pos } = word();
      const ta = ed.ta;
      ta.value = ta.value.slice(0, start) + it.line + ta.value.slice(pos);
      ta.selectionStart = ta.selectionEnd = start + it.line.length;
      hide();
      ed.refresh();
      if (ed.onChange) ed.onChange();
      return true;
    }
    ed.ta.addEventListener('keydown', e => {
      if (shown && items.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && shown)) { e.preventDefault(); accept(); return; }
        if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
      }
      if (e.key === ' ' && e.ctrlKey) {
        e.preventDefault();
        items = build(); sel = 0;
        if (items.length) render(); else hide();
        return;
      }
      /* 行末按回车：自动缩进，在"要写新语句"的位置顺手给几条常用写法 */
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        const ta = ed.ta, pos = ta.selectionStart, end = ta.selectionEnd;
        if (pos !== end) return;
        const nl = ta.value.indexOf('\n', pos);
        if (!(nl === -1 || /^\s*$/.test(ta.value.slice(pos, nl)))) return;
        const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
        const lineText = ta.value.slice(lineStart, pos);
        const indent = (lineText.match(/^\s*/) || [''])[0];
        const extra = /\{\s*$/.test(lineText) ? '    ' : '';
        e.preventDefault();
        const ins = '\n' + indent + extra;
        ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = pos + ins.length;
        ed.refresh();
        if (ed.onChange) ed.onChange();
        if (/\{\s*$/.test(lineText) || !lineText.trim()) {
          setTimeout(() => { items = build(); sel = 0; if (items.length) render(); else hide(); }, 0);
        }
      }
    });
    ed.ta.addEventListener('input', () => {
      if (!shown) return;
      items = build(); sel = 0;
      if (items.length) render(); else hide();
    });
    ed.ta.addEventListener('blur', () => setTimeout(hide, 140));
    box.addEventListener('mousedown', e => {
      const it = e.target.closest('.ac-item');
      if (!it) return;
      e.preventDefault();
      sel = parseInt(it.dataset.i, 10);
      accept();
    });
    return { hide: hide };
  }

  function caretCoords(ta) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:0;left:0;';
    ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'borderWidth'].forEach(p => { div.style[p] = cs[p]; });
    div.style.width = ta.clientWidth + 'px';
    const before = ta.value.slice(0, ta.selectionStart);
    div.textContent = before;
    const span = document.createElement('span');
    span.textContent = ta.value.slice(ta.selectionStart, ta.selectionStart + 1) || '.';
    div.appendChild(span);
    document.body.appendChild(div);
    const left = span.offsetLeft, top = span.offsetTop;
    document.body.removeChild(div);
    return { left, top };
  }

  /* ============================================================
   * 4. 编译 / 装载
   * ============================================================ */
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast'; }, isErr ? 4200 : 2200);
  }

  // 从编译器生成的注释（; int sum = ...;）里恢复 [rbp-N] 对应的变量名
  function deriveVarMap(prog, fallback) {
    const map = new Map();
    prog.instrs.forEach(ins => {
      const m = (ins.comment || '').match(/^\s*int\s+([A-Za-z_]\w*)/);
      if (!m) return;
      ins.ops.forEach(op => {
        if (op.kind === 'mem' && op.base === 'rbp' && (op.disp || 0) < 0) map.set(-op.disp, m[1]);
      });
    });
    if (!map.size && fallback) fallback.forEach((v, k) => map.set(k, v));
    return map;
  }

  async function compileC(silent) {
    const src = leftEd.ta.value;
    state.cText = src;
    // 页面由后端托管时用服务端编译；拿不到就退回浏览器本地编译（功能完全一致）
    let r = null;
    if (typeof API !== 'undefined' && API.online()) {
      try { r = await API.compile(src); } catch (e) { r = null; }
    }
    if (!r) r = C2.compile(src);
    if (!r.ok) {
      state.cErrorMsg = r.error;
      $('asmBadge').textContent = '编译失败';
      $('asmBadge').className = 'badge err';
      if (!silent) toast('C 编译失败：' + r.error, true);
      showErrors(['C 编译错误：' + r.error]);
      runDiagnose();
      return false;
    }
    state.cErrorMsg = null;
    state.runtimeError = null;
    state.varMapRaw = r.varMap || [];
    state.varMap = new Map();
    (r.varMap || []).forEach(v => state.varMap.set(v.offset, v.name));
    state.varTypes = new Map();
    (r.varMap || []).forEach(v => state.varTypes.set(v.offset, v.type));
    // 每个函数的栈偏移会重叠，所以按函数再分一份
    state.varMapByFunc = new Map();
    (r.varMap || []).forEach(v => {
      if (!state.varMapByFunc.has(v.func)) state.varMapByFunc.set(v.func, { names: new Map(), types: new Map(), sizes: new Map() });
      const e = state.varMapByFunc.get(v.func);
      e.names.set(v.offset, v.name); e.types.set(v.offset, v.type); e.sizes.set(v.offset, v.size);
    });
    state.ast = r.ast;
    state.fromC = true;
    asmEd.setValue(r.asm);
    state.asmText = r.asm;
    loadAsm(true);
    return true;
  }

  function loadAsm(silent) {
    const text = asmEd.ta.value;
    state.asmText = text;
    const prog = VM.assemble(text);
    state.prog = prog;
    state.errors = prog.errors;
    state.varMap = deriveVarMap(prog, state.fromC ? state.varMap : null);
    state.machine = new VM.Machine(prog);
    state.history = [];
    state.currentLine = -1;
    state.explainCtx = null;
    asmEd.setActiveLine(0);

    const badge = $('asmBadge');
    if (prog.errors.length) {
      badge.textContent = prog.errors.length + ' 处问题';
      badge.className = 'badge err';
    } else {
      badge.textContent = prog.instrs.length + ' 条指令';
      badge.className = 'badge ok';
    }

    // 反编译
    try {
      state.dec = DEC.decompile(prog, {
        varMap: state.varMap,
        varMapByFunc: state.fromC ? state.varMapByFunc : null
      });
    } catch (e) {
      state.dec = { ok: false, code: '/* 反编译失败：' + e.message + ' */', tree: [], vars: [], events: [] };
    }
    if (state.mode === 'asm2c') {
      leftEd.setValue(state.dec.code);
    }

    // 总体分析
    try {
      state.stats = AN.analyzeProgram(prog, { dec: state.dec, varMap: state.varMap, prog: prog });
    } catch (e) {
      state.stats = null;
    }

    // 首次加载时自动选中第一条指令，避免右侧空白
    if (state.currentLine < 0 && prog.instrs.length) {
      state.currentLine = prog.instrs[0].lineNo;
      asmEd.setActiveLine(state.currentLine);
    }
    if (state.tab === 'summary') renderSummary();
    renderLinePanel();
    renderStage(null);
    updateStepUI();
    renderAI();

    runDiagnose();

    if (prog.errors.length && !silent) {
      showErrors(prog.errors);
      toast('汇编中有 ' + prog.errors.length + ' 处无法解析，已尽量分析', true);
    }
  }

  function errorsHTML(errs) {
    return '<div class="card"><div class="card-title">解析问题（' + errs.length + '）</div>' +
      errs.slice(0, 12).map(e => '<div class="warn-item">' + esc(e) + '</div>').join('') +
      (errs.length > 12 ? '<div class="empty">还有 ' + (errs.length - 12) + ' 条…</div>' : '') +
      '<div class="empty">修正后会自动重新分析。常见问题：指令拼写、操作数个数、标签漏写冒号、缺少 ret。</div></div>';
  }

  function showErrors(errs) {
    if (state.tab !== 'line') switchTab('line');
    $('panelLine').innerHTML = errorsHTML(errs);
  }

  /* ============================================================
   * 4.5 代码检查（错误 / 警告 / 提示）
   * ============================================================ */
  function runDiagnose() {
    let res;
    try {
      res = DIAG.check(state.cErrorMsg ? null : state.prog, {
        srcText: state.asmText,
        varMapRaw: state.varMapRaw,
        cError: state.cErrorMsg,
        runtimeError: state.runtimeError
      });
    } catch (e) {
      res = { issues: [], counts: { error: 0, warn: 0, info: 0 } };
    }
    state.diag = res;

    // 行号上色：C 编译错误定位在左边 C 框，其余定位在汇编框
    const asmErr = [], asmWarn = [], cErr = [], cWarn = [];
    res.issues.forEach(i => {
      if (!i.line) return;
      const tgt = i.src === 'c' ? null : 'asm';
      if (tgt === 'asm') {
        if (i.level === 'error') asmErr.push(i.line);
        else if (i.level === 'warn') asmWarn.push(i.line);
      } else {
        if (i.level === 'error') cErr.push(i.line);
        else if (i.level === 'warn') cWarn.push(i.line);
      }
    });
    asmEd.setMarks(asmErr, asmWarn);
    leftEd.setMarks(cErr, cWarn);

    renderDiag();
    updateDiagBadge();
  }

  function updateDiagBadge() {
    const c = state.diag ? state.diag.counts : { error: 0, warn: 0, info: 0 };
    const total = c.error + c.warn + c.info;
    const el = $('diagCount');
    if (!el) return;
    el.textContent = total;
    el.className = 'tab-count' +
      (c.error ? ' has-err' : c.warn ? ' has-warn' : total ? '' : ' zero');
    const tab = $('tabDiag');
    if (tab) {
      tab.style.color = c.error ? '#b91c1c' : '';
      tab.title = c.error ? c.error + ' 个错误' : (c.warn ? c.warn + ' 个警告' : '没有发现问题');
    }
  }

  function renderDiag() {
    const box = $('panelDiag');
    if (!box) return;
    const d = state.diag || { issues: [], counts: { error: 0, warn: 0, info: 0 } };
    const c = d.counts;
    const total = c.error + c.warn + c.info;
    const nIns = state.prog ? state.prog.instrs.length : 0;

    let html = '<div class="diag-bar">' +
      '<span class="diag-pill e">错误 ' + c.error + '</span>' +
      '<span class="diag-pill w">警告 ' + c.warn + '</span>' +
      '<span class="diag-pill i">提示 ' + c.info + '</span>' +
      '<span class="grow"></span>' +
      '<span>已检查 ' + nIns + ' 条指令</span></div>';

    if (!total) {
      html += '<div class="card soft"><div class="card-title">检查结果</div>' +
        '<div class="empty"><b>没有发现问题。</b>' +
        '语法、操作数宽度、栈平衡、调用约定都通过了检查。<br>' +
        '想验证效果？把某个 <code>mov</code> 改成 <code>movv</code>，或把 <code>add eax, ecx</code> 改成 ' +
        '<code>add eax, rcx</code>，再回来看这里。</div></div>';
      box.innerHTML = html;
      return;
    }

    html += d.issues.map((i, idx) => {
      const lv = i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : 'info';
      const lvCn = i.level === 'error' ? '错误' : i.level === 'warn' ? '警告' : '提示';
      const where = i.line ? '第 ' + i.line + ' 行' + (i.src === 'c' ? '（C 源码）' : '') : '整体';
      return '<div class="diag-item ' + lv + '" data-i="' + idx + '" data-line="' + (i.line || 0) + '" data-src="' + (i.src || 'asm') + '">' +
        '<div class="diag-top"><span class="diag-lv">' + lvCn + '</span>' +
        '<span class="diag-where">' + where + '</span>' +
        (i.code ? '<span class="diag-code">' + esc(i.code) + '</span>' : '') + '</div>' +
        '<div class="diag-msg">' + esc(i.msg) + '</div>' +
        (i.fix ? '<div class="diag-fix"><b>怎么改：</b>' + esc(i.fix) + '</div>' : '') +
        '</div>';
    }).join('');

    box.innerHTML = html;
    Array.from(box.querySelectorAll('.diag-item')).forEach(el => {
      el.addEventListener('click', () => {
        const ln = parseInt(el.dataset.line, 10) || 0;
        if (!ln) return;
        jumpToLine(el.dataset.src === 'c' ? leftEd : asmEd, ln);
      });
    });
  }

  /* 把光标移到指定行，并滚动到视野内 */
  function jumpToLine(ed, ln) {
    const lines = ed.ta.value.split('\n');
    if (ln < 1 || ln > lines.length) { ln = Math.max(1, Math.min(ln, lines.length)); }
    let pos = 0;
    for (let i = 0; i < ln - 1; i++) pos += lines[i].length + 1;
    ed.ta.focus();
    ed.ta.selectionStart = ed.ta.selectionEnd = pos;
    ed.setActiveLine(ln);
    ed.syncScroll();
  }

  /* ============================================================
   * 5. 执行控制
   * ============================================================ */
  function freshMachine() {
    return new VM.Machine(state.prog);
  }

  function seekToIndex(idx) {
    const m = freshMachine();
    const hist = [];
    let guard = 0;
    while (!m.halted && m.ip !== idx && guard++ < 200000) {
      hist.push(m.ip);
      m.step();
    }
    state.machine = m;
    state.history = hist;
  }

  function replay(nSteps) {
    const m = freshMachine();
    const hist = [];
    for (let i = 0; i < nSteps && !m.halted; i++) {
      hist.push(m.ip);
      m.step();
    }
    state.machine = m;
    state.history = hist;
  }

  function stepOnce(animate) {
    const m = state.machine;
    if (!m || m.halted) return false;
    const pre = m.clone();
    state.history.push(m.ip);
    const st = m.step();
    if (m.errorMsg) {
      toast(m.errorMsg, true);
      const cur = state.prog.instrs[state.history[state.history.length - 1]] || null;
      state.runtimeError = { msg: m.errorMsg, line: cur ? cur.lineNo : 0 };
      runDiagnose();
    }
    const ins = state.prog.instrs[state.history[state.history.length - 1]];
    if (ins) {
      state.currentLine = ins.lineNo;
      asmEd.setActiveLine(ins.lineNo);
      state.explainCtx = { line: ins.lineNo, m: pre, step: st };
    }
    updateStepUI();
    try {
      if (ins) renderLinePanel();
      renderStage(st);
    } catch (err) {
      console.error(err);
    }
    return !m.halted;
  }

  function stepBack() {
    if (!state.history.length) return;
    stopPlay();
    const n = state.history.length - 1;
    const targetIp = state.history[n];
    replay(n);
    const ins = state.prog.instrs[targetIp];
    if (ins) { state.currentLine = ins.lineNo; asmEd.setActiveLine(ins.lineNo); renderLinePanel(); }
    renderStage(null);
    updateStepUI();
  }

  function updateStepUI() {
    const m = state.machine;
    $('stepCount').textContent = m ? m.steps + ' 步' : '0 步';
    if (state.playing) $('btnPlay').textContent = '⏸ 暂停';
    $('btnPrev').disabled = !state.history.length;
    $('btnStep').disabled = !m || m.halted;
    $('btnPlay').disabled = !m || m.halted;
    $('console').textContent = (m && m.output) ? m.output : '（还没有输出）';
    $('haltInfo').textContent = m && m.halted ? '· ' + (m.errorMsg || m.haltReason || '已结束') : '';
  }

  function stopPlay() {
    if (state.playing) { clearInterval(state.playing); state.playing = null; $('btnPlay').textContent = '▶ 连续执行'; }
  }
  function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    if (!state.machine || state.machine.halted) return;
    $('btnPlay').textContent = '⏸ 暂停';
    const speed = parseInt($('speed').value, 10);
    state.playing = setInterval(() => {
      const go = stepOnce(true);
      if (!go) { stopPlay(); toast('程序执行结束'); }
    }, Math.max(60, 1000 - speed));
  }

  /* 心跳：告诉后端"页面还开着"。页面关掉后后端最多等 90 秒就退出，
     不会在任务管理器里留一个删不掉的进程。 */
  function startKeepAlive() {
    if (typeof API === 'undefined' || !API.online()) return;
    API.ping();
    setInterval(() => API.ping(), 15000);
    // 关窗时通知后端退出。刷新也会走到这里，所以后端收到后会等 3 秒，
    // 期间新页面发来 ping 就撤销 —— 刷新不会把服务弄没。
    window.addEventListener('pagehide', () => API.bye());
  }

  /* 探测后端：决定"服务端/本地"徽标 */
  async function probeEngine() {
    const b = $('engineBadge');
    if (!b) return;
    if (typeof API === 'undefined' || !API.online()) {
      b.textContent = '本地';
      b.className = 'badge';
      b.title = '离线模式：编译在浏览器里完成（功能与服务端完全一致）';
      return;
    }
    const h = await API.health();
    if (h && h.ok) {
      b.textContent = '服务端';
      b.className = 'badge ok';
      b.title = '编译由内置后端完成（' + h.runtime + ' / Node ' + h.node + '，' + h.instructions + ' 条指令）';
    } else {
      b.textContent = '本地';
      b.className = 'badge';
      b.title = '后端没响应，已自动退回浏览器本地编译';
    }
  }

  function resetAll() {
    stopPlay();
    state.explainCtx = null;
    state.machine = freshMachine();
    state.history = [];
    state.currentLine = -1;
    asmEd.setActiveLine(0);
    renderLinePanel();
    renderStage(null);
    updateStepUI();
  }

  /* ============================================================
   * 6. 点击汇编行
   * ============================================================ */
  function selectLine(lineNo) {
    stopPlay();
    state.explainCtx = null;
    state.currentLine = lineNo;
    asmEd.setActiveLine(lineNo);
    const m = state.prog;
    const idx = state.machine ? state.machine.instrIndexForLine(lineNo) : -1;
    if (idx >= 0) seekToIndex(idx);
    else { state.machine = freshMachine(); state.history = []; }
    renderLinePanel();
    renderStage(null);
    updateStepUI();
    switchTab('line');
  }

  asmEd.gutter.addEventListener('click', e => {
    const lnEl = e.target.closest('.ln');
    if (!lnEl || !state.prog) return;
    selectLine(parseInt(lnEl.dataset.n, 10));
  });
  asmEd.gutter.style.cursor = 'pointer';

  asmEd.ta.addEventListener('click', () => {
    const ln = asmEd.caretLine();
    if (ln === state.currentLine) return;
    if (!state.prog || !state.prog.instrs.length) return;
    selectLine(ln);
  });
  asmEd.ta.addEventListener('keyup', e => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) {
      const ln = asmEd.caretLine();
      if (ln !== state.currentLine) selectLine(ln);
    }
  });

  /* ============================================================
   * 7. 逐行分析面板
   * ============================================================ */
  function instrAtLine(lineNo) {
    if (!state.prog) return null;
    return state.prog.instrs.find(i => i.lineNo === lineNo) || null;
  }

  function renderLinePanel() {
    const box = $('panelLine');
    if (state.tab !== 'line') return;

    if (!state.prog || !state.prog.instrs.length) {
      box.innerHTML = '<div class="empty">中间还没有可分析的汇编。<br>可以点上方「载入示例」，或自己在中间输入指令，例如：<br><br>' +
        '<code>mov eax, 10</code><br><code>add eax, 5</code></div>';
      return;
    }
    if (state.errors.length) { box.innerHTML = errorsHTML(state.errors); return; }

    const ln = state.currentLine;
    let ins = instrAtLine(ln);
    let fallbackNote = '';
    if (!ins && ln > 0) {
      ins = state.prog.instrs.find(i => i.lineNo >= ln) || null;
      if (ins) fallbackNote = '（第 ' + ln + ' 行是标签/空行，下面显示其后的第一条指令：第 ' + ins.lineNo + ' 行）';
    }
    if (!ins) {
      box.innerHTML = '<div class="empty"><b>点左侧汇编的任意一行</b>，这里会显示这一行在做什么。<br>' +
        '当前行（第 ' + (ln > 0 ? ln : '—') + ' 行）不是一条指令（可能是空行、标签或注释）。<br><br>' +
        '提示：<br>· 点行号或代码行都可以定位<br>· 底部「单步」可以一条条执行，箭头会画出数据流向</div>';
      return;
    }

    const m = state.machine;
    const atThisLine = m && state.prog.instrs[m.ip] === ins;
    const ec = state.explainCtx && state.explainCtx.line === ins.lineNo ? state.explainCtx : null;
    const srcM = ec ? ec.m : (atThisLine ? m : null);
    const ctx = { prog: state.prog, varMap: state.varMap };
    const info = AN.explainLine(ins, srcM, ctx);

    // 执行效果：优先用真实执行记录，否则"预演"一步
    let delta = [];
    const computeDelta = (pre, st) => {
      if (!st || !pre) return [];
      return st.writes.map(w => {
        let before = null;
        if (w.kind === 'reg') before = pre.readReg(w.name);
        else if (w.kind === 'mem') before = pre.readMem(w.addr, w.size);
        return { name: w.text || w.name, before, after: (w.kind === 'reg' ? pre.readReg(w.name) : w.value) };
      });
    };
    if (ec && ec.step) {
      delta = ec.step.writes.map(w => {
        let before = null;
        if (w.kind === 'reg') before = ec.m.readReg(w.name);
        else if (w.kind === 'mem') before = ec.m.readMem(w.addr, w.size);
        return { name: w.text || w.name, before, after: ec.m.constructor === Object ? w.value : w.value };
      });
    } else if (atThisLine && m && !m.halted) {
      const c = m.clone();
      const st = c.step();
      delta = computeDelta(m, st);
    }

    const catColor = info.cat ? info.cat.color : '#64748b';
    let html = '';
    html += '<div class="card">';
    html += '<div class="line-head">' +
      '<span class="chip cat" style="background:' + catColor + '">' + (info.cat ? info.cat.name : '指令') + '</span>' +
      '<span class="chip" style="background:#f1f5f9;color:#475569">' + info.cn + '</span>' +
      '<span class="chip addr">0x' + ins.addr.toString(16) + '</span>' +
      '<span class="chip addr">第 ' + ins.lineNo + ' 行</span>' +
      (ec ? '<span class="chip" style="background:#fef3c7;color:#b45309">刚刚执行</span>'
        : atThisLine ? '<span class="chip" style="background:#dcfce7;color:#15803d">执行到这里</span>'
          : '<span class="chip" style="background:#f1f5f9;color:#94a3b8">尚未执行到</span>') +
      '</div>';
    if (fallbackNote) html += '<div class="empty" style="padding:0 0 6px">' + fallbackNote + '</div>';
    html += '<div class="code-line">' + esc(ins.text.trim()) + '</div>';
    html += '<div class="hl-box">' + esc(info.headline) + '</div>';
    html += '<div class="detail-text">' + esc(info.detail) + '</div>';

    if (delta.length) {
      html += '<div class="delta-list">' + delta.map(d =>
        '<div class="delta-row"><span class="name">' + esc(d.name) + '</span>' +
        '<span class="old">' + (d.before === null ? '—' : d.before) + '</span>' +
        '<span class="arrow">→</span><span class="new">' + d.after + '</span></div>').join('') + '</div>';
    }
    html += '</div>';

    // 操作数细节
    const opsHtml = [];
    ins.ops.forEach((op, i) => {
      const d = AN.describeOperand(op, srcM, ctx);
      opsHtml.push('<div class="kv"><span class="k">' + (i === 0 ? '目标' : '源') + '</span><span class="v">' + esc(d.detail) + '</span></div>');
    });
    if (opsHtml.length) html += '<div class="card soft"><div class="card-title">操作数</div>' + opsHtml.join('') + '</div>';

    // 标志位 + 对应 C
    const meta = [];
    meta.push('<div class="kv"><span class="k">标志位</span><span class="v">' + esc(info.flags) + '</span></div>');
    if (info.src) meta.push('<div class="kv"><span class="k">对应 C</span><span class="v" style="font-family:var(--mono)">' + esc(info.src) + '</span></div>');
    if (srcM) {
      meta.push('<div class="kv"><span class="k">当前标志</span><span class="v" style="font-family:var(--mono)">ZF=' + srcM.flags.ZF + '  SF=' + srcM.flags.SF + '  CF=' + srcM.flags.CF + '  OF=' + srcM.flags.OF + '</span></div>');
    }
    html += '<div class="card soft"><div class="card-title">执行信息</div>' + meta.join('') + '</div>';

    if (info.tip) html += '<div class="tip-box"><b>提示：</b>' + esc(info.tip) + '</div>';

    box.innerHTML = html;
    box.scrollTop = 0;
  }

  /* ============================================================
   * 8. 总体分析面板
   * ============================================================ */
  function renderSummary() {
    const box = $('panelSummary');
    const s = state.stats;
    if (!s || !state.prog || !state.prog.instrs.length) {
      box.innerHTML = '<div class="empty">没有可分析的代码。</div>';
      return;
    }
    let html = '';
    html += '<div class="summary-line">' + esc(s.summary.oneLine) + '</div>';

    html += '<div class="card"><div class="card-title">关键要点</div><ul class="bullets">' +
      s.summary.bullets.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul></div>';

    if (s.tips.length) {
      html += '<div class="card"><div class="card-title">需要注意</div>' +
        s.tips.map(t => '<div class="warn-item">' + esc(t) + '</div>').join('') + '</div>';
    }

    html += '<div class="card"><div class="card-title">结构分解</div><div class="phase-list">' +
      s.phases.map(p => '<div class="phase"><span class="pname">' + esc(p.name) + '</span>' +
        '<span class="plines">' + p.from + '-' + p.to + '</span>' +
        '<span class="pdesc">' + esc(p.desc) + '</span></div>').join('') + '</div></div>';

    html += '<div class="card"><div class="card-title">指令分布</div>' +
      s.cats.map(c => '<div class="bar-row"><span class="bname">' + esc(c.name) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + c.pct + '%;background:' + c.color + '"></span></span>' +
        '<span class="bnum">' + c.count + ' · ' + c.pct + '%</span></div>').join('') + '</div>';

    if (s.frameSlots.length) {
      html += '<div class="card"><div class="card-title">栈帧布局（rbp 为基准）</div><table class="frame-table">' +
        s.frameSlots.map(f => '<tr><td>' + esc(f.label) + '</td><td>' + esc(f.desc) + '</td><td>' + f.size + ' 字节</td></tr>').join('') +
        '</table></div>';
    }

    const kv = [];
    kv.push(['指令总数', s.total + ' 条']);
    kv.push(['局部空间', s.frame ? s.frame + ' 字节' : '未开辟']);
    kv.push(['循环', s.loops + ' 处']);
    kv.push(['条件跳转', s.condJumps + ' 条']);
    kv.push(['函数调用', s.calls.length ? s.calls.join('、') : '无']);
    kv.push(['栈平衡', s.pushCount === s.popCount ? 'push ' + s.pushCount + ' / pop ' + s.popCount + '（平衡）' : 'push ' + s.pushCount + ' / pop ' + s.popCount + '（不平衡）']);
    kv.push(['用到的寄存器', s.regsUsed.length ? s.regsUsed.join(' ') : '无']);
    html += '<div class="card soft"><div class="card-title">统计</div>' +
      kv.map(x => '<div class="kv"><span class="k">' + x[0] + '</span><span class="v">' + esc(x[1]) + '</span></div>').join('') + '</div>';

    if (s.strings.length) {
      html += '<div class="card soft"><div class="card-title">字符串常量</div>' +
        s.strings.map(x => '<div class="kv"><span class="k" style="font-family:var(--mono);font-size:10.5px">0x' + x.addr.toString(16) + '</span><span class="v" style="font-family:var(--mono)">"' + esc(x.text.replace(/\n/g, '\\n')) + '"</span></div>').join('') +
        '</div>';
    }

    box.innerHTML = html;
    box.scrollTop = 0;
  }

  /* ============================================================
   * 9. 指令速查
   * ============================================================ */
  function renderDoc(filter) {
    const box = $('docList');
    const f = (filter || '').trim().toLowerCase();
    const list = D.INSTRS.filter(i => !f || i.name.indexOf(f) >= 0 || i.cn.indexOf(f) >= 0 || i.desc.indexOf(f) >= 0);
    if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的指令。</div>'; return; }
    box.innerHTML = list.map(i =>
      '<div class="doc-item"><span class="dname">' + i.name + '</span>' +
      '<span class="dcn">' + i.cn + '</span>' +
      '<div class="ddsc">' + esc(i.desc) + '</div>' +
      '<div class="dmeta">' + esc(i.forms[0] || '') + '   |   ' + esc(i.flags) + '</div></div>').join('');
  }

  /* ============================================================
   * 10. 舞台渲染
   * ============================================================ */
  function renderStage(step) {
    const svg = $('memSvg');
    const m = state.machine;
    let caption = '';
    if (step && step.instr) {
      caption = step.instr.text.trim();
    } else if (state.currentLine > 0) {
      const ins = instrAtLine(state.currentLine);
      if (ins) caption = '即将执行：' + ins.text.trim();
    } else if (m && m.halted) {
      caption = '程序已结束';
    } else {
      caption = '点「单步」开始，橙色箭头是这行指令的数据流向';
    }
    $('stageCaption').textContent = caption;
    MV.render(svg, {
      m, prog: state.prog, varMap: state.varMap, step,
      regsUsed: state.stats ? state.stats.regsUsed : [],
      caption: '',
      showFlow: !!step
    });
  }

  /* ============================================================
   * 11. 模式 / 示例 / 标签
   * ============================================================ */
  function switchTab(name) {
    state.tab = name;
    Array.from(document.querySelectorAll('#analysisTabs .tab')).forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $('panelLine').classList.toggle('hidden', name !== 'line');
    $('panelSummary').classList.toggle('hidden', name !== 'summary');
    $('panelDoc').classList.toggle('hidden', name !== 'doc');
    $('panelDiag').classList.toggle('hidden', name !== 'diag');
    if (name === 'line') renderLinePanel();
    if (name === 'summary') renderSummary();
    if (name === 'doc') renderDoc($('docSearch').value);
    if (name === 'diag') renderDiag();
  }

  function setMode(mode) {
    state.mode = mode;
    Array.from(document.querySelectorAll('.mode-btn')).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode === 'c2asm') {
      $('leftTitle').textContent = 'C 源代码';
      $('leftHint').textContent = '支持指针 / 结构体 / 浮点数 / 自定义函数';
      leftEd.lang = 'c';
      leftEd.ta.readOnly = false;
      leftEd.ta.style.caretColor = '#111827';
      leftEd.setValue(state.cText || '');
      $('btnCompile').textContent = '编译并加载';
      $('leftFoot').innerHTML = '<span class="kbd-hint">Tab 缩进</span><span class="kbd-hint">Ctrl + Enter 编译</span>';
      acLeft.hide();
    } else {
      state.ast = null;
      state.cErrorMsg = null;
      state.varMapRaw = [];
      state.runtimeError = null;
      $('leftTitle').textContent = '反编译结果（伪 C）';
      $('leftHint').textContent = '由中间汇编自动还原，仅供对照';
      leftEd.lang = 'c';
      leftEd.ta.readOnly = true;
      leftEd.ta.style.caretColor = 'transparent';
      leftEd.setValue(state.dec ? state.dec.code : '');
      $('btnCompile').textContent = '重新分析';
      $('leftFoot').innerHTML = '<span class="kbd-hint">左边为自动还原，可能与原 C 不同</span>';
      acLeft.hide();
    }
  }

  function loadExampleSelect() {
    const sel = $('exampleSelect');
    const g1 = document.createElement('optgroup'); g1.label = 'C 语言示例';
    D.EXAMPLES_C.forEach((e, i) => {
      const o = document.createElement('option');
      o.value = 'c' + i; o.textContent = e.name + ' — ' + e.desc;
      g1.appendChild(o);
    });
    const g2 = document.createElement('optgroup'); g2.label = '汇编示例';
    D.EXAMPLES_ASM.forEach((e, i) => {
      const o = document.createElement('option');
      o.value = 'a' + i; o.textContent = e.name + ' — ' + e.desc;
      g2.appendChild(o);
    });
    sel.appendChild(g1); sel.appendChild(g2);
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (!v) return;
      const kind = v[0], idx = parseInt(v.slice(1), 10);
      if (kind === 'c') {
        setMode('c2asm');
        state.cText = D.EXAMPLES_C[idx].code;
        leftEd.setValue(state.cText);
        compileC();
      } else {
        setMode('asm2c');
        state.fromC = false;
        state.varMap = new Map();
        asmEd.setValue(D.EXAMPLES_ASM[idx].code);
        loadAsm(true);
        toast('已载入汇编示例，点任意一行看它做什么');
      }
      sel.value = '';
    });
  }

  /* ============================================================
   * 12. 事件绑定
   * ============================================================ */
  const acLeft = setupCAutocomplete(leftEd, 'acBox');
  const acAsm = setupAsmAutocomplete(asmEd, 'acBoxAsm');

  document.querySelectorAll('.mode-btn').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  document.querySelectorAll('#analysisTabs .tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  $('btnCompile').addEventListener('click', () => {
    if (state.mode === 'c2asm') {
      compileC().then(ok => {
        if (ok) toast('已生成汇编并加载，共 ' + state.prog.instrs.length + ' 条指令');
      });
    } else {
      loadAsm();
      toast('已重新分析');
    }
  });
  $('btnReset').addEventListener('click', resetAll);
  $('btnStep').addEventListener('click', () => {
    stopPlay();
    if (!state.machine || state.machine.halted) { toast('程序已结束，可点重置'); return; }
    stepOnce(true);
  });
  $('btnPrev').addEventListener('click', stepBack);
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnHelp').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
  $('btnCloseHelp').addEventListener('click', () => $('helpModal').classList.add('hidden'));
  $('helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') $('helpModal').classList.add('hidden'); });
  $('docSearch').addEventListener('input', e => renderDoc(e.target.value));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('helpModal').classList.add('hidden');
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (state.mode === 'c2asm') compileC(); else loadAsm();
    }
    if (e.key === 'F8' || (e.key === 'Enter' && e.altKey)) { e.preventDefault(); if (!$('btnStep').disabled) stepOnce(true); }
  });

  // 汇编编辑 → 自动重分析（防抖）
  let debounce = null;
  asmEd.onChange = () => {
    state.fromC = false;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      loadAsm(true);
    }, 420);
  };

  // C 编辑不自动编译，但记住内容
  leftEd.onChange = () => {
    if (state.mode === 'c2asm') state.cText = leftEd.ta.value;
  };

  // 光标位置 → 显示指令说明
  function updateMnemonicTip() {
    const ln = asmEd.caretLine();
    const line = (asmEd.ta.value.split('\n')[ln - 1] || '').trim();
    const tok = (line.split(/\s+/)[0] || '').toLowerCase();
    const info = D.INSTR_MAP[tok];
    const el = $('mnemonicTip');
    if (info) {
      el.innerHTML = '<b>' + info.name + '</b> ' + info.cn + ' · ' + info.desc.slice(0, 46) + '…';
    } else {
      el.textContent = '把光标放在某条指令上，这里会显示它的含义';
    }
  }
  asmEd.onCaret = updateMnemonicTip;
  leftEd.onCaret = () => { };

  /* ============================================================
   * 12.5 AI 代码解读栏（独立分析栏）
   * ============================================================ */
  const AI = window.ASM_AI;
  let aiOpen = window.innerWidth >= 1500;
  let aiBusy = false;

  function applyAiOpen() {
    const ws = document.querySelector('.workspace');
    if (ws) ws.classList.toggle('with-ai', aiOpen);
    $('paneAI').classList.toggle('open', aiOpen);
    $('btnAiToggle').classList.toggle('primary', aiOpen);
  }

  function renderAiBlock(b) {
    let inner = '';
    if (b.type === 'lead') inner = '<div class="ai-lead">' + esc(b.text) + '</div>';
    else if (b.type === 'ol') inner = '<ol class="ai-list">' + b.items.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>';
    else if (b.type === 'ul') inner = '<ul class="ai-list">' + b.items.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    else if (b.type === 'kv') inner = '<div class="ai-kv">' + b.items.map(it => '<div class="k">' + esc(it[0]) + '</div><div class="v">' + esc(it[1]) + '</div>').join('') + '</div>';
    else if (b.type === 'badges') inner = '<div class="ai-badges">' + b.items.map(it => '<span class="ai-badge">' + esc(it.k) + ' <b>' + esc(it.v) + '</b></span>').join('') + '</div>';
    else if (b.type === 'code') inner = '<pre class="ai-code">' + esc(b.text) + '</pre>' + (b.note ? '<div class="ai-note">' + esc(b.note) + '</div>' : '');
    else inner = '<div class="ai-tip">' + esc(b.text || '') + '</div>';
    return '<div class="ai-block"><h5>' + esc(b.t) + '</h5>' + inner + '</div>';
  }

  function aiPayload() {
    return {
      ast: state.mode === 'c2asm' ? state.ast : null,
      cSrc: state.mode === 'c2asm' ? leftEd.ta.value : '',
      asm: asmEd.ta.value,
      prog: state.prog,
      stats: state.stats,
      varMap: state.varMap,
      dec: state.dec
    };
  }

  function renderAI() {
    const body = $('aiBody');
    if (!AI) { body.innerHTML = '<div class="ai-tip">分析模块未加载。</div>'; return; }
    if (!state.prog || !state.prog.instrs || !state.prog.instrs.length) {
      body.innerHTML = '<div class="ai-tip">还没有可分析的代码。左边写 C 点「编译并加载」，或在中间直接写汇编。</div>';
      return;
    }
    try {
      const res = AI.localAnalyze(aiPayload());
      state.aiLocal = res;
      body.innerHTML = res.blocks.map(renderAiBlock).join('');
      $('aiEngineTag').textContent = '本地引擎';
      $('aiFoot').textContent = '离线解读：直接读 AST 与运行结果，不联网';
    } catch (e) {
      body.innerHTML = '<div class="ai-tip">分析出错：' + esc(e.message) + '</div>';
    }
  }

  async function runAiDeep() {
    if (aiBusy) return;
    if (!state.prog || !state.prog.instrs.length) { toast('先编译或载入一段代码', true); return; }
    const cfg = AI.loadCfg();
    if (!cfg.key || !cfg.endpoint) {
      openAiCfg();
      toast('本地解读已经可用；想用大模型请先填接口和密钥', true);
      return;
    }
    const body = $('aiBody');
    const local = state.aiLocal || AI.localAnalyze(aiPayload());
    const prompt = AI.buildPrompt(aiPayload(), local);
    const holder = document.createElement('div');
    holder.className = 'ai-block';
    holder.innerHTML = '<h5>大模型讲解</h5><div class="ai-tip"><span class="ai-spin">◌</span> 正在请求 ' + esc(cfg.model || '模型') + ' …</div>';
    body.insertBefore(holder, body.firstChild);
    body.scrollTop = 0;
    aiBusy = true;
    $('btnAiDeep').disabled = true;
    try {
      const txt = await AI.callLLM(cfg, prompt);
      holder.innerHTML = '<h5>大模型讲解</h5><div class="ai-llm">' + esc(txt) + '</div>';
      $('aiEngineTag').textContent = '本地 + ' + (cfg.model || '大模型');
      $('aiFoot').textContent = '大模型内容由你配置的接口生成，仅供参考';
    } catch (e) {
      holder.innerHTML = '<h5>大模型讲解</h5><div class="ai-tip">调用失败：' + esc(e.message) +
        '<br>可以继续看下面的本地解读。</div>';
    } finally {
      aiBusy = false;
      $('btnAiDeep').disabled = false;
    }
  }

  function openAiCfg() {
    const cfg = AI.loadCfg();
    $('aiEndpoint').value = cfg.endpoint || '';
    $('aiKey').value = cfg.key || '';
    $('aiModel').value = cfg.model || '';
    $('aiModal').classList.remove('hidden');
  }

  $('btnAiToggle').addEventListener('click', () => {
    aiOpen = !aiOpen;
    applyAiOpen();
    if (aiOpen) renderAI();
  });
  $('btnAiClose').addEventListener('click', () => { aiOpen = false; applyAiOpen(); });
  $('btnAiDeep').addEventListener('click', runAiDeep);
  $('btnAiCfg').addEventListener('click', openAiCfg);
  $('btnCloseAiCfg').addEventListener('click', () => $('aiModal').classList.add('hidden'));
  $('aiModal').addEventListener('click', e => { if (e.target.id === 'aiModal') $('aiModal').classList.add('hidden'); });
  $('btnAiCfgSave').addEventListener('click', () => {
    AI.saveCfg({
      endpoint: $('aiEndpoint').value.trim(),
      key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim()
    });
    $('aiModal').classList.add('hidden');
    toast('已保存模型配置（只存在本机浏览器）');
  });
  $('btnAiCfgClear').addEventListener('click', () => {
    AI.saveCfg({});
    $('aiEndpoint').value = ''; $('aiKey').value = ''; $('aiModel').value = '';
    toast('已清除模型配置，继续使用本地解读');
  });

  /* ============================================================
   * 13. 启动
   * ============================================================ */
  function boot() {
    loadExampleSelect();
    renderDoc('');
    applyAiOpen();
    state.cText = D.EXAMPLES_C[0].code;
    leftEd.setValue(state.cText);
    setMode('c2asm');
    probeEngine();
    startKeepAlive();
    compileC(true);
    updateMnemonicTip();
    switchTab('line');
    toast('已载入示例：两数相加。点任意汇编行看解释，右侧「AI 代码解读」会总结它在做什么');
  }

  boot();
})();
