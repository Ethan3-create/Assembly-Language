/* ============================================================
 * 测试 7：汇编 → C 反编译
 *   · 手写教学风格汇编（无 .text、带标签、循环、函数、浮点）
 *   · C → 汇编 → C 往返
 * ============================================================ */
const C2 = require('../js/c2asm.js');
const VM = require('../js/vm.js');
const DEC = require('../js/decompile.js');
const D = require('../js/data.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, info) {
  if (cond) { pass++; return; }
  fail++; fails.push(name + (info ? ' → ' + info : ''));
}
function bad(name, info) { fail++; fails.push(name + ' → ' + info); }

function dec(asmSrc, ctx) {
  const p = VM.assemble(asmSrc);
  if (!p.ok) return { err: '汇编失败：' + (p.errors || []).join(' | ') };
  if (p.errors && p.errors.length) return { err: '汇编告警：' + p.errors.join(' | ') };
  try { return { d: DEC.decompile(p, ctx || {}) }; }
  catch (e) { return { err: '反编译异常：' + e.message }; }
}
function has(code, s, name) { ok(name, code.indexOf(s) >= 0, '期望出现 ' + JSON.stringify(s) + '，实际：\n' + code); }
function no(raw, bad, name) { ok(name, raw.indexOf(bad) < 0, '不应出现 ' + JSON.stringify(bad) + '，实际：\n' + raw); }

