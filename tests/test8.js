/* ============================================================
 * 测试 8：代码检查 / 报错系统（js/diagnose.js）
 * ============================================================ */
const C2 = require('../js/c2asm.js');
const VM = require('../js/vm.js');
const DIAG = require('../js/diagnose.js');
const D = require('../js/data.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, info) {
  if (cond) { pass++; return; }
  fail++; fails.push(name + (info ? ' → ' + info : ''));
}

function run(asmSrc, ctx) {
  const p = VM.assemble(asmSrc);
  return DIAG.check(p, Object.assign({ srcText: asmSrc }, ctx || {}));
}
const lv = (r, level) => r.issues.filter(i => i.level === level);
const find = (r, level, kw) => lv(r, level).find(i => i.msg.indexOf(kw) >= 0);

/* ---------- 1. 正常代码不应报错 ---------- */
{
  let bad = 0, total = 0;
  D.EXAMPLES_C.forEach(e => {
    const c = C2.compile(e.code);
    if (!c.ok) { fail++; fails.push('示例编译失败：' + e.name); return; }
    const p = VM.assemble(c.asm);
    const r = DIAG.check(p, { srcText: c.asm, varMapRaw: c.varMap });
    total++;
    if (r.counts.error || r.counts.warn) {
      bad++;
      fails.push('示例有误报：' + e.name + ' → ' + r.issues.filter(i => i.level !== 'info').map(i => i.msg).join(' / '));
    }
  });
  ok('全部 C 示例编译产物零错误零警告（共 ' + total + ' 个）', bad === 0, bad + ' 个示例有误报');
  D.EXAMPLES_ASM.forEach(e => {
    const p = VM.assemble(e.code);
    const r = DIAG.check(p, { srcText: e.code });
    ok('汇编示例无错误：' + e.name, r.counts.error === 0,
      r.issues.filter(i => i.level === 'error').map(i => i.msg).join(' / '));
  });
}

/* ---------- 2. 指令拼错 / 操作数个数 ---------- */
{
  const r = run('main:\n    push rbp\n    movv eax, 5\n    ret\n');
  const e = find(r, 'error', '不认识的指令');
  ok('拼错指令被报错', !!e, JSON.stringify(r.issues));
  ok('报错定位到第 3 行', e && e.line === 3, e && String(e.line));
  ok('报错带修复建议', e && e.fix.length > 8, e && e.fix);
  ok('报错带出错代码片段', e && e.code === 'movv eax, 5', e && e.code);
}
{
  const r = run('main:\n    mov eax\n    ret\n');
  ok('操作数个数不对被报错', !!find(r, 'error', '需要 2 个操作数'), JSON.stringify(r.issues));
}

/* ---------- 3. 结构性错误 ---------- */
{
  const r = run('main:\n    mov DWORD PTR [rbp-4], DWORD PTR [rbp-8]\n    ret\n');
  ok('内存→内存 mov 被报错', !!find(r, 'error', '不能直接把内存搬到内存'));
}
{
  const r = run('main:\n    mov ecx, 0\n    idiv ecx\n    ret\n');
  ok('寄存器除零不误报（静态看不出）', !find(r, 'error', '除数是 0'));
}
{
  const r = run('main:\n    idiv 0\n    ret\n');
  ok('常量除零被报错', !!find(r, 'error', '除数是 0'));
}
{
  const r = run('main:\n    mov eax, DWORD PTR [rbp+8]\n    ret\n');
  ok('[rbp+8] 读返回地址被报错', !!find(r, 'error', '返回地址'));
}

/* ---------- 4. 警告 ---------- */
{
  const r = run('main:\n    push rbp\n    mov rbp, rsp\n    sub rsp, 16\n    mov eax, 1\n    mov ebx, 2\n    add eax, rbx\n    leave\n    ret\n');
  ok('寄存器宽度不一致被警告', !!find(r, 'warn', '宽度不同'), JSON.stringify(r.issues));
}
{
  const r = run('main:\n    mov DWORD PTR [rbp-4], rax\n    ret\n');
  ok('内存宽度与寄存器不一致被警告', !!find(r, 'warn', '宽度'));
}
{
  const r = run('f:\n    push rbp\n    mov rbp, rsp\n    sub rsp, 16\n    push rax\n    ret\n');
  ok('返回前栈没恢复被警告', !!find(r, 'warn', '栈指针没恢复'), JSON.stringify(r.issues));
}
{
  const r = run('f:\n    push rbp\n    mov rbp, rsp\n    sub rsp, 16\n    push rax\n    call printf\n    add rsp, 8\n    leave\n    ret\n');
  ok('call 前 rsp 没 16 字节对齐被警告', !!find(r, 'warn', '16 字节对齐'), JSON.stringify(r.issues));
}
{
  const r = run('f:\n    push rbp\n    mov rbp, rsp\n    sub rsp, 16\n    call printf\n    leave\n    ret\n');
  ok('对齐正确的调用不报警告', !find(r, 'warn', '16 字节对齐'), JSON.stringify(r.issues.filter(i => i.level === 'warn').map(i => i.msg)));
}

/* ---------- 5. 提示 ---------- */
{
  const r = run('main:\n    jmp main\n');
  ok('jmp 到自身给提示', !!find(r, 'info', '死循环'), JSON.stringify(r.issues));
}
{
  const c = C2.compile('int main() { int unused = 1; int b = 2; printf("%d\\n", b); return 0; }');
  const p = VM.assemble(c.asm);
  const r = DIAG.check(p, { srcText: c.asm, varMapRaw: c.varMap });
  ok('只写不读的变量给提示', !!find(r, 'info', 'unused'), JSON.stringify(r.issues.filter(i => i.level === 'info').map(i => i.msg)));
  ok('用到的变量不被误报', !find(r, 'info', '"b"'), JSON.stringify(r.issues.filter(i => i.level === 'info').map(i => i.msg)));
}

/* ---------- 6. C 编译失败 ---------- */
{
  const c = C2.compile('int main() { return yyy; }');
  ok('未定义变量的 C 代码确实编译失败', !c.ok, JSON.stringify(c).slice(0, 120));
  const r = DIAG.check(null, { srcText: 'int main() { return yyy; }', cError: c.error });
  const e = find(r, 'error', 'C 编译失败');
  ok('C 编译失败被报成错误', !!e, JSON.stringify(r.issues));
  ok('C 错误带行号', e && e.line === 1, e && String(e.line));
  ok('C 错误标记来源为 c', e && e.src === 'c', e && e.src);
  ok('C 错误带修复建议', e && e.fix.length > 10);
}

/* ---------- 7. 运行期错误 ---------- */
{
  const r = DIAG.check(VM.assemble('main:\n    idiv 0\n    ret\n'), {
    srcText: 'main:\n    idiv 0\n    ret\n',
    runtimeError: { msg: '除以零', line: 2 }
  });
  ok('运行期错误被并入问题列表', !!find(r, 'error', '运行时出错'));
}

/* ---------- 8. 排序与统计 ---------- */
{
  const r = run('main:\n    movv eax, 5\n    add eax, rbx\n    jmp main\n');
  ok('问题按 错误→警告→提示 排序', r.issues.length >= 2 && r.issues[0].level === 'error',
    JSON.stringify(r.issues.map(i => i.level)));
  ok('统计数目与列表一致',
    r.counts.error + r.counts.warn + r.counts.info === r.issues.length,
    JSON.stringify(r.counts) + ' vs ' + r.issues.length);
}

console.log('\n代码检查 / 报错系统测试：通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('未通过：');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
