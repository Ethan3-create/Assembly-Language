/* ============================================================
 * C → x86-64 汇编 编译器（教学子集，带类型系统）
 * ------------------------------------------------------------
 * 支持的类型：int / long / short / char / float / double / void
 *            指针 T*、数组 T[N]、结构体 struct X { ... }
 * 支持的语句：声明与初始化、表达式语句、if/else、while、for、
 *            do-while、break、continue、return、复合语句
 * 支持的表达式：字面量、变量、函数调用、一元 +-!~&* ++/--、
 *            二元算术/比较/逻辑/位运算、三目 ?:、复合赋值、
 *            下标 []、成员 . 与 ->、类型转换 (T)、sizeof
 * 输出：Intel 语法、未优化（-O0）风格，与 GCC 的结构一致
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 0. 类型系统
   * ============================================================ */
  const SCALAR = {
    int: { k: 'int', size: 4, align: 4 },
    long: { k: 'long', size: 8, align: 8 },
    short: { k: 'short', size: 2, align: 2 },
    char: { k: 'char', size: 1, align: 1 },
    float: { k: 'float', size: 4, align: 4 },
    double: { k: 'double', size: 8, align: 8 },
    void: { k: 'void', size: 0, align: 1 }
  };
  const TYPE_WORDS = ['int', 'long', 'short', 'char', 'float', 'double', 'void',
    'unsigned', 'signed', 'const', 'static', 'register', 'volatile', 'struct'];

  // unsigned 变体：同样的宽度和步长，只是比较 / 除法 / 右移按无符号语义走
  const UNSCALAR = {};
  ['int', 'long', 'short', 'char'].forEach(k => {
    UNSCALAR[k] = { k: k, size: SCALAR[k].size, align: SCALAR[k].align, uns: true };
  });
  const isUnsigned = t => !!t && t.uns === true;

  const ptrTo = to => ({ k: 'ptr', to: to, size: 8, align: 8 });
  const arrOf = (to, n) => ({ k: 'array', to: to, n: n, size: to.size * n, align: to.align });
  const isFloat = t => !!t && (t.k === 'float' || t.k === 'double');
  const isPtrLike = t => !!t && (t.k === 'ptr' || t.k === 'array');
  const isWideT = t => !!t && (t.k === 'ptr' || t.k === 'long' || t.k === 'array');
  const alignUp = (v, a) => (a > 1 ? Math.ceil(v / a) * a : v);

  function typeName(t) {
    if (!t) return '?';
    if (t.k === 'ptr') return typeName(t.to) + '*';
    if (t.k === 'array') return typeName(t.to) + '[' + t.n + ']';
    if (t.k === 'struct') return 'struct ' + t.name;
    return (t.uns ? 'unsigned ' : '') + t.k;
  }
  // 数组在表达式里退化为指向首元素的指针
  const decay = t => (t && t.k === 'array' ? ptrTo(t.to) : t);

  /* ============================================================
   * 1. 词法分析
   * ============================================================ */
  const OPS2 = ['++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=',
    '&&', '||', '<<', '>>', '->'];

  function tokenize(src) {
    const toks = [];
    let i = 0, line = 1;
    const n = src.length;
    const isIdS = c => /[A-Za-z_]/.test(c);
    const isId = c => /[A-Za-z0-9_]/.test(c);
    const UNESC = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };

    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
        i += 2; continue;
      }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

      // 数字（含小数、指数、0x 十六进制）
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const start = i;
        let isF = false;
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          i += 2;
          while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
          const raw0 = src.slice(start, i);
          while (i < n && /[uUlL]/.test(src[i])) i++;
          toks.push({ t: 'num', v: parseInt(raw0, 16) || 0, isFloat: false, raw: raw0, line: line });
          continue;
        }
        while (i < n && /[0-9]/.test(src[i])) i++;
        if (src[i] === '.') { isF = true; i++; while (i < n && /[0-9]/.test(src[i])) i++; }
        if ((src[i] === 'e' || src[i] === 'E') && /[0-9+\-]/.test(src[i + 1] || '')) {
          isF = true; i += 2; while (i < n && /[0-9]/.test(src[i])) i++;
        }
        while (i < n && /[fFuUlL]/.test(src[i])) { if (/[fF]/.test(src[i])) isF = true; i++; }
        const raw = src.slice(start, i).replace(/[fFuUlL]$/, '');
        toks.push({
          t: 'num', v: isF ? parseFloat(raw) : (parseInt(raw, 10) || 0),
          isFloat: isF, raw: raw, line: line
        });
        continue;
      }

      // 字符串 / 字符字面量
      if (c === '"' || c === "'") {
        const q = c; i++;
        let out = '';
        while (i < n && src[i] !== q) {
          if (src[i] === '\\') {
            const e = src[i + 1];
            out += UNESC[e] !== undefined ? UNESC[e] : e;
            i += 2;
          } else { out += src[i++]; }
        }
        i++;
        if (q === "'") toks.push({ t: 'num', v: out.charCodeAt(0) || 0, isFloat: false, raw: out, line: line, isChar: true });
        else toks.push({ t: 'str', v: out, line: line });
        continue;
      }

      if (isIdS(c)) {
        const start = i;
        while (i < n && isId(src[i])) i++;
        toks.push({ t: 'id', v: src.slice(start, i), line: line });
        continue;
      }
      const two = src.substr(i, 2);
      if (OPS2.indexOf(two) >= 0) { toks.push({ t: 'op', v: two, line: line }); i += 2; continue; }
      toks.push({ t: 'op', v: c, line: line }); i++;
    }
    toks.push({ t: 'eof', v: '<EOF>', line: line });
    return toks;
  }

  /* ============================================================
   * 2. 语法分析
   * ============================================================ */
  function Parser(toks) {
    this.t = toks;
    this.i = 0;
    this.structs = new Map();   // 结构体名 → 类型对象
  }
  Parser.prototype.peek = function (o) { return this.t[this.i + (o || 0)]; };
  Parser.prototype.next = function () { return this.t[this.i++]; };
  Parser.prototype.at = function (v) { const t = this.peek(); return !!t && t.v === v; };
  Parser.prototype.eat = function (v) { if (this.at(v)) return this.t[this.i++]; return null; };
  Parser.prototype.err = function (msg, line) {
    throw new Error(msg + '（第 ' + (line || (this.peek() ? this.peek().line : '?')) + ' 行）');
  };
  Parser.prototype.expect = function (v) {
    const t = this.peek();
    if (!t || t.v !== v) this.err('语法错误：期望 "' + v + '"，但遇到 "' + (t ? t.v : '文件结尾') + '"');
    return this.t[this.i++];
  };
  Parser.prototype.isTypeStart = function (o) {
    const t = this.peek(o || 0);
    return !!t && t.t === 'id' && TYPE_WORDS.indexOf(t.v) >= 0;
  };

  /* --- 类型与声明符 --- */
  Parser.prototype.parseTypeBase = function () {
    let uns = false, sawMod = false;
    while (this.peek() && ['const', 'static', 'register', 'volatile', 'unsigned', 'signed'].indexOf(this.peek().v) >= 0) {
      if (this.peek().v === 'unsigned') { uns = true; sawMod = true; }
      if (this.peek().v === 'signed') sawMod = true;
      this.next();
    }
    if (this.at('struct')) {
      const kw = this.next();
      const nm = this.next();
      if (!nm || nm.t !== 'id') this.err('语法错误：struct 后面需要结构体名', kw.line);
      const st = this.structs.get(nm.v);
      if (!st) this.err('未定义的结构体 struct ' + nm.v + '（请先写出 struct ' + nm.v + ' { ... }; 的定义）', nm.line);
      return st;
    }
    const w = this.peek();
    const isTyWord = w && w.t === 'id' && SCALAR[w.v];
    // unsigned / signed 单独出现（如 unsigned u = 1;）等价于 unsigned int
    if (!isTyWord && sawMod) return uns ? UNSCALAR.int : SCALAR.int;
    if (!isTyWord) this.err('无法识别的类型 "' + (w ? w.v : '') + '"');
    this.next();
    let base = SCALAR[w.v];
    if (w.v === 'long' && this.at('long')) this.next();
    if (uns && UNSCALAR[w.v]) base = UNSCALAR[w.v];
    return base;
  };

  // 声明符：*name、name[N]、*name[N] ……（name 可省略，用于参数和类型转换）
  Parser.prototype.parseDeclarator = function (base, needName) {
    let t = base;
    while (this.at('*')) { this.next(); t = ptrTo(t); while (this.at('const')) this.next(); }
    let name = null;
    if (this.peek() && this.peek().t === 'id' && !this.isTypeStart()) name = this.next().v;
    else if (needName) this.err('这里需要一个变量名或函数名');
    // 多维数组：int a[2][3] 是「2 个元素，每个元素是 int[3]」，所以要倒着套
    const dims = [];
    while (this.at('[')) {
      const lb = this.next();
      // 长度留空：int a[] = {1,2,3};  char s[] = "hi";  长度由初始化式推出来
      if (this.at(']')) {
        this.next();
        dims.push(0);
        continue;
      }
      const nt = this.next();
      if (!nt || nt.t !== 'num') this.err('数组长度必须是整数字面量', lb.line);
      this.expect(']');
      dims.push(nt.v);
    }
    for (let k = dims.length - 1; k >= 0; k--) {
      t = arrOf(t, dims[k]);
      if (dims[k] === 0) t.unknown = true;
    }
    return { type: t, name: name };
  };

  Parser.prototype.parseStructDef = function () {
    const kw = this.next();          // struct
    const nm = this.next();
    if (!nm || nm.t !== 'id') this.err('结构体名无效', kw.line);
    this.expect('{');
    const fields = [];
    let off = 0, maxAlign = 1;
    while (!this.at('}')) {
      if (this.peek().t === 'eof') this.err('结构体定义没有闭合的 }', kw.line);
      const base = this.parseTypeBase();
      do {
        const d = this.parseDeclarator(base, true);
        const a = d.type.align || 1;
        maxAlign = Math.max(maxAlign, a);
        off = alignUp(off, a);
        fields.push({ name: d.name, type: d.type, off: off });
        off += d.type.size;
      } while (this.eat(','));
      this.expect(';');
    }
    this.expect('}');
    this.expect(';');
    const st = { k: 'struct', name: nm.v, fields: fields, size: alignUp(off, maxAlign), align: maxAlign };
    this.structs.set(nm.v, st);
    return st;
  };

  Parser.prototype.parseProgram = function () {
    const items = [];
    while (this.peek().t !== 'eof') {
      if (this.eat(';')) continue;
      if (this.at('struct') && this.peek(1) && this.peek(1).t === 'id' && this.peek(2) && this.peek(2).v === '{') {
        this.parseStructDef();
        continue;
      }
      const line = this.peek().line;
      const base = this.parseTypeBase();
      const d = this.parseDeclarator(base, true);
      if (this.at('(')) { items.push(this.parseFunctionRest(d, line)); continue; }
      // ── 全局变量：int g = 10;  int a[5];  char msg[] = "hi"; ──
      let init = null, initList = null;
      if (this.eat('=')) {
        if (this.at('{')) initList = this.parseInitList();
        else init = this.parseAssign();
      }
      fillUnknownLen(this, d.type, init, initList);
      this.expect(';');
      items.push({ k: 'gvar', name: d.name, type: d.type, init: init, initList: initList, line: line });
    }
    if (!items.some(x => x.k === 'func')) this.err('没有找到任何函数。C 程序至少需要 int main() { ... }', 1);
    return items;
  };

  // 已经读过「返回类型 + 函数名」之后的部分：参数表、函数体
  Parser.prototype.parseFunctionRest = function (d, line) {
    this.expect('(');
    const params = [];
    if (!this.at(')')) {
      if (this.at('void') && this.peek(1) && this.peek(1).v === ')') this.next();
      else {
        do {
          const pb = this.parseTypeBase();
          const pd = this.parseDeclarator(pb, true);
          // 形参写成 int a[] 时，它在函数里其实是个指针
          let pt = pd.type;
          if (pt.k === 'array') pt = ptrTo(pt.to);
          params.push({ name: pd.name, type: pt });
        } while (this.eat(','));
      }
    }
    this.expect(')');
    if (this.eat(';')) return { k: 'proto', name: d.name, ret: d.type, params: params, line: line };
    const body = this.parseBlock();
    return { k: 'func', name: d.name, ret: d.type, params: params, body: body, line: line };
  };

  Parser.prototype.parseFunction = function () {
    const line = this.peek().line;
    const base = this.parseTypeBase();
    const d = this.parseDeclarator(base, true);
    if (!this.at('(')) this.err('顶层只能定义函数、结构体或全局变量', line);
    return this.parseFunctionRest(d, line);
  };

  Parser.prototype.parseBlock = function () {
    this.expect('{');
    const body = [];
    while (!this.at('}') && this.peek().t !== 'eof') body.push(this.parseStmt());
    this.expect('}');
    return { k: 'block', body: body };
  };

  Parser.prototype.parseStmt = function () {
    const t = this.peek();
    if (!t || t.t === 'eof') this.err('语法错误：代码意外结束，可能缺少 }');
    if (t.v === '{') return this.parseBlock();
    if (t.v === ';') { this.next(); return { k: 'empty' }; }
    if (t.v === 'if') {
      this.next(); this.expect('(');
      const c = this.parseExpr(); this.expect(')');
      const then = this.parseStmt();
      let els = null;
      if (this.at('else')) { this.next(); els = this.parseStmt(); }
      return { k: 'if', c: c, then: then, els: els, line: t.line };
    }
    if (t.v === 'while') {
      this.next(); this.expect('(');
      const c = this.parseExpr(); this.expect(')');
      return { k: 'while', c: c, body: this.parseStmt(), line: t.line };
    }
    if (t.v === 'do') {
      this.next();
      const body = this.parseStmt();
      this.expect('while'); this.expect('(');
      const c = this.parseExpr(); this.expect(')'); this.expect(';');
      return { k: 'dowhile', c: c, body: body, line: t.line };
    }
    if (t.v === 'for') {
      this.next(); this.expect('(');
      let init = null, cond = null, step = null;
      if (!this.at(';')) init = this.parseSimpleStmt();
      this.expect(';');
      if (!this.at(';')) cond = this.parseExpr();
      this.expect(';');
      if (!this.at(')')) step = this.parseExpr();
      this.expect(')');
      return { k: 'for', init: init, cond: cond, step: step, body: this.parseStmt(), line: t.line };
    }
    if (t.v === 'return') {
      this.next();
      let e = null;
      if (!this.at(';')) e = this.parseExpr();
      this.expect(';');
      return { k: 'return', e: e, line: t.line };
    }
    if (t.v === 'break') { this.next(); this.expect(';'); return { k: 'break', line: t.line }; }
    if (t.v === 'continue') { this.next(); this.expect(';'); return { k: 'continue', line: t.line }; }
    if (t.v === 'switch') {
      this.next(); this.expect('(');
      const e = this.parseExpr(); this.expect(')');
      this.expect('{');
      const cases = [];
      let cur = null;
      while (!this.at('}')) {
        if (this.peek().t === 'eof') this.err('switch 的 { 没有对应的 }', t.line);
        if (this.at('case')) {
          this.next();
          const v = this.parseExpr();
          this.expect(':');
          cur = { v: v, body: [] };
          cases.push(cur);
          continue;
        }
        if (this.at('default')) {
          this.next(); this.expect(':');
          cur = { v: null, body: [] };
          cases.push(cur);
          continue;
        }
        if (!cur) this.err('switch 里的语句必须写在 case 或 default 标签之后', this.peek().line);
        cur.body.push(this.parseStmt());
      }
      this.expect('}');
      return { k: 'switch', e: e, cases: cases, line: t.line };
    }
    if (this.isTypeStart()) return this.parseDecl();
    const s = this.parseExpr();
    this.expect(';');
    return { k: 'expr', e: s, line: t.line };
  };

  // 不带结尾分号的简单语句（for 的初始化用）
  Parser.prototype.parseSimpleStmt = function () {
    if (this.isTypeStart()) {
      const line = this.peek().line;
      const items = this.parseDeclItems();
      return { k: 'decl', items: items, line: line };
    }
    return this.parseExpr();
  };

  Parser.prototype.parseDeclItems = function () {
    const base = this.parseTypeBase();
    const items = [];
    do {
      const d = this.parseDeclarator(base, true);
      let init = null, initList = null;
      if (this.eat('=')) {
        if (this.at('{')) initList = this.parseInitList();
        else init = this.parseAssign();
      }
      fillUnknownLen(this, d.type, init, initList);
      items.push({ name: d.name, type: d.type, init: init, initList: initList });
    } while (this.eat(','));
    return items;
  };

  // 把 int a[] 这种没写长度的数组，用初始化式补上长度（多维时逐层往下补）
  function fillUnknownLen(ps, type, init, initList) {
    if (!type || type.k !== 'array') return;
    const elem = type.to;
    if (type.unknown) {
      if (init && init.k === 'str' && elem.k === 'char') {
        type.n = init.v.length + 1;          // 末尾还有个 '\0'
      } else if (initList) {
        type.n = initList.length;
      } else {
        ps.err('数组长度不能省略：写成 int a[5]，或用 = {…} / = "…" 让编译器自己数');
        return;
      }
      type.size = Math.max(1, elem.size) * type.n;
      type.unknown = false;
    }
    if (elem && elem.k === 'array') {
      const first = initList ? initList.filter(x => x && x.k === 'initlist')[0] : null;
      if (first) fillUnknownLen(ps, elem, null, first.list);
      else if (elem.unknown) ps.err('二维数组的内层长度也不能省略，例如 int a[2][3]');
    }
  }

  Parser.prototype.parseInitList = function () {
    this.expect('{');
    const list = [];
    while (!this.at('}')) {
      if (this.at('{')) list.push({ k: 'initlist', list: this.parseInitList() });
      else list.push(this.parseAssign());
      if (!this.eat(',')) break;
    }
    this.expect('}');
    return list;
  };

  Parser.prototype.parseDecl = function () {
    const line = this.peek().line;
    const items = this.parseDeclItems();
    this.expect(';');
    return { k: 'decl', items: items, line: line };
  };

  /* --- 表达式 --- */
  const BIN_LEVELS = [
    ['||'], ['&&'],
    ['|'], ['^'], ['&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%']
  ];
  const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%='];

  Parser.prototype.parseExpr = function () { return this.parseAssign(); };

  Parser.prototype.parseAssign = function () {
    const left = this.parseCond();
    const t = this.peek();
    if (t && t.t === 'op' && ASSIGN_OPS.indexOf(t.v) >= 0) {
      this.next();
      const right = this.parseAssign();
      return { k: 'assign', op: t.v, target: left, e: right, line: t.line };
    }
    return left;
  };

  Parser.prototype.parseCond = function () {
    const c = this.parseBinary(0);
    if (this.at('?')) {
      const q = this.next();
      const a = this.parseAssign();
      this.expect(':');
      const b = this.parseCond();
      return { k: 'cond', c: c, a: a, b: b, line: q.line };
    }
    return c;
  };

  Parser.prototype.parseBinary = function (lvl) {
    if (lvl >= BIN_LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(lvl + 1);
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && BIN_LEVELS[lvl].indexOf(t.v) >= 0) {
        this.next();
        const right = this.parseBinary(lvl + 1);
        left = { k: 'bin', op: t.v, l: left, r: right, line: t.line };
      } else break;
    }
    return left;
  };

  Parser.prototype.looksLikeCast = function () {
    const n1 = this.peek(1);
    if (!n1 || n1.t !== 'id' || TYPE_WORDS.indexOf(n1.v) < 0) return false;
    let k = 2;
    while (this.peek(k) && this.peek(k).v === '*') k++;
    if (this.peek(k) && this.peek(k).v === '[') return false;
    return !!(this.peek(k) && this.peek(k).v === ')');
  };

  Parser.prototype.parseUnary = function () {
    const t = this.peek();
    if (!t) this.err('语法错误：表达式不完整');
    if (t.v === '(' && this.looksLikeCast()) {
      this.next();
      const base = this.parseTypeBase();
      const d = this.parseDeclarator(base, false);
      this.expect(')');
      return { k: 'cast', type: d.type, e: this.parseUnary(), line: t.line };
    }
    if (t.t === 'id' && t.v === 'sizeof') {
      this.next();
      if (this.at('(') && this.isTypeStart(1)) {
        this.next();
        const base = this.parseTypeBase();
        const d = this.parseDeclarator(base, false);
        this.expect(')');
        return { k: 'num', v: d.type.size, isFloat: false, line: t.line };
      }
      const e = this.parseUnary();
      return { k: 'sizeof', e: e, line: t.line };
    }
    if (t.t === 'op' && ['-', '!', '~', '+'].indexOf(t.v) >= 0) {
      this.next();
      return { k: 'un', op: t.v, e: this.parseUnary(), line: t.line };
    }
    if (t.t === 'op' && (t.v === '&' || t.v === '*')) {
      this.next();
      return { k: t.v === '&' ? 'addr' : 'deref', e: this.parseUnary(), line: t.line };
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.next();
      return { k: 'incdec', op: t.v, prefix: true, e: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  };

  Parser.prototype.parsePostfix = function () {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.v === '(' && e.k === 'var') {
        const lp = this.next();
        const args = [];
        while (!this.at(')')) {
          args.push(this.parseAssign());
          if (!this.eat(',')) break;
        }
        this.expect(')');
        e = { k: 'call', name: e.name, args: args, line: lp.line };
        continue;
      }
      if (t.v === '[') {
        const lb = this.next();
        const idx = this.parseExpr();
        this.expect(']');
        e = { k: 'index', a: e, i: idx, line: lb.line };
        continue;
      }
      if (t.v === '.') {
        this.next();
        const f = this.next();
        if (!f || f.t !== 'id') this.err('成员名无效', t.line);
        e = { k: 'field', b: e, name: f.v, line: t.line };
        continue;
      }
      if (t.v === '->') {
        this.next();
        const f = this.next();
        if (!f || f.t !== 'id') this.err('成员名无效', t.line);
        e = { k: 'arrow', p: e, name: f.v, line: t.line };
        continue;
      }
      if (t.v === '++' || t.v === '--') {
        this.next();
        e = { k: 'incdec', op: t.v, prefix: false, e: e, line: t.line };
        continue;
      }
      break;
    }
    return e;
  };

  Parser.prototype.parsePrimary = function () {
    const t = this.next();
    if (!t || t.t === 'eof') this.err('语法错误：表达式不完整');
    if (t.t === 'num') return { k: 'num', v: t.v, isFloat: !!t.isFloat, line: t.line };
    if (t.t === 'str') return { k: 'str', v: t.v, line: t.line };
    if (t.t === 'id') return { k: 'var', name: t.v, line: t.line };
    if (t.v === '(') {
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    this.err('语法错误：无法解析的记号 "' + t.v + '"', t.line);
  };

  /* ============================================================
   * 3. 代码生成
   * ============================================================ */
  const GPR64 = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
  const GPR32 = ['edi', 'esi', 'edx', 'ecx', 'r8d', 'r9d'];
  const SIZENAME = { 1: 'BYTE', 2: 'WORD', 4: 'DWORD', 8: 'QWORD' };

  const F64BUF = new ArrayBuffer(8);
  const F64DV = new DataView(F64BUF);
  function f64Bits(v) {
    F64DV.setFloat64(0, v, true);
    return (BigInt(F64DV.getUint32(4, true)) << 32n) | BigInt(F64DV.getUint32(0, true));
  }

  // 编译期求常量值（case 标签、全局初值等只允许常量）
  function constValue(n) {
    if (!n) return null;
    switch (n.k) {
      case 'num': return n.v;
      case 'cast': return constValue(n.e);
      case 'un': {
        const v = constValue(n.e);
        if (v === null) return null;
        if (n.op === '-') return -v;
        if (n.op === '+') return v;
        if (n.op === '~') return ~v;
        if (n.op === '!') return v ? 0 : 1;
        return null;
      }
      case 'bin': {
        const a = constValue(n.l), b = constValue(n.r);
        if (a === null || b === null) return null;
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b ? Math.trunc(a / b) : null;
          case '%': return b ? a % b : null;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          default: return null;
        }
      }
      default: return null;
    }
  }

  function Gen() {
    this.out = [];
    this.labN = 0;
    this.strN = 0;
    this.strs = [];
    this.strMap = {};
    this.f64N = 0;
    this.f64s = [];
    this.f64Map = {};
    this.scopes = [new Map()];
    this.frameOff = 0;
    this.loopStack = [];
    this.retLabel = '';
    this.funcName = '';
    this.curRet = SCALAR.int;
    this.warn = [];
    this.sigs = new Map();
    this.varMap = [];
    this.globals = [];
    this.gmap = new Map();
    this.pendingGlobal = [];
  }

  Gen.prototype.newLabel = function () { return '.L' + (++this.labN); };
  Gen.prototype.emit = function (text, comment, kind) {
    this.out.push({ text: text, comment: comment || '', kind: kind || 'code' });
  };
  Gen.prototype.emitLabel = function (name, comment) {
    this.out.push({ text: name + ':', comment: comment || '', kind: 'label' });
  };

  /* --- 作用域与局部变量 --- */
  Gen.prototype.pushScope = function () { this.scopes.push(new Map()); };
  Gen.prototype.popScope = function () { this.scopes.pop(); };
  Gen.prototype.lookup = function (name, line) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    if (this.gmap.has(name)) return this.gmap.get(name);
    throw new Error('使用了未定义的变量 "' + name + '"（请先声明，例如 int ' + name + ';）' + (line ? '（第 ' + line + ' 行）' : ''));
  };
  Gen.prototype.declareGlobal = function (g) {
    if (this.gmap.has(g.name)) throw new Error('全局变量 ' + g.name + ' 重复定义（第 ' + g.line + ' 行）');
    this.gmap.set(g.name, { type: g.type, global: true, name: g.name });
    // 初值不是编译期常量（比如 int *p = &x;  char *s = "hi";）时，
    // 数据段先放 0，等 main 一开始再补一次赋值——教学模拟器里这样最直观
    if (g.init && constValue(g.init) === null) {
      let kind = null, value = null;
      if (g.init.k === 'str') { kind = 'str'; value = g.init.v; }
      else if (g.init.k === 'addr' && g.init.e.k === 'var') { kind = 'addr'; value = g.init.e.name; }
      else if (g.init.k === 'var') { kind = 'addr'; value = g.init.name; }
      if (!kind) {
        throw new Error('全局变量 ' + g.name + ' 的初值必须是常量（第 ' + g.line + ' 行）。' +
          '指针可以写 &变量 或字符串常量；其它表达式请放到函数里赋值');
      }
      g.deferred = { kind: kind, value: value };
      this.pendingGlobal.push({ name: g.name, kind: kind, value: value });
    }
    this.globals.push(g);
  };
  Gen.prototype.declare = function (name, sym) {
    const s = this.scopes[this.scopes.length - 1];
    if (s.has(name)) this.warn.push('变量 ' + name + ' 在同一作用域被重复声明，后者覆盖前者');
    s.set(name, sym);
  };
  Gen.prototype.allocLocal = function (name, type) {
    const size = Math.max(1, type.size);
    const a = type.align || 1;
    this.frameOff = alignUp(this.frameOff + size, a);
    const off = this.frameOff;
    this.declare(name, { type: type, off: off });
    this.varMap.push({ name: name, offset: off, size: size, type: typeName(type), func: this.funcName || null });
    return off;
  };
  Gen.prototype.memRef = function (reg, off, size) {
    const sz = SIZENAME[size] || 'DWORD';
    const inner = off === 0 ? reg : (off > 0 ? reg + '+' + off : reg + off);
    return sz + ' PTR [' + inner + ']';
  };
  Gen.prototype.localRef = function (off, size) {
    return (SIZENAME[size] || 'DWORD') + ' PTR [rbp-' + off + ']';
  };
  // 全局变量用绝对地址访问：[变量名]
  Gen.prototype.gRef = function (name, size) {
    return (SIZENAME[size] || 'DWORD') + ' PTR [' + name + ']';
  };
  Gen.prototype.loadGlobal = function (name, type) {
    if (isFloat(type)) {
      this.emit((type.k === 'float' ? 'movss' : 'movsd') + ' xmm0, ' + this.gRef(name, type.size), '读全局变量 ' + name);
      return;
    }
    const sz = Math.max(1, type.size);
    const ext = isUnsigned(type) ? 'movzx' : 'movsx';
    if (sz === 1) this.emit(ext + ' eax, ' + this.gRef(name, 1), '读全局变量 ' + name);
    else if (sz === 2) this.emit(ext + ' eax, ' + this.gRef(name, 2), '读全局变量 ' + name);
    else if (sz === 8) this.emit('mov rax, ' + this.gRef(name, 8), '读全局变量 ' + name);
    else this.emit('mov eax, ' + this.gRef(name, 4), '读全局变量 ' + name);
  };

  /* --- 常量池 --- */
  Gen.prototype.intern = function (text) {
    if (this.strMap[text] !== undefined) return this.strMap[text];
    const label = '.LC' + (this.strN++);
    this.strMap[text] = label;
    this.strs.push({ label: label, text: text });
    return label;
  };
  Gen.prototype.f64 = function (v) {
    const key = String(v);
    if (this.f64Map[key] !== undefined) return this.f64Map[key];
    const label = '.LF' + (this.f64N++);
    this.f64Map[key] = label;
    this.f64s.push({ label: label, bits: f64Bits(v), value: v });
    return label;
  };

  /* --- 装/取值 --- */
  Gen.prototype.loadAt = function (baseReg, off, type, toXmm) {
    if (isFloat(type)) {
      const mn = type.k === 'float' ? 'movss' : 'movsd';
      this.emit(mn + ' xmm0, ' + this.memRef(baseReg, off, type.size));
      return;
    }
    const sz = Math.max(1, type.size);
    // 无符号的小整数用 movzx 零扩展，有符号的用 movsx 符号扩展
    const ext = isUnsigned(type) ? 'movzx' : 'movsx';
    if (sz === 1) this.emit(ext + ' eax, ' + this.memRef(baseReg, off, 1));
    else if (sz === 2) this.emit(ext + ' eax, ' + this.memRef(baseReg, off, 2));
    else if (sz === 8) this.emit('mov rax, ' + this.memRef(baseReg, off, 8));
    else this.emit('mov eax, ' + this.memRef(baseReg, off, 4));
  };

  // 把 eax/xmm0 存到 [baseReg+off]
  Gen.prototype.storeAt = function (baseReg, off, type) {
    if (isFloat(type)) {
      const mn = type.k === 'float' ? 'movss' : 'movsd';
      this.emit(mn + ' ' + this.memRef(baseReg, off, type.size) + ', xmm0');
      return;
    }
    const sz = Math.max(1, type.size);
    if (sz === 1) this.emit('mov ' + this.memRef(baseReg, off, 1) + ', al');
    else if (sz === 2) this.emit('mov ' + this.memRef(baseReg, off, 2) + ', ax');
    else if (sz === 8) this.emit('mov ' + this.memRef(baseReg, off, 8) + ', rax');
    else this.emit('mov ' + this.memRef(baseReg, off, 4) + ', eax');
  };

  Gen.prototype.zeroAt = function (baseReg, off, size) {
    let done = 0;
    while (size - done >= 4) {
      this.emit('mov ' + this.memRef(baseReg, off + done, 4) + ', 0');
      done += 4;
    }
    for (; done < size; done++) this.emit('mov ' + this.memRef(baseReg, off + done, 1) + ', 0');
  };

  /* --- 类型推导 --- */
  Gen.prototype.t = function (n) {
    if (!n) return SCALAR.int;
    switch (n.k) {
      case 'num':
        if (n.isFloat) return SCALAR.double;
        // 超出 int 范围的整数字面量按 long 处理，否则后面的 neg / 除法会被截断成 32 位
        if (Math.abs(n.v) > 2147483647) return SCALAR.long;
        return SCALAR.int;
      case 'str': return ptrTo(SCALAR.char);
      case 'var': return this.lookup(n.name, n.line).type;
      case 'sizeof': return SCALAR.long;
      case 'if':
      case 'index': {
        const bt = this.t(n.a);
        if (bt.k === 'struct') throw new Error('结构体不能直接用下标（第 ' + (n.line || '?') + ' 行）');
        if (bt.k !== 'ptr' && bt.k !== 'array') throw new Error('只有指针和数组能用 [] 下标（第 ' + (n.line || '?') + ' 行）');
        const et = bt.to;
        return et;
      }
      case 'field': {
        const st = this.t(n.b);
        if (st.k !== 'struct') throw new Error('"." 左边不是结构体（第 ' + (n.line || '?') + ' 行）');
        const f = st.fields.filter(x => x.name === n.name)[0];
        if (!f) throw new Error('struct ' + st.name + ' 没有成员 "' + n.name + '"（第 ' + (n.line || '?') + ' 行）');
        return f.type;
      }
      case 'arrow': {
        const pt = this.t(n.p);
        if (pt.k !== 'ptr') throw new Error('"->" 左边必须是指针（第 ' + (n.line || '?') + ' 行）');
        const st = pt.to;
        if (st.k !== 'struct') throw new Error('"->" 左边的指针没有指向结构体（第 ' + (n.line || '?') + ' 行）');
        const f = st.fields.filter(x => x.name === n.name)[0];
        if (!f) throw new Error('struct ' + st.name + ' 没有成员 "' + n.name + '"（第 ' + (n.line || '?') + ' 行）');
        return f.type;
      }
      case 'deref': {
        const pt = this.t(n.e);
        if (pt.k !== 'ptr' && pt.k !== 'array') throw new Error('"*" 右边必须是指针（第 ' + (n.line || '?') + ' 行）');
        return pt.to;
      }
      case 'addr': {
        const et = this.t(n.e);
        if (et.k === 'array') return ptrTo(et.to);
        return ptrTo(et);
      }
      case 'un': {
        if (n.op === '!') return SCALAR.int;
        if (n.op === '+') return this.t(n.e);
        return this.t(n.e);
      }
      case 'bin': {
        const op = n.op;
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].indexOf(op) >= 0) return SCALAR.int;
        const lt = this.t(n.l), rt = this.t(n.r);
        if ((op === '+' || op === '-') && isPtrLike(lt) && isPtrLike(rt)) return SCALAR.long;
        if ((op === '+' || op === '-') && isPtrLike(lt)) return decay(lt);
        if (op === '+' && isPtrLike(rt)) return decay(rt);
        if (isFloat(lt) || isFloat(rt)) return SCALAR.double;
        if (isWideT(lt) || isWideT(rt)) return SCALAR.long;
        return SCALAR.int;
      }
      case 'assign': return this.t(n.target);
      case 'incdec': return this.t(n.e);
      case 'cast': return n.type;
      case 'cond': {
        const a = this.t(n.a), b = this.t(n.b);
        if (isFloat(a) || isFloat(b)) return SCALAR.double;
        if (isWideT(a) || isWideT(b)) return SCALAR.long;
        return a;
      }
      case 'call': {
        const sig = this.sigs.get(n.name);
        if (sig) return sig.ret;
        if (n.name === 'puts' || n.name === 'putchar') return SCALAR.int;
        return SCALAR.int;
      }
      default: return SCALAR.int;
    }
  };
  Gen.prototype.isWide = function (n) { return isWideT(this.t(n)); };

  /* --- 取地址（结果放 rax） --- */
  Gen.prototype.genAddr = function (n) {
    switch (n.k) {
      case 'var': {
        const s = this.lookup(n.name, n.line);
        if (s.global) { this.emit('lea rax, [' + n.name + ']', '取全局变量 ' + n.name + ' 的地址'); return; }
        this.emit('lea rax, [rbp-' + s.off + ']', '取 ' + n.name + ' 的地址');
        return;
      }
      case 'deref':
        this.genInt(n.e);
        return;
      case 'index': {
        const bt = this.t(n.a);
        const et = bt.k === 'array' ? bt.to : bt.to;
        const scale = Math.max(1, et.size || 1);
        if (bt.k === 'array') this.genAddr(n.a);
        else this.genInt(n.a);
        this.emit('push rax');
        this.genInt(n.i);
        this.emit('movsxd rcx, eax');
        if (scale !== 1) this.emit('imul rcx, rcx, ' + scale);
        this.emit('pop rax');
        this.emit('add rax, rcx', '首地址 + 下标 × ' + scale + ' 字节');
        return;
      }
      case 'field': {
        const st = this.t(n.b);
        const f = st.fields.filter(x => x.name === n.name)[0];
        this.genAddr(n.b);
        if (f.off) this.emit('add rax, ' + f.off, '成员 ' + n.name + ' 的偏移');
        return;
      }
      case 'arrow': {
        const pt = this.t(n.p);
        const st = pt.to;
        const f = st.fields.filter(x => x.name === n.name)[0];
        this.genInt(n.p);
        if (f.off) this.emit('add rax, ' + f.off, '成员 ' + n.name + ' 的偏移');
        return;
      }
      default:
        throw new Error('这个表达式不能取地址（第 ' + (n.line || '?') + ' 行）');
    }
  };

  /* --- 表达式：整数/指针 → rax（32 位类型在 eax） --- */
  Gen.prototype.genInt = function (n) {
    if (!n) { this.emit('mov eax, 0'); return; }
    const ty = this.t(n);
    if (isFloat(ty)) { this.genFloat(n); this.emit('cvttsd2si eax, xmm0', '浮点转整数'); return; }
    switch (n.k) {
      case 'num': {
        // 超出 32 位范围的常量必须用 64 位寄存器装，否则会被截断
        const big = Math.abs(n.v) > 2147483647;
        this.emit('mov ' + (ty.k === 'long' || big ? 'rax' : 'eax') + ', ' + n.v,
          big && ty.k !== 'long' ? '常量超出 32 位范围，用 64 位寄存器' : undefined);
        return;
      }
      case 'var': {
        const s = this.lookup(n.name, n.line);
        if (s.global) {
          if (s.type.k === 'array') { this.emit('lea rax, [' + n.name + ']', '全局数组 ' + n.name + ' 退化为首地址'); return; }
          this.loadGlobal(n.name, s.type);
          return;
        }
        if (s.type.k === 'array') {
          this.emit('lea rax, [rbp-' + s.off + ']', '数组 ' + n.name + ' 退化为首地址');
          return;
        }
        this.loadLocal(s.off, s.type);
        return;
      }
      case 'str':
        this.emit('lea rax, [' + this.intern(n.v) + ']', '字符串常量的地址');
        return;
      case 'sizeof':
        this.emit('mov eax, ' + this.t(n.e).size, 'sizeof');
        return;
      case 'deref':
      case 'index':
      case 'field':
      case 'arrow': {
        this.genAddr(n);
        if (ty.k === 'array') return;   // 二维数组的 a[i] 退化为这一行的首地址
        this.loadAt('rax', 0, ty);
        return;
      }
      case 'addr':
        this.genAddr(n.e);
        return;
      case 'cast': {
        const from = this.t(n.e), to = n.type;
        if (isFloat(to)) {
          this.genFloat(n.e);
          if (to.k === 'float') this.emit('cvtsd2ss xmm0, xmm0', '转成 float（单精度）');
          return;
        }
        if (isFloat(from)) {
          this.genFloat(n.e);
          this.emit('cvttsd2si ' + (to.size === 8 ? 'rax' : 'eax') + ', xmm0', '取整');
          if (to.size === 1) this.emit('movsx eax, al');
          return;
        }
        this.genInt(n.e);
        if (to.size === 1) this.emit('movsx eax, al', '截断成 char');
        else if (to.size === 2) this.emit('movsx eax, ax', '截断成 short');
        else if (to.size === 8) this.emit('cdqe', '符号扩展到 64 位');
        else if (to.size === 4) this.emit('mov eax, eax', '截断成 32 位');
        return;
      }
      case 'un': {
        if (n.op === '-') {
          this.genInt(n.e);
          this.emit('neg ' + (isWideT(ty) ? 'rax' : 'eax'));
          return;
        }
        if (n.op === '~') {
          this.genInt(n.e);
          this.emit('not ' + (isWideT(ty) ? 'rax' : 'eax'));
          return;
        }
        if (n.op === '!') {
          this.genInt(n.e);
          this.emit('cmp ' + (isWideT(this.t(n.e)) ? 'rax' : 'eax') + ', 0');
          this.emit('sete al');
          this.emit('movzx eax, al');
          return;
        }
        this.genInt(n.e);
        return;
      }
      case 'bin': return this.genBin(n);
      case 'assign': return this.genAssign(n);
      case 'incdec': return this.genIncDec(n, false);
      case 'cond': {
        const Lf = this.newLabel(), Le = this.newLabel();
        this.genCondJumpFalse(n.c, Lf);
        this.genInt(n.a);
        this.emit('jmp ' + Le);
        this.emitLabel(Lf);
        this.genInt(n.b);
        this.emitLabel(Le);
        return;
      }
      case 'call': return this.genCall(n);
      default:
        throw new Error('不支持的表达式（第 ' + (n.line || '?') + ' 行）');
    }
  };

  // 读局部变量 → eax/rax 或 xmm0
  Gen.prototype.loadLocal = function (off, type) {
    if (isFloat(type)) {
      const mn = type.k === 'float' ? 'movss' : 'movsd';
      this.emit(mn + ' xmm0, ' + this.localRef(off, type.size));
      return;
    }
    const sz = Math.max(1, type.size);
    const ext = isUnsigned(type) ? 'movzx' : 'movsx';
    if (sz === 1) this.emit(ext + ' eax, ' + this.localRef(off, 1));
    else if (sz === 2) this.emit(ext + ' eax, ' + this.localRef(off, 2));
    else if (sz === 8) this.emit('mov rax, ' + this.localRef(off, 8));
    else this.emit('mov eax, ' + this.localRef(off, 4));
  };

  /* --- 浮点表达式：结果放 xmm0 --- */
  Gen.prototype.genFloat = function (n) {
    const ty = this.t(n);
    if (!isFloat(ty)) {
      this.genInt(n);
      this.emit('cvtsi2sd xmm0, ' + (isWideT(ty) ? 'rax' : 'eax'), '整数转成 double');
      return;
    }
    switch (n.k) {
      case 'num':
        this.emit('movsd xmm0, QWORD PTR [' + this.f64(n.v) + ']', '浮点常量 ' + n.v);
        return;
      case 'var': {
        const s = this.lookup(n.name, n.line);
        if (s.global) { this.loadGlobal(n.name, s.type); return; }
        this.loadLocal(s.off, s.type);
        return;
      }
      case 'deref':
      case 'index':
      case 'field':
      case 'arrow':
        this.genAddr(n);
        this.emit('mov rcx, rax');
        this.loadAt('rcx', 0, ty);
        return;
      case 'cast':
        this.genFloat(n.e);
        return;
      case 'incdec':
        this.genIncDec(n, true);
        return;
      case 'assign':
        this.genAssign(n);
        return;
      case 'call':
        this.genCall(n);
        return;
      case 'cond': {
        const Lf = this.newLabel(), Le = this.newLabel();
        this.genCondJumpFalse(n.c, Lf);
        this.genFloat(n.a);
        this.emit('jmp ' + Le);
        this.emitLabel(Lf);
        this.genFloat(n.b);
        this.emitLabel(Le);
        return;
      }
      case 'bin': return this.genFloatBin(n);
      default:
        this.genInt(n);
        this.emit('cvtsi2sd xmm0, eax');
        return;
    }
  };

  Gen.prototype.genFloatBin = function (n) {
    const op = n.op;
    if (['==', '!=', '<', '<=', '>', '>='].indexOf(op) >= 0) {
      this.genFloat(n.l);
      this.emit('sub rsp, 8');
      this.emit('movsd QWORD PTR [rsp], xmm0');
      this.genFloat(n.r);
      this.emit('movsd xmm1, xmm0');
      this.emit('movsd xmm0, QWORD PTR [rsp]');
      this.emit('add rsp, 8');
      this.emit('ucomisd xmm0, xmm1', '比较两个 double');
      const setMap = { '==': 'sete', '!=': 'setne', '<': 'setb', '<=': 'setbe', '>': 'seta', '>=': 'setae' };
      this.emit(setMap[op] + ' al');
      this.emit('movzx eax, al');
      return;
    }
    if (op === '&&' || op === '||') {
      const Ls = this.newLabel(), Le = this.newLabel();
      this.genFloat(n.l);
      this.emit('xorpd xmm1, xmm1');
      this.emit('ucomisd xmm0, xmm1');
      this.emit((op === '&&' ? 'je ' : 'jne ') + Ls);
      this.genFloat(n.r);
      this.emit('xorpd xmm1, xmm1');
      this.emit('ucomisd xmm0, xmm1');
      this.emit('setne al');
      this.emit('movzx eax, al');
      this.emit('jmp ' + Le);
      this.emitLabel(Ls);
      this.emit('mov eax, ' + (op === '&&' ? 0 : 1));
      this.emitLabel(Le);
      this.emit('cvtsi2sd xmm0, eax');
      return;
    }
    const m = { '+': 'addsd', '-': 'subsd', '*': 'mulsd', '/': 'divsd' }[op];
    if (!m) throw new Error('浮点数不支持运算符 "' + op + '"（第 ' + (n.line || '?') + ' 行）');
    this.genFloat(n.l);
    this.emit('sub rsp, 8');
    this.emit('movsd QWORD PTR [rsp], xmm0');
    this.genFloat(n.r);
    this.emit('movsd xmm1, xmm0');
    this.emit('movsd xmm0, QWORD PTR [rsp]');
    this.emit('add rsp, 8');
    this.emit(m + ' xmm0, xmm1');
  };

  /* --- 二元运算（整数 / 指针） --- */
  const CMP_SET = { '==': 'sete', '!=': 'setne', '<': 'setl', '<=': 'setle', '>': 'setg', '>=': 'setge' };
  // 无符号版本：有符号的 l/g 换成 b/a
  const CMP_SET_U = { '==': 'sete', '!=': 'setne', '<': 'setb', '<=': 'setbe', '>': 'seta', '>=': 'setae' };
  const CMP_NEG = { '==': 'jne', '!=': 'je', '<': 'jge', '<=': 'jg', '>': 'jle', '>=': 'jl' };
  const CMP_NEG_U = { '==': 'jne', '!=': 'je', '<': 'jae', '<=': 'ja', '>': 'jbe', '>=': 'jb' };
  // 只要有一边是 unsigned（且不是浮点）就按无符号比较，与 C 的整型提升一致
  const cmpUnsigned = (lt, rt) => isUnsigned(lt) || isUnsigned(rt);

  Gen.prototype.genBin = function (n) {
    const op = n.op;
    const lt = this.t(n.l), rt = this.t(n.r);

    if (isFloat(lt) || isFloat(rt)) {
      // 浮点比较 / 逻辑交给浮点路径，纯算术也在浮点路径
      if (['==', '!=', '<', '<=', '>', '>='].indexOf(op) >= 0) { this.genFloatBin(n); return; }
    }

    // 指针加减：按元素大小缩放；两个指针相减得到元素个数
    if ((op === '+' || op === '-') && (isPtrLike(lt) || isPtrLike(rt))) {
      const ptrSide = isPtrLike(lt) ? lt : rt;
      const elem = ptrSide.to || SCALAR.char;
      const scale = Math.max(1, elem.size || 1);
      const keepBytes = (op === '-' && isPtrLike(lt) && isPtrLike(rt));
      this.genInt(n.l);
      this.emit('push rax');
      this.genInt(n.r);
      this.emit('mov rcx, rax');
      this.emit('pop rax');
      if (keepBytes) {
        this.emit('sub rax, rcx', '两个地址相减');
        if (scale !== 1) {
          this.emit('mov rcx, ' + scale);
          this.emit('cqo');
          this.emit('idiv rcx', '再除以元素大小，得到元素个数');
        }
        return;
      }
      if (isPtrLike(rt) && !isPtrLike(lt)) {
        // 整数 + 指针：交换两侧，保证 rax 是指针、rcx 是下标
        this.emit('xchg rax, rcx');
      }
      if (scale !== 1) {
        this.emit('imul rcx, rcx, ' + scale, '指针算术：下标 × ' + scale + ' 字节');
      }
      this.emit((op === '+' ? 'add' : 'sub') + ' rax, rcx');
      return;
    }

    if (CMP_SET[op]) {
      const wide = isWideT(lt) || isWideT(rt);
      this.genInt(n.l);
      if (!wide && this.isLeaf(n.r)) {
        this.emit('cmp eax, ' + this.leafOperand(n.r));
      } else {
        this.emit('push ' + (wide ? 'rax' : 'rax'));
        this.genInt(n.r);
        this.emit(wide ? 'mov rcx, rax' : 'mov ecx, eax');
        this.emit('pop rax');
        this.emit('cmp ' + (wide ? 'rax, rcx' : 'eax, ecx'));
      }
      this.emit((cmpUnsigned(lt, rt) ? CMP_SET_U : CMP_SET)[op] + ' al');
      this.emit('movzx eax, al');
      return;
    }

    if (op === '&&' || op === '||') {
      const Ls = this.newLabel(), Le = this.newLabel();
      this.genInt(n.l);
      this.emit('cmp ' + (this.isWide(n.l) ? 'rax' : 'eax') + ', 0');
      this.emit((op === '&&' ? 'je ' : 'jne ') + Ls);
      this.genInt(n.r);
      this.emit('cmp ' + (this.isWide(n.r) ? 'rax' : 'eax') + ', 0');
      this.emit('setne al');
      this.emit('movzx eax, al');
      this.emit('jmp ' + Le);
      this.emitLabel(Ls);
      this.emit('mov eax, ' + (op === '&&' ? 0 : 1));
      this.emitLabel(Le);
      return;
    }

    if (op === '/' || op === '%') {
      const uns = cmpUnsigned(lt, rt);
      this.genInt(n.l);
      this.emit('push rax');
      this.genInt(n.r);
      this.emit('mov ecx, eax');
      this.emit('pop rax');
      if (this.isWide(n.l)) {
        if (uns) { this.emit('xor edx, edx', '无符号除法：高位补 0'); this.emit('div rcx'); }
        else { this.emit('cqo'); this.emit('idiv rcx'); }
      } else {
        if (uns) { this.emit('xor edx, edx', '无符号除法：高位补 0'); this.emit('div ecx'); }
        else { this.emit('cdq'); this.emit('idiv ecx'); }
      }
      if (op === '%') this.emit(this.isWide(n.l) ? 'mov rax, rdx' : 'mov eax, edx');
      return;
    }

    if (op === '<<' || op === '>>') {
      const wide = this.isWide(n.l);
      this.genInt(n.l);
      this.emit('push rax');
      this.genInt(n.r);
      this.emit('mov ecx, eax');
      this.emit('pop rax');
      // 无符号数的 >> 是逻辑右移（shr，高位补 0）
      const sh = op === '<<' ? 'shl' : (isUnsigned(lt) ? 'shr' : 'sar');
      this.emit(sh + ' ' + (wide ? 'rax' : 'eax') + ', cl');
      return;
    }

    const m = { '+': 'add', '-': 'sub', '*': 'imul', '&': 'and', '|': 'or', '^': 'xor' }[op];
    if (!m) throw new Error('不支持的运算符 "' + op + '"（第 ' + (n.line || '?') + ' 行）');
    const wide = isWideT(lt) || isWideT(rt);
    if (op === '*') {
      // imul 两操作数形式即可
      this.genInt(n.l);
      this.emit('push rax');
      this.genInt(n.r);
      this.emit(wide ? 'mov rcx, rax' : 'mov ecx, eax');
      this.emit('pop rax');
      this.emit('imul ' + (wide ? 'rax, rcx' : 'eax, ecx'));
      return;
    }
    this.genInt(n.l);
    if (!wide && this.isLeaf(n.r)) {
      this.emit(m + ' eax, ' + this.leafOperand(n.r));
      return;
    }
    this.emit('push rax');
    this.genInt(n.r);
    this.emit(wide ? 'mov rcx, rax' : 'mov ecx, eax');
    this.emit('pop rax');
    this.emit(m + ' ' + (wide ? 'rax, rcx' : 'eax, ecx'));
  };

  Gen.prototype.isLeaf = function (n) { return n && (n.k === 'num' || n.k === 'var'); };
  Gen.prototype.leafOperand = function (n) {
    if (n.k === 'num') return '' + n.v;
    const s = this.lookup(n.name, n.line);
    if (s.global) return this.gRef(n.name, Math.max(1, s.type.size));
    return this.localRef(s.off, Math.max(1, s.type.size));
  };

  /* --- 赋值 --- */
  Gen.prototype.isSimpleLValue = function (n) { return n && n.k === 'var'; };

  // 把当前结果（eax 或 xmm0）写入左值；复杂左值的地址计算会覆盖 eax，所以先压栈
  Gen.prototype.storeAcc = function (target, ty) {
    const simple = this.isSimpleLValue(target);
    if (simple) {
      const s = this.lookup(target.name, target.line);
      if (s.global) {
        if (isFloat(ty)) {
          const mn = ty.k === 'float' ? 'movss' : 'movsd';
          this.emit(mn + ' ' + this.gRef(target.name, ty.size) + ', xmm0', '写入全局变量 ' + target.name);
          return;
        }
        const gsz = Math.max(1, ty.size);
        const gval = gsz === 1 ? 'al' : gsz === 2 ? 'ax' : gsz === 8 ? 'rax' : 'eax';
        this.emit('mov ' + this.gRef(target.name, gsz) + ', ' + gval, '写入全局变量 ' + target.name);
        return;
      }
      if (isFloat(ty)) {
        const mn = ty.k === 'float' ? 'movss' : 'movsd';
        this.emit(mn + ' ' + this.localRef(s.off, ty.size) + ', xmm0', target.name + ' = ...');
        return;
      }
      const sz = Math.max(1, ty.size);
      const val = sz === 1 ? 'al' : sz === 2 ? 'ax' : sz === 8 ? 'rax' : 'eax';
      this.emit('mov ' + this.localRef(s.off, sz) + ', ' + val, target.name + ' = ...');
      return;
    }
    if (isFloat(ty)) {
      this.genAddr(target);
      this.emit('mov rcx, rax');
      const mn = ty.k === 'float' ? 'movss' : 'movsd';
      this.emit(mn + ' ' + this.memRef('rcx', 0, ty.size) + ', xmm0', '写入该地址');
      return;
    }
    this.emit('push rax');
    this.genAddr(target);
    this.emit('mov rcx, rax');
    this.emit('pop rax');
    const sz = Math.max(1, ty.size);
    const val = sz === 1 ? 'al' : sz === 2 ? 'ax' : sz === 8 ? 'rax' : 'eax';
    this.emit('mov ' + this.memRef('rcx', 0, sz) + ', ' + val, '写入该地址');
  };

  Gen.prototype.genAssign = function (n) {
    const target = n.target;
    const ty = this.t(target);
    const op = n.op;

    if (ty.k === 'struct') {
      if (op !== '=') throw new Error('结构体只支持整体赋值 "="（第 ' + (n.line || '?') + ' 行）');
      this.genStructCopy(target, n.e);
      return;
    }

    if (op === '=') {
      if (isFloat(ty)) this.genFloat(n.e); else this.genInt(n.e);
      this.storeAcc(target, ty);
      return;
    }

    // 复合赋值：先算新值 → eax / xmm0，再存回
    if (isFloat(ty)) {
      this.genFloat(target);
      this.emit('sub rsp, 8');
      this.emit('movsd QWORD PTR [rsp], xmm0');
      this.genFloat(n.e);
      this.emit('movsd xmm1, xmm0');
      this.emit('movsd xmm0, QWORD PTR [rsp]');
      this.emit('add rsp, 8');
      const fm = { '+=': 'addsd', '-=': 'subsd', '*=': 'mulsd', '/=': 'divsd' }[op];
      if (!fm) throw new Error('浮点数不支持 "' + op + '"（第 ' + (n.line || '?') + ' 行）');
      this.emit(fm + ' xmm0, xmm1');
      this.storeAcc(target, ty);
      return;
    }

    if ((op === '+=' || op === '-=') && isPtrLike(ty)) {
      const scale = Math.max(1, (ty.to || SCALAR.char).size || 1);
      this.genInt(target);
      this.emit('push rax');
      this.genInt(n.e);
      this.emit('movsxd rcx, eax');
      if (scale !== 1) this.emit('imul rcx, rcx, ' + scale, '指针算术：下标 × ' + scale + ' 字节');
      this.emit('pop rax');
      this.emit((op === '+=' ? 'add' : 'sub') + ' rax, rcx');
      this.storeAcc(target, ty);
      return;
    }

    this.genInt(target);
    this.emit('push rax');
    this.genInt(n.e);
    this.emit('mov ecx, eax');
    this.emit('pop rax');
    if (op === '+=') this.emit('add eax, ecx');
    else if (op === '-=') this.emit('sub eax, ecx');
    else if (op === '*=') this.emit('imul eax, ecx');
    else {
      // 除法 / 取余：eax = 旧值，ecx = 右值
      if (isUnsigned(ty)) { this.emit('xor edx, edx', '无符号除法：高位补 0'); this.emit('div ecx'); }
      else { this.emit('cdq'); this.emit('idiv ecx'); }
      if (op === '%=') this.emit('mov eax, edx');
    }
    this.storeAcc(target, ty);
  };

  /* --- 自增自减 --- */
  Gen.prototype.genIncDec = function (n, wantFloat) {
    const target = n.e;
    const ty = this.t(target);
    const step = (isPtrLike(ty) ? Math.max(1, (ty.to || SCALAR.char).size || 1) : 1);
    const mn = n.op === '++' ? 'add' : 'sub';
    const simple = this.isSimpleLValue(target);
    const s = simple ? this.lookup(target.name, target.line) : null;

    if (isFloat(ty)) {
      if (simple) {
        const ref = s.global ? this.gRef(target.name, ty.size) : this.localRef(s.off, ty.size);
        this.emit('movsd xmm0, ' + ref);
        this.emit('movsd xmm1, QWORD PTR [' + this.f64(1) + ']');
        this.emit((n.op === '++' ? 'addsd' : 'subsd') + ' xmm0, xmm1');
        this.emit('movsd ' + ref + ', xmm0');
        return;
      }
      this.genAddr(target);
      this.emit('mov rcx, rax');
      this.loadAt('rcx', 0, ty);
      this.emit('movsd xmm1, QWORD PTR [' + this.f64(1) + ']');
      this.emit((n.op === '++' ? 'addsd' : 'subsd') + ' xmm0, xmm1');
      this.emit('movsd ' + this.memRef('rcx', 0, ty.size) + ', xmm0');
      return;
    }

    if (simple) {
      const ref = s.global ? this.gRef(target.name, Math.max(1, ty.size)) : this.localRef(s.off, Math.max(1, ty.size));
      this.emit(mn + ' ' + ref + ', ' + step, target.name + n.op);
      if (!n.prefix) {
        // 表达式结果应是旧值
        this.emit('mov eax, ' + ref);
        this.emit((n.op === '++' ? 'sub' : 'add') + ' eax, ' + step);
      } else {
        this.emit('mov eax, ' + ref);
      }
      return;
    }

    this.genAddr(target);
    this.emit('mov rcx, rax');
    this.loadAt('rcx', 0, ty);
    if (!n.prefix) {
      this.emit('mov edx, eax');
    }
    this.emit(mn + ' eax, ' + step);
    this.emit('mov ' + this.memRef('rcx', 0, Math.max(1, ty.size)) + ', ' + (ty.size === 8 ? 'rax' : 'eax'));
    if (!n.prefix) this.emit('mov eax, edx');
  };

  /* --- 结构体整体拷贝 --- */
  Gen.prototype.genStructCopy = function (dstTarget, srcNode) {
    const st = this.t(dstTarget);
    if (!this.isSimpleLValue(dstTarget) || !this.isSimpleLValue(srcNode)) {
      throw new Error('结构体整体赋值目前要求两边都是变量（第 ' + (dstTarget.line || '?') + ' 行）');
    }
    const d = this.lookup(dstTarget.name).off;
    const s = this.lookup(srcNode.name).off;
    this.emit('', '; 结构体整体赋值：逐个成员搬过去', 'gap');
    st.fields.forEach(f => {
      if (f.type.k === 'struct') return;
      const sz = Math.max(1, f.type.size);
      const srcRef = this.localRef(s - f.off, sz);
      const dstRef = this.localRef(d - f.off, sz);
      if (isFloat(f.type)) {
        const mn = f.type.k === 'float' ? 'movss' : 'movsd';
        this.emit(mn + ' xmm0, ' + srcRef);
        this.emit(mn + ' ' + dstRef + ', xmm0');
        return;
      }
      const tmp = sz === 1 ? 'cl' : sz === 2 ? 'cx' : sz === 8 ? 'rcx' : 'ecx';
      this.emit('mov ' + tmp + ', ' + srcRef);
      this.emit('mov ' + dstRef + ', ' + tmp);
    });
    this.emit('mov eax, 0', '结构体赋值完成');
  };

  /* --- 函数调用 --- */
  Gen.prototype.genCall = function (n) {
    const name = n.name;
    const args = n.args || [];
    if (['printf', 'puts', 'putchar', 'exit'].indexOf(name) >= 0) return this.genBuiltin(n);

    const sig = this.sigs.get(name);
    if (!sig) {
      throw new Error('未定义的函数 "' + name + '()"。内置函数只有 printf / puts / putchar / exit，' +
        '自定义函数需要先在代码里定义或声明');
    }
    if (args.length !== sig.params.length) {
      throw new Error(name + '() 需要 ' + sig.params.length + ' 个参数，实际给了 ' + args.length + ' 个（第 ' + (n.line || '?') + ' 行）');
    }
    const N = args.length;
    // 1) 逐个求值压栈
    args.forEach((a, k) => {
      if (isFloat(this.t(a))) {
        this.genFloat(a);
        this.emit('sub rsp, 8');
        this.emit('movsd QWORD PTR [rsp], xmm0');
      } else {
        this.genInt(a);
        this.emit('push rax');
      }
    });
    // 2) 顺序装入寄存器
    let gi = 0, xi = 0;
    const notes = [];
    for (let k = 0; k < N; k++) {
      const off = 8 * (N - 1 - k);
      const at = 'QWORD PTR [rsp' + (off ? '+' + off : '') + ']';
      const t = this.t(args[k]);
      if (isFloat(t)) {
        if (xi > 7) throw new Error('浮点参数最多 8 个（xmm0~xmm7）');
        this.emit('movsd xmm' + xi + ', ' + at);
        notes.push('参数 ' + (k + 1) + '（xmm' + xi + '）');
        xi++;
      } else {
        if (gi > 5) throw new Error('整数/指针参数最多 6 个（rdi/rsi/rdx/rcx/r8/r9）');
        const r = isWideT(t) ? GPR64[gi] : GPR32[gi];
        this.emit('mov ' + r + ', ' + at.replace('QWORD', isWideT(t) ? 'QWORD' : 'DWORD'));
        notes.push('参数 ' + (k + 1) + '（' + r + '）');
        gi++;
      }
    }
    if (N) this.emit('add rsp, ' + (8 * N));
    this.emit('call ' + name, '调用 ' + name + '()');
    return;
  };

  Gen.prototype.genBuiltin = function (n) {
    const name = n.name;
    const args = n.args || [];
    if (name === 'exit') {
      if (args[0]) this.genInt(args[0]); else this.emit('mov eax, 0');
      this.emit('mov edi, eax', '退出码');
      this.emit('call exit', '结束程序');
      return;
    }
    if (name === 'putchar') {
      if (!args.length) throw new Error('putchar 需要一个参数');
      if (isFloat(this.t(args[0]))) throw new Error('putchar 需要整数参数');
      this.genInt(args[0]);
      this.emit('mov edi, eax', '要输出的字符');
      this.emit('call putchar');
      return;
    }
    if (name === 'puts') {
      if (!args.length) throw new Error('puts 需要一个字符串参数');
      const t = this.t(args[0]);
      if (args[0].k === 'str') this.emit('lea rdi, [' + this.intern(args[0].v) + ']', '要输出的字符串');
      else if (isPtrLike(t)) { this.genInt(args[0]); this.emit('mov rdi, rax', '字符串地址'); }
      else throw new Error('puts 的参数必须是字符串');
      this.emit('call puts');
      return;
    }
    // printf
    if (!args.length) throw new Error('printf 至少需要一个格式串参数');
    if (args[0].k !== 'str') throw new Error('printf 的第一个参数必须是字符串字面量（本工具需要它来推导参数类型）');
    const fmt = args[0].v;
    const rest = args.slice(1);
    const N = rest.length;
    const ARG64 = ['rsi', 'rdx', 'rcx', 'r8', 'r9'];
    const ARG32 = ['esi', 'edx', 'ecx', 'r8d', 'r9d'];
    // 第一遍：只按类型规划参数去向（哪些进寄存器、哪些走栈），不发任何指令
    const plan = [];
    let S = 0, gi = 0, xi = 0;
    rest.forEach(a => {
      const t = this.t(a);
      if (isFloat(t)) {
        if (xi < 8) plan.push({ to: 'xreg', idx: xi++ });
        else { plan.push({ to: 'stack' }); S++; }
      } else if (gi < ARG64.length) plan.push({ to: 'ireg', idx: gi++ });
      else { plan.push({ to: 'stack' }); S++; }
    });
    // 第二遍：给每个参数分配落位。
    //   · 栈参数排在参数区最低处：[rsp+0]、[rsp+8]…（System V 规定）
    //   · 寄存器参数排在上面，只作为"求值中转槽"
    let sj = 0;
    plan.forEach((p, k) => {
      p.off = (p.to === 'stack') ? 8 * sj++ : 8 * (S + (N - 1 - k));
    });
    // 一次性把参数区按 16 字节对齐开出来：这样整个参数求值过程 rsp 始终保持
    // 16 对齐，参数里再套函数调用也不会违反 ABI（否则被调用方用 movaps 会崩）
    const AREA = (N + S) ? Math.ceil((8 * (N + S)) / 16) * 16 : 0;
    if (AREA) this.emit('sub rsp, ' + AREA, '参数区：' + (N + S) + ' 个参数，按 16 字节对齐');

    // 逐个求值，结果直接写进各自的槽位
    if (N) for (let k = 0; k < N; k++) {
      const off = plan[k].off;
      if (isFloat(this.t(rest[k]))) {
        this.genFloat(rest[k]);
        this.emit('movsd QWORD PTR [rsp+' + off + '], xmm0');
      } else {
        this.genInt(rest[k]);
        this.emit('mov QWORD PTR [rsp+' + off + '], rax');
      }
    }
    // 格式串指针放在参数求值之后，避免被函数调用覆盖
    this.emit('lea rdi, [' + this.intern(fmt) + ']', '第 1 个参数：格式串');
    // 再把寄存器参数从中转槽搬进寄存器
    for (let k = 0; k < N; k++) {
      const pl = plan[k];
      if (pl.to === 'xreg') {
        this.emit('movsd xmm' + pl.idx + ', QWORD PTR [rsp+' + pl.off + ']');
      } else if (pl.to === 'ireg') {
        const wide = isWideT(this.t(rest[k]));
        this.emit('mov ' + (wide ? ARG64[pl.idx] : ARG32[pl.idx]) + ', ' +
          (wide ? 'QWORD' : 'DWORD') + ' PTR [rsp+' + pl.off + ']');
      }
    }
    this.emit('mov eax, ' + xi, '可变参数：用到的向量寄存器个数');
    this.emit('call printf');
    if (AREA) this.emit('add rsp, ' + AREA, '回收参数区');
  };

  /* --- 条件跳转 --- */
  Gen.prototype.genCondJumpFalse = function (cond, label, note) {
    if (isFloat(this.t(cond))) {
      this.genFloat(cond);
      this.emit('xorpd xmm1, xmm1');
      this.emit('ucomisd xmm0, xmm1', '和 0.0 比较');
      this.emit('je ' + label, note);
      return;
    }
    if (cond && cond.k === 'bin' && CMP_SET[cond.op] && !isFloat(this.t(cond.l)) && !isFloat(this.t(cond.r))) {
      const wide = this.isWide(cond.l) || this.isWide(cond.r);
      this.genInt(cond.l);
      if (!wide && this.isLeaf(cond.r)) {
        this.emit('cmp eax, ' + this.leafOperand(cond.r));
      } else {
        this.emit('push rax');
        this.genInt(cond.r);
        this.emit(wide ? 'mov rcx, rax' : 'mov ecx, eax');
        this.emit('pop rax');
        this.emit('cmp ' + (wide ? 'rax, rcx' : 'eax, ecx'));
      }
      const tbl = cmpUnsigned(this.t(cond.l), this.t(cond.r)) ? CMP_NEG_U : CMP_NEG;
      this.emit(tbl[cond.op] + ' ' + label, note);
      return;
    }
    if (cond && cond.k === 'bin' && (cond.op === '&&' || cond.op === '||')) {
      if (cond.op === '&&') {
        this.genCondJumpFalse(cond.l, label);
        this.genCondJumpFalse(cond.r, label);
      } else {
        const Ltrue = this.newLabel();
        this.genCondJumpTrue(cond.l, Ltrue);
        this.genCondJumpFalse(cond.r, label);
        this.emitLabel(Ltrue);
      }
      return;
    }
    this.genInt(cond);
    this.emit('cmp ' + (this.isWide(cond) ? 'rax' : 'eax') + ', 0', note);
    this.emit('je ' + label);
  };

  Gen.prototype.genCondJumpTrue = function (cond, label) {
    if (cond && cond.k === 'bin' && (cond.op === '&&' || cond.op === '||')) {
      if (cond.op === '||') { this.genCondJumpTrue(cond.l, label); this.genCondJumpTrue(cond.r, label); }
      else {
        const Lfalse = this.newLabel();
        this.genCondJumpFalse(cond.l, Lfalse);
        this.genCondJumpTrue(cond.r, label);
        this.emitLabel(Lfalse);
      }
      return;
    }
    this.genInt(cond);
    this.emit('cmp ' + (this.isWide(cond) ? 'rax' : 'eax') + ', 0');
    this.emit('jne ' + label);
  };

  /* --- 语句 --- */
  Gen.prototype.genStmt = function (s) {
    if (!s) return;
    switch (s.k) {
      case 'empty': return;
      case 'block':
        this.pushScope();
        s.body.forEach(x => this.genStmt(x));
        this.popScope();
        return;
      case 'decl': {
        s.items.forEach(it => {
          const off = this.allocLocal(it.name, it.type);
          this.emit('', '; ' + typeName(it.type) + ' ' + it.name + (it.init || it.initList ? ' = ...' : '') + ';', 'gap');
          this.genInit(it, off, it.type);
        });
        return;
      }
      case 'expr':
        this.genExprStmt(s.e);
        return;
      case 'if': {
        const Lelse = this.newLabel(), Lend = this.newLabel();
        this.emit('', '; ── if 判断 ──', 'gap');
        this.genCondJumpFalse(s.c, Lelse, '条件不成立就跳到 else');
        this.genStmt(s.then);
        if (s.els) {
          this.emit('jmp ' + Lend, 'then 分支结束，跳过 else');
          this.emitLabel(Lelse, '; else 分支');
          this.genStmt(s.els);
          this.emitLabel(Lend);
        } else {
          this.emitLabel(Lelse);
        }
        return;
      }
      case 'while': {
        const Lstart = this.newLabel(), Lend = this.newLabel();
        this.emitLabel(Lstart, '; ── while 循环入口 ──');
        this.genCondJumpFalse(s.c, Lend, '条件不成立就退出循环');
        this.loopStack.push({ brk: Lend, cont: Lstart });
        this.genStmt(s.body);
        this.loopStack.pop();
        this.emit('jmp ' + Lstart, '回到循环开头');
        this.emitLabel(Lend, '; ── 循环结束 ──');
        return;
      }
      case 'dowhile': {
        const Lstart = this.newLabel(), Lend = this.newLabel(), Ltest = this.newLabel();
        this.emitLabel(Lstart, '; ── do-while 循环入口 ──');
        this.loopStack.push({ brk: Lend, cont: Ltest });
        this.genStmt(s.body);
        this.loopStack.pop();
        this.emitLabel(Ltest, '; 每轮结束处判断条件');
        this.genCondJumpTrue(s.c, Lstart, '条件成立继续循环');
        this.emitLabel(Lend, '; ── 循环结束 ──');
        return;
      }
      case 'for': {
        this.pushScope();
        if (s.init) {
          if (s.init.k === 'decl') this.genStmt(s.init);
          else this.genExprStmt(s.init);
        }
        const Lstart = this.newLabel(), Lend = this.newLabel(), Lstep = this.newLabel();
        this.emitLabel(Lstart, '; ── for 循环入口 ──');
        if (s.cond) this.genCondJumpFalse(s.cond, Lend, '条件不成立就退出循环');
        this.loopStack.push({ brk: Lend, cont: Lstep });
        this.genStmt(s.body);
        this.loopStack.pop();
        this.emitLabel(Lstep, '; ── 每轮结束的步进 ──');
        if (s.step) this.genExprStmt(s.step);
        this.emit('jmp ' + Lstart, '回到循环开头');
        this.emitLabel(Lend, '; ── 循环结束 ──');
        this.popScope();
        return;
      }
      case 'break': {
        const L = this.loopStack[this.loopStack.length - 1];
        if (!L) throw new Error('break 只能出现在循环或 switch 里（第 ' + s.line + ' 行）');
        this.emit('jmp ' + L.brk, 'break：跳出 ' + (L.isSwitch ? 'switch' : '循环'));
        return;
      }
      case 'switch': {
        const Lend = this.newLabel();
        const labels = s.cases.map(() => this.newLabel());
        const wide = isWideT(this.t(s.e));
        this.emit('', '; ── switch 分发 ──', 'gap');
        this.genInt(s.e);
        this.emit('mov r10, rax', '把 switch 的值暂存在 r10（下面逐个 case 比对）');
        let defIdx = -1;
        s.cases.forEach((c, i) => {
          if (!c.v) { defIdx = i; return; }
          const k = constValue(c.v);
          if (k !== null) {
            this.emit('cmp ' + (wide ? 'r10' : 'r10d') + ', ' + k, 'case ' + k + '：比对');
          } else {
            this.genInt(c.v);
            this.emit('cmp ' + (wide ? 'r10' : 'r10d') + ', ' + (wide ? 'rax' : 'eax'), 'case 值：比对');
          }
          this.emit('je ' + labels[i], '相等就跳到这个 case 的代码');
        });
        if (defIdx >= 0) this.emit('jmp ' + labels[defIdx], '都不匹配：走 default');
        else this.emit('jmp ' + Lend, '都不匹配：直接跳出 switch');
        const outer = this.loopStack[this.loopStack.length - 1];
        this.loopStack.push({ brk: Lend, cont: outer ? outer.cont : null, isSwitch: true });
        s.cases.forEach((c, i) => {
          this.emitLabel(labels[i], c.v ? '; case ' + constValue(c.v) + ' 分支' : '; default 分支');
          c.body.forEach(x => this.genStmt(x));
        });
        this.loopStack.pop();
        this.emitLabel(Lend, '; ── switch 结束 ──');
        return;
      }
      case 'continue': {
        const L = this.loopStack[this.loopStack.length - 1];
        if (!L) throw new Error('continue 只能出现在循环里（第 ' + s.line + ' 行）');
        this.emit('jmp ' + L.cont, 'continue：进入下一轮');
        return;
      }
      case 'return': {
        if (s.e) {
          if (isFloat(this.curRet)) this.genFloat(s.e);
          else this.genInt(s.e);
        } else if (!isFloat(this.curRet)) {
          this.emit('mov eax, 0');
        }
        this.emit('jmp ' + this.retLabel, '跳到函数出口');
        return;
      }
      default:
        throw new Error('不支持的语句类型 ' + s.k);
    }
  };

  Gen.prototype.genExprStmt = function (e) {
    if (!e) return;
    if (e.k === 'assign') { this.genAssign(e); return; }
    this.genInt(e);
  };

  // 按初始化列表把元素逐个写进栈上（支持二维数组）
  Gen.prototype.genInitListAt = function (off, type, list) {
    if (!type || type.k !== 'array') return;
    const elem = type.to;
    let used = 0;
    list.forEach((e, k) => {
      if (k >= type.n) return;
      used++;
      const eOff = off + k * elem.size;
      if (e && e.k === 'initlist') { this.genInitListAt(eOff, elem, e.list); return; }
      if (isFloat(elem)) {
        this.genFloat(e);
        this.emit((elem.k === 'float' ? 'movss' : 'movsd') + ' ' + this.memRef('rbp', eOff, elem.size) + ', xmm0');
      } else {
        this.genInt(e);
        this.emit('mov ' + this.memRef('rbp', eOff, Math.max(1, elem.size)) + ', ' + (elem.size === 1 ? 'al' : elem.size === 2 ? 'ax' : elem.size === 8 ? 'rax' : 'eax'));
      }
    });
    const rest = type.size - used * elem.size;
    if (rest > 0) this.zeroAt('rbp', off + used * elem.size, rest);
  };

  Gen.prototype.genInit = function (it, off, type) {
    // 数组 / 结构体：逐元素填初值
    if (type.k === 'array') {
      const elem = type.to;
      // char s[] = "hello"：逐字节写入，末尾自动补 '\0'
      if (it.init && it.init.k === 'str' && elem.k === 'char') {
        const bytes = [];
        for (let i = 0; i < it.init.v.length; i++) bytes.push(it.init.v.charCodeAt(i) & 0xff);
        bytes.push(0);
        for (let k = 0; k < type.n; k++) {
          this.emit('mov ' + this.memRef('rbp', -off + k, 1) + ', ' + (k < bytes.length ? bytes[k] : 0),
            k === bytes.length - 1 ? '末尾补 \\0，当字符串用' : '字符串 "' + it.init.v + '" 的第 ' + (k + 1) + ' 个字节');
        }
        return;
      }
      const list = it.initList || (it.init ? [it.init] : null);
      if (!list) { this.zeroAt('rbp', -off, type.size); return; }
      this.genInitListAt(-off, type, list);
      return;
    }
    if (type.k === 'struct') {
      const list = it.initList;
      if (!list) { this.zeroAt('rbp', -off, type.size); return; }
      list.forEach((e, k) => {
        const f = type.fields[k];
        if (!f) return;
        const fOff = -off + f.off;
        if (isFloat(f.type)) {
          this.genFloat(e);
          this.emit((f.type.k === 'float' ? 'movss' : 'movsd') + ' ' + this.memRef('rbp', fOff, f.type.size) + ', xmm0');
        } else if (f.type.k === 'struct') {
          throw new Error('结构体嵌套初始化暂不支持（第 ' + (it.line || '?') + ' 行）');
        } else {
          this.genInt(e);
          this.emit('mov ' + this.memRef('rbp', fOff, Math.max(1, f.type.size)) + ', ' + (f.type.size === 1 ? 'al' : f.type.size === 2 ? 'ax' : f.type.size === 8 ? 'rax' : 'eax'));
        }
      });
      const used = list.length ? type.fields[list.length - 1] : null;
      if (used) {
        const start = used.off + Math.max(1, used.type.size);
        if (type.size > start) this.zeroAt('rbp', -off + start, type.size - start);
      }
      return;
    }
    if (it.init && this.t(it.init).k === 'struct' && type.k === 'struct') {
      this.genStructCopy({ k: 'var', name: it.name, line: it.line }, it.init);
      return;
    }
    if (!it.init) {
      if (isFloat(type)) {
        this.emit('xorpd xmm0, xmm0');
        this.emit((type.k === 'float' ? 'movss' : 'movsd') + ' ' + this.localRef(off, type.size) + ', xmm0', '未初始化，先置 0 便于观察');
      } else {
        this.emit('mov ' + this.localRef(off, Math.max(1, type.size)) + ', 0', '未初始化，先置 0 便于观察');
      }
      return;
    }
    if (isFloat(type)) {
      this.genFloat(it.init);
      this.emit((type.k === 'float' ? 'movss' : 'movsd') + ' ' + this.localRef(off, type.size) + ', xmm0', typeName(type) + ' ' + it.name + ' = ...');
      return;
    }
    this.genInt(it.init);
    this.emit('mov ' + this.localRef(off, Math.max(1, type.size)) + ', ' + (type.size === 1 ? 'al' : type.size === 2 ? 'ax' : type.size === 8 ? 'rax' : 'eax'),
      typeName(type) + ' ' + it.name + ' = ...');
  };

  /* --- 函数 --- */
  Gen.prototype.compileFunc = function (fn) {
    this.scopes = [new Map()];
    this.frameOff = 0;
    this.funcName = fn.name;
    this.curRet = fn.ret;
    this.retLabel = '.Lret_' + fn.name;
    this.emit('', '; ═══ 函数 ' + fn.name + ' 开始 ═══', 'gap');
    this.emitLabel(fn.name, '; 函数入口');
    this.emit('push rbp', '序言：保存调用者的栈基址');
    this.emit('mov rbp, rsp', '序言：建立本函数的栈帧');
    const frameIdx = this.out.length;
    this.emit('sub rsp, @FRAME@', '序言：在栈上开辟局部变量空间');

    // 参数：从寄存器搬到栈上（保存到本地）
    let gi = 0, xi = 0;
    fn.params.forEach(p => {
      const off = this.allocLocal(p.name, p.type);
      if (isFloat(p.type)) {
        this.emit('movsd ' + this.localRef(off, 8) + ', xmm' + xi, '参数 ' + p.name + ' 来自 xmm' + xi);
        xi++;
      } else {
        const wide = isWideT(p.type) || p.type.k === 'ptr';
        this.emit('mov ' + this.localRef(off, Math.max(1, p.type.size)) + ', ' + (wide ? GPR64[gi] : GPR32[gi]), '参数 ' + p.name + ' 来自 ' + (wide ? GPR64[gi] : GPR32[gi]));
        gi++;
      }
    });

    // 全局指针这类需要「地址」的初值，在 main 入口补一次赋值
    if (fn.name === 'main' && this.pendingGlobal.length) {
      this.emit('', '; ── 全局指针初始化 ──', 'gap');
      this.pendingGlobal.forEach(p => {
        if (p.kind === 'str') this.emit('lea rax, [' + this.intern(p.value) + ']', '全局指针 ' + p.name + ' 指向字符串常量');
        else this.emit('lea rax, [' + p.value + ']', '全局指针 ' + p.name + ' 指向 ' + p.value);
        this.emit('mov QWORD PTR [' + p.name + '], rax', '写回全局指针 ' + p.name);
      });
    }

    fn.body.body.forEach(s => this.genStmt(s));

    const last = fn.body.body[fn.body.body.length - 1];
    const endsWithReturn = last && (last.k === 'return');
    if (fn.name === 'main' && !endsWithReturn && !isFloat(fn.ret)) this.emit('mov eax, 0', '默认返回 0');
    this.emitLabel(this.retLabel, '; ── 函数出口 ──');
    this.emit('leave', '尾声：恢复 rsp 和 rbp');
    this.emit('ret', '尾声：返回到调用者');
    this.emit('', '', 'gap');

    const frameSize = Math.max(16, Math.ceil(this.frameOff / 16) * 16);
    this.out[frameIdx].text = 'sub rsp, ' + frameSize;
    return frameSize;
  };

  // 全局变量的数据段输出（.data 段，可执行文件里就是这样存全局量的）
  Gen.prototype.emitGlobalData = function (g, lines) {
    const T = g.type;
    const innermost = t => { let x = t; while (x && x.k === 'array') x = x.to; return x || SCALAR.int; };
    const unitOf = t => (t.size === 1 ? 'byte' : t.size === 2 ? 'word' : t.size === 8 ? 'quad' : 'long');
    lines.push({ text: g.name + ':', kind: 'label' });

    if (T.k === 'struct') {
      lines.push({ text: '    .zero ' + T.size, kind: 'code' });
      return;
    }

    if (T.k === 'array') {
      if (g.init && g.init.k === 'str') {
        const txt = g.init.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        lines.push({ text: '    .string "' + txt + '"', kind: 'code' });
        const pad = T.size - (g.init.v.length + 1);
        if (pad > 0) lines.push({ text: '    .zero ' + pad, kind: 'code' });
        return;
      }
      if (!g.initList) { lines.push({ text: '    .zero ' + T.size, kind: 'code' }); return; }
      const out = [];
      const flat = (type, list) => {
        if (!type || type.k !== 'array') return;
        const elem = type.to;
        const arr = list || [];
        for (let i = 0; i < type.n; i++) {
          const e = arr[i];
          if (elem.k === 'array') flat(elem, e && e.k === 'initlist' ? e.list : null);
          else {
            const v = e && e.k !== 'initlist' ? constValue(e) : 0;
            out.push(v === null ? 0 : v);
          }
        }
      };
      flat(T, g.initList);
      const unit = unitOf(innermost(T));
      for (let i = 0; i < out.length; i += 8) {
        lines.push({ text: '    .' + unit + ' ' + out.slice(i, i + 8).join(', '), kind: 'code' });
      }
      return;
    }

    if (isFloat(T)) {
      const v = g.init ? constValue(g.init) : 0;
      const num = v === null ? 0 : v;
      if (T.k === 'float') {
        const dv = new DataView(new ArrayBuffer(4));
        dv.setFloat32(0, num, true);
        lines.push({ text: '    .long 0x' + dv.getUint32(0, true).toString(16), kind: 'code' });
      } else {
        lines.push({ text: '    .quad 0x' + f64Bits(num).toString(16), kind: 'code' });
      }
      return;
    }

    const v = g.init ? constValue(g.init) : 0;
    let num = v === null ? 0 : v;
    const sz = Math.max(1, T.size);
    if (sz === 1) num = num & 0xff;
    lines.push({ text: '    .' + unitOf(T) + ' ' + num, kind: 'code' });
  };

  Gen.prototype.render = function () {
    const lines = [];
    lines.push({ text: '; 由 C 代码编译生成的 x86-64 汇编（Intel 语法，未优化风格）', kind: 'comment' });
    lines.push({ text: '; 结构：push rbp → mov rbp, rsp → sub rsp, N 开栈帧；结束时 leave → ret', kind: 'comment' });
    lines.push({ text: '', kind: 'gap' });
    this.out.forEach(l => lines.push(l));
    if (this.globals.length) {
      lines.push({ text: '', kind: 'gap' });
      lines.push({ text: '    .section .data', kind: 'code' });
      lines.push({ text: '; ── 数据段：全局变量（程序整个生命周期都在） ──', kind: 'comment' });
      this.globals.forEach(g => this.emitGlobalData(g, lines));
      lines.push({ text: '    .section .text', kind: 'code' });
    }
    if (this.strs.length || this.f64s.length) {
      lines.push({ text: '', kind: 'gap' });
      lines.push({ text: '    .section .rodata', kind: 'code' });
      lines.push({ text: '; ── 只读数据段：字符串与浮点常量 ──', kind: 'comment' });
      this.strs.forEach(s => {
        lines.push({ text: s.label + ':', kind: 'label' });
        lines.push({
          text: '    .string "' + s.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"',
          kind: 'code'
        });
      });
      this.f64s.forEach(f => {
        lines.push({ text: f.label + ':', kind: 'label' });
        lines.push({ text: '    .quad 0x' + f.bits.toString(16), kind: 'code' });
        lines.push({ text: '; double ' + f.value, kind: 'comment' });
      });
    }
    const PAD = 40;
    return lines.map(l => {
      if (l.kind === 'gap') return '';
      if (!l.comment) return l.text;
      const c = l.comment[0] === ';' ? l.comment : '; ' + l.comment;
      if (l.kind === 'label') return (l.text + ' '.repeat(Math.max(0, 18 - l.text.length)) + '  ' + c).replace(/\s+$/, '');
      if (l.kind === 'comment') return l.text;
      return l.text + ' '.repeat(Math.max(2, PAD - l.text.length)) + c;
    }).join('\n');
  };

  /* ============================================================
   * 4. 对外接口
   * ============================================================ */
  function collectSigs(fns) {
    const sigs = new Map();
    fns.forEach(fn => {
      if (fn.k !== 'func' && fn.k !== 'proto') return;
      if (sigs.has(fn.name)) return;
      sigs.set(fn.name, { name: fn.name, ret: fn.ret, params: fn.params });
    });
    return sigs;
  }

  function compile(src) {
    try {
      const toks = tokenize(src || '');
      const parser = new Parser(toks);
      const ast = parser.parseProgram();
      const gen = new Gen();
      gen.sigs = collectSigs(ast);
      ast.filter(f => f.k === 'gvar').forEach(g => gen.declareGlobal(g));
      const ordered = ast.filter(f => f.k === 'func')
        .sort((a, b) => (a.name === 'main' ? -1 : 0) - (b.name === 'main' ? -1 : 0));
      if (!ordered.some(f => f.name === 'main')) throw new Error('缺少 main() 函数：程序需要从这里开始执行');
      ordered.forEach(fn => gen.compileFunc(fn));
      const asm = gen.render();
      const typeByName = new Map();
      gen.varMap.forEach(v => { if (!typeByName.has(v.offset)) typeByName.set(v.offset, v.type); });
      return {
        ok: true,
        asm: asm,
        ast: ast,
        varMap: gen.varMap,
        types: typeByName,
        warnings: gen.warn
      };
    } catch (err) {
      return { ok: false, error: err.message, asm: '' };
    }
  }

  const API = { compile: compile, tokenize: tokenize };
  global.C2ASM = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