/* ---------- 1. 基础形态 ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], 5',
    ' mov eax, DWORD PTR [rbp-4]', ' add eax, 3', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('基础加减', r.err);
  else {
    has(r.d.code, 'int main()', '基础：函数签名');
    has(r.d.code, 'return v1 + 3;', '基础：return 表达式');
    no(r.d.code, '[rbp-4]', '基础：不残留栈偏移');
  }
}

/* ---------- 2. if / else ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], 7',
    ' cmp DWORD PTR [rbp-4], 5', ' jle .L1', ' mov DWORD PTR [rbp-8], 1', ' jmp .L2',
    '.L1:', ' mov DWORD PTR [rbp-8], 2', '.L2:', ' mov eax, DWORD PTR [rbp-8]', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('if/else', r.err);
  else {
    has(r.d.code, 'if (v1 > 5)', 'if/else：条件取反正确');
    has(r.d.code, '} else {', 'if/else：有两支');
  }
}

/* ---------- 3. while ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], 0',
    '.L2:', ' cmp DWORD PTR [rbp-4], 10', ' jge .L3', ' add DWORD PTR [rbp-4], 1',
    ' jmp .L2', '.L3:', ' mov eax, DWORD PTR [rbp-4]', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('while', r.err);
  else {
    has(r.d.code, 'while (v1 < 10)', 'while：条件与出口方向正确');
  }
}

/* ---------- 4. do-while（条件分支往回跳） ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], 0',
    '.L2:', ' add DWORD PTR [rbp-4], 1', ' cmp DWORD PTR [rbp-4], 3', ' jl .L2',
    ' mov eax, DWORD PTR [rbp-4]', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('do-while', r.err);
  else {
    has(r.d.code, 'do {', 'do-while：识别为 do');
    has(r.d.code, '} while (v1 < 3);', 'do-while：条件正确');
  }
}

/* ---------- 5. 多函数 + 参数 ---------- */
{
  const r = dec(['add2:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], edi',
    ' mov DWORD PTR [rbp-8], esi', ' mov eax, DWORD PTR [rbp-4]', ' add eax, DWORD PTR [rbp-8]',
    ' pop rbp', ' ret', 'main:', ' push rbp', ' mov rbp, rsp', ' mov edi, 3', ' mov esi, 4',
    ' call add2', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('多函数', r.err);
  else {
    has(r.d.code, 'int add2(int v1, int v2)', '多函数：参数还原');
    has(r.d.code, 'return add2(3, 4);', '多函数：调用与返回值');
    no(r.d.code, 'edi', '多函数：不残留 edi');
  }
}

/* ---------- 6. 寄存器型参数（没有存栈） ---------- */
{
  const r = dec(['square:', ' mov eax, edi', ' imul eax, eax', ' ret',
    'main:', ' push rbp', ' mov rbp, rsp', ' mov edi, 7', ' call square', ' pop rbp', ' ret'].join('\n'));
  if (r.err) bad('寄存器参数', r.err);
  else {
    has(r.d.code, 'int square(int a1)', '寄存器参数：命名为 a1');
    has(r.d.code, 'return a1 * a1;', '寄存器参数：表达式正确');
  }
}

/* ---------- 7. 浮点 ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' movsd xmm0, QWORD PTR .LC0[rip]',
    ' movsd QWORD PTR [rbp-8], xmm0', ' movsd xmm0, QWORD PTR [rbp-8]', ' addsd xmm0, xmm0',
    ' pop rbp', ' ret', '.section .rodata', '.LC0:', ' .quad 0x40091eb851eb851f'].join('\n'));
  if (r.err) bad('浮点', r.err);
  else {
    has(r.d.code, 'double v2;', '浮点：变量声明为 double');
    has(r.d.code, 'v2 + v2', '浮点：运算被符号化');
  }
}

/* ---------- 8. 数组下标（lea + imul + add） ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' sub rsp, 32',
    ' mov DWORD PTR [rbp-16], 10', ' mov DWORD PTR [rbp-4], 1',
    ' lea rax, [rbp-16]', ' mov ecx, DWORD PTR [rbp-4]', ' movsxd rcx, ecx', ' imul rcx, rcx, 4',
    ' add rax, rcx', ' mov eax, DWORD PTR [rax]', ' leave', ' ret'].join('\n'));
  if (r.err) bad('数组下标', r.err);
  else {
    has(r.d.code, 'v4[v1]', '数组下标：还原成 a[i]');
    no(r.d.code, '[rax', '数组下标：不残留 [rax');
  }
}

/* ---------- 9. 结构体指针 + 变址访问 ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' sub rsp, 16',
    ' mov DWORD PTR [rbp-4], 0', '.L2:', ' cmp DWORD PTR [rbp-4], 3', ' jge .L3',
    ' lea rax, [arr]', ' mov ecx, DWORD PTR [rbp-4]', ' movsxd rcx, ecx',
    ' mov eax, DWORD PTR [rax+rcx*4]', ' add DWORD PTR [rbp-8], eax',
    ' add DWORD PTR [rbp-4], 1', ' jmp .L2', '.L3:', ' mov eax, DWORD PTR [rbp-8]', ' leave', ' ret',
    '.section .data', 'arr:', ' .long 5, 6, 7'].join('\n'));
  if (r.err) bad('全局数组', r.err);
  else {
    has(r.d.code, 'int arr[3] = {5, 6, 7};', '全局数组：数据段还原');
    has(r.d.code, 'arr[v1]', '全局数组：变址寻址还原');
  }
}

/* ---------- 10. 通过栈传参的 printf ---------- */
{
  const r = dec(['main:', ' push rbp', ' mov rbp, rsp', ' mov DWORD PTR [rbp-4], 42',
    ' mov eax, DWORD PTR [rbp-4]', ' push rax', ' lea rdi, [.LC0]',
    ' mov esi, DWORD PTR [rsp+0]', ' mov eax, 0', ' call printf', ' add rsp, 8',
    ' mov eax, 0', ' pop rbp', ' ret', '.section .rodata', '.LC0:', ' .string "x = %d\\n"'].join('\n'));
  if (r.err) bad('栈传参 printf', r.err);
  else {
    has(r.d.code, 'printf("x = %d\\n", v1);', '栈传参：参数归属正确');
    no(r.d.code, 'tmp', '栈传参：不出现 tmp');
  }
}

/* ---------- 11. 裸代码 / 无标签 ---------- */
{
  const r = dec(['mov eax, 1', 'add eax, 2', 'ret'].join('\n'));
  if (r.err) bad('裸代码', r.err);
  else has(r.d.code, 'return 3;', '裸代码：常量折叠');
}

/* ---------- 12. C → 汇编 → C 往返 ---------- */
function roundTrip(name, csrc, expects) {
  const c = C2.compile(csrc);
  if (!c.ok) { bad(name, '编译失败：' + c.error); return; }
  const p = VM.assemble(c.asm);
  if (!p.ok || (p.errors && p.errors.length)) { bad(name, '汇编失败：' + (p.errors || []).join(' | ')); return; }
  const byFunc = new Map();
  (c.varMap || []).forEach(v => {
    if (!byFunc.has(v.func)) byFunc.set(v.func, { names: new Map(), types: new Map(), sizes: new Map() });
    const e = byFunc.get(v.func);
    e.names.set(v.offset, v.name); e.types.set(v.offset, v.type); e.sizes.set(v.offset, v.size);
  });
  let d;
  try { d = DEC.decompile(p, { varMapByFunc: byFunc }); }
  catch (e) { bad(name, '反编译异常：' + e.message); return; }
  const code = d.code;
  (expects || []).forEach(s => has(code, s, name + '：' + s));
  no(code, '[rbp', name + '：不残留 [rbp');
  no(code, 'xmm0 =', name + '：不残留 xmm 赋值');
  no(code, 'edi', name + '：不残留 edi');
}

roundTrip('往返·加法', '#include <stdio.h>\nint main(){ int a=5; int b=3; int c=a+b; printf("c = %d\\n", c); return 0; }',
  ['int main()', 'c = a + b;', 'printf("c = %d\\n", c);']);

roundTrip('往返·循环', '#include <stdio.h>\nint main(){ int s=0; int i; for(i=1;i<=4;i++){ s+=i; } printf("%d\\n", s); return 0; }',
  ['while (i <= 4)', 's = s + i;']);

roundTrip('往返·指针参数', '#include <stdio.h>\nvoid inc(int *p){ *p = *p + 1; }\nint main(){ int x=1; inc(&x); printf("%d\\n", x); return 0; }',
  ['void inc(int *p)', '*p = *p + 1;', 'inc(&x);']);

roundTrip('往返·数组', '#include <stdio.h>\nint main(){ int a[3]={1,2,3}; int s=0; for(int i=0;i<3;i++) s+=a[i]; printf("%d\\n", s); return 0; }',
  ['int a[3];', 's = s + a[i];']);

roundTrip('往返·浮点', '#include <stdio.h>\nint main(){ double d=2.5; double e=d*2; printf("%.2f\\n", e); return 0; }',
  ['double d;', 'double e;', 'e = d * ']);

roundTrip('往返·unsigned', '#include <stdio.h>\nint main(){ unsigned u=4000000000u; printf("%u\\n", u/3); return 0; }',
  ['int main()']);

/* ---------- 汇总 ---------- */
console.log('\n汇编→C 反编译测试：通过 ' + pass + ' / ' + (pass + fail));
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach((f, i) => console.log((i + 1) + '. ' + f));
  process.exitCode = 1;
}
