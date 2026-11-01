// 内置函数覆盖测试：printf / puts / putchar / exit
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const C2 = require(path.join(ROOT, 'js', 'c2asm.js'));

let pass = 0, fail = 0; const fails = [];
function run(src) {
  const r = C2.compile(src);
  if (!r.ok) return { err: '编译失败：' + r.error };
  const p = VM.assemble(r.asm);
  if (!p.ok) return { err: '汇编失败：' + p.errors.join(' | ') };
  const m = new VM.Machine(p);
  let g = 0;
  while (!m.halted && g++ < 300000) m.step();
  return { out: m.output, err: m.errorMsg || null };
}
function t(name, src, expect, only) {
  const r = run(src);
  if (r.err) { fail++; fails.push(name + ' → ' + r.err); return; }
  if (String(r.out).indexOf(expect) >= 0) { pass++; return; }
  fail++; fails.push(name + ' → 期望含 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(r.out));
}
const H = '#include <stdio.h>\nint main(){\n';
const END = '\n return 0;\n}';

/* printf 转换符 */
t('printf %d 正负', H + 'printf("%d %d\\n", 42, -7);' + END, '42 -7');
t('printf %c', H + 'printf("%c%c%c", 65, 66, 67);' + END, 'ABC');
t('printf %x/%X', H + 'printf("%x %X", 255, 255);' + END, 'ff FF');
t('printf %u 无符号', H + 'printf("%u", 4000000000u);' + END, '4000000000');
t('printf %s 字面量', H + 'printf("%s!", "hi");' + END, 'hi!');
t('printf %s 变量指针', H + 'char *p = "ok"; printf("<%s>", p);' + END, '<ok>');
t('printf %f 默认 6 位', H + 'printf("%f", 3.14);' + END, '3.140000');
t('printf %.2f 精度', H + 'printf("%.2f", 3.14159);' + END, '3.14');
t('printf %e 科学计数', H + 'printf("%e", 1234.5678);' + END, '1.234568e+3');
t('printf %g 自动', H + 'printf("%g", 0.00001234);' + END, '1.234e-5');
t('printf %p 指针', H + 'int x = 0; int *p = &x; printf("%p", p);' + END, '0x');
t('printf 宽度 %5d', H + 'printf("[%5d]", 42);' + END, '[   42]');
t('printf 左对齐 %-5d', H + 'printf("[%-5d]", 42);' + END, '[42   ]');
t('printf 补零 %05d', H + 'printf("[%05d]", 42);' + END, '[00042]');
t('printf %% 转义', H + 'printf("100%%");' + END, '100%');
t('printf %ld 长整型', H + 'long v = 1234567890123L; printf("%ld", v);' + END, '1234567890123');
t('printf 无参数只有格式串', H + 'printf("hello");' + END, 'hello');
t('printf 5 个整数（边界）', H + 'printf("%d%d%d%d%d", 1,2,3,4,5);' + END, '12345');
t('printf 8 个整数（栈传参）', H + 'printf("%d%d%d%d%d%d%d%d", 1,2,3,4,5,6,7,8);' + END, '12345678');
t('printf 10 个浮点（栈传参）', H + 'printf("%.0f%.0f%.0f%.0f%.0f%.0f%.0f%.0f%.0f%.0f", 1.0,2.0,3.0,4.0,5.0,6.0,7.0,8.0,9.0,10.0);' + END, '12345678910');
t('printf 整数浮点混合超限', H + 'printf("%d %.1f %d %.1f %d %.1f %d %.1f %d %.1f %d %.1f", 1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5);' + END, '1 1.5 2 2.5 3 3.5 4 4.5 5 5.5 6 6.5');
t('printf 结果存在变量里', H + 'int n = printf("abc"); printf("|%d", n);' + END, 'abc|3');

/* puts / putchar */
t('puts 基本', H + 'puts("hello world");' + END, 'hello world\n');
t('puts 自带换行', H + 'puts("a"); puts("b");' + END, 'a\nb\n');
t('puts 变量指针', H + 'char *s = "vv"; puts(s);' + END, 'vv\n');
t('putchar 字符', H + 'putchar(72); putchar(105); putchar(33);' + END, 'Hi!');
t('putchar 换行 10', H + 'putchar(65); putchar(10); putchar(66);' + END, 'A\nB');
t('putchar 循环打印', H + 'int i; for (i = 0; i < 5; i++) putchar(48 + i);' + END, '01234');
t('putchar 结果', H + 'int c = putchar(90); printf("|%d", c);' + END, 'Z|90');

/* exit */
t('exit 提前结束', H + 'printf("before"); exit(0); printf("after");' + END, 'before');
t('exit 不打印 after', H + 'printf("x"); exit(1); printf("SHOULD_NOT_APPEAR");' + END, 'x');
t('exit 在循环里', H + 'int i; for (i = 0; i < 10; i++) { if (i == 3) exit(0); printf("%d", i); }' + END, '012');
t('exit 在函数里', '#include <stdio.h>\nvoid die(){ exit(0); }\nint main(){\n printf("a"); die(); printf("b");' + END, 'a');

/* 混合与边界 */
t('puts 与 printf 混用', H + 'puts("L1"); printf("L2\\n"); puts("L3");' + END, 'L1\nL2\nL3\n');
t('printf 里调函数', '#include <stdio.h>\nint sq(int x){ return x * x; }\nint main(){\n printf("%d", sq(7));' + END, '49');
t('printf 表达式参数', H + 'int a = 3, b = 4; printf("%d %.2f", a + b, (a + b) / 2.0);' + END, '7 3.50');

console.log('内置函数测试：通过 ' + pass + ' / ' + (pass + fail));
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  · ' + f)); process.exit(1); }
