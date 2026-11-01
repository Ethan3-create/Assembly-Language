// unsigned / 新补齐能力的回归测试
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const C2 = require(path.join(ROOT, 'js', 'c2asm.js'));
const D = require(path.join(ROOT, 'js', 'data.js'));

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
function t(name, src, expect) {
  const r = run(src);
  if (r.err) { fail++; fails.push(name + ' → ' + r.err); return; }
  if (String(r.out).indexOf(expect) >= 0) { pass++; return; }
  fail++; fails.push(name + ' → 期望含 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(r.out));
}
const H = '#include <stdio.h>\nint main(){\n';
const END = '\n return 0;\n}';

/* unsigned 的语义 */
t('unsigned 能存 40 亿', H + 'unsigned u = 4000000000u; printf("%u", u);' + END, '4000000000');
t('unsigned 无符号比较', H + 'unsigned a = 1, b = 4000000000u; printf("%d %d", a < b, b < a);' + END, '1 0');
t('unsigned 无符号除法', H + 'unsigned u = 4000000000u; printf("%u %u", u / 3, u % 7);' + END, '1333333333 3');
t('unsigned 是逻辑右移', H + 'unsigned u = 4000000000u; printf("%u", u >> 4);' + END, '250000000');
t('unsigned char 零扩展', H + 'unsigned char c = 200; printf("%d", c);' + END, '200');
t('unsigned short 零扩展', H + 'unsigned short s = 60000; printf("%d", s);' + END, '60000');
t('char 仍是有符号', H + 'char c = 200; printf("%d", c);' + END, '-56');
t('unsigned int 全称写法', H + 'unsigned int x = 7; printf("%u", x);' + END, '7');
t('signed 关键字可用', H + 'signed int x = -3; printf("%d", x);' + END, '-3');
t('unsigned 走 for 循环', H + 'unsigned i; for (i = 3; i > 0; i--) printf("%u", i);' + END, '321');
t('无符号复合赋值 %=', H + 'unsigned u = 4000000000u; u %= 7; printf("%u", u);' + END, '3');
t('无符号复合赋值 /=', H + 'unsigned u = 4000000000u; u /= 4; printf("%u", u);' + END, '1000000000');

/* 大常量 */
t('long 大常量不截断', H + 'long v = 1234567890123L; printf("%ld", v);' + END, '1234567890123');
t('long 大常量做除法', H + 'long v = 1234567890123L; printf("%ld", v / 7);' + END, '176366841446');
t('long 大常量取余', H + 'long v = 1234567890123L; printf("%ld", v % 7);' + END, '1');
t('大常量赋给 int 低 32 位', H + 'long v = 4294967296L; printf("%ld", v);' + END, '4294967296');
t('负数除法向零取整', H + 'int a = -17, b = 5; printf("%d %d", a / b, a % b);' + END, '-3 -2');
t('负数 64 位除法', H + 'long a = -9876543210L, b = 13; printf("%ld %ld", a / b, a % b);' + END, '-759734093 -1');
t('无符号 64 位除法', H + 'unsigned long u = 18000000000000000000ul; printf("%lu", u / 3);' + END, '6000000000000000000');

/* 单精度 float 路径 */
t('float 加法', H + 'float a = 1.25f; float b = 2.5f; printf("%.3f", a + b);' + END, '3.750');
t('float 转 double', H + 'float x = 3.0f; double d = x; printf("%.2f", d / 2);' + END, '1.50');
t('double 转 float 截断', H + 'double d = 1.0 / 3.0; float f = d; printf("%.6f", f);' + END, '0.333333');

/* printf 格式细节 */
t('零补齐 %05d', H + 'printf("[%05d]", 42);' + END, '[00042]');
t('零补齐负数 %05d', H + 'printf("[%05d]", -42);' + END, '[-0042]');
t('精度与宽度组合 %8.3f', H + 'printf("[%8.3f]", 3.14159);' + END, '[   3.142]');
t('%ld 输出大数', H + 'long v = 9876543210L; printf("%ld", v);' + END, '9876543210');
t('%o 八进制', H + 'printf("%o", 64);' + END, '100');
t('%i 等价 %d', H + 'printf("%i", -5);' + END, '-5');

/* 指令库与模拟器一致性 */
const doc = D.INSTRS.map(x => x.name);
const sim = Object.keys(VM.INSTR_ARITY);
const missing = sim.filter(m => doc.indexOf(m) < 0);
if (missing.length) { fail++; fails.push('指令库缺文档：' + missing.join(', ')); } else pass++;
const stale = doc.filter(m => sim.indexOf(m) < 0);
if (stale.length) { fail++; fails.push('指令库有文档但模拟器不支持：' + stale.join(', ')); } else pass++;
const dup = doc.filter((x, i) => doc.indexOf(x) !== i);
if (dup.length) { fail++; fails.push('指令库重复条目：' + dup.join(', ')); } else pass++;

console.log('unsigned / 边界测试：通过 ' + pass + ' / ' + (pass + fail));
console.log('（其中指令库一致性 3 项：文档 ' + doc.length + ' 条 / 模拟器 ' + sim.length + ' 条）');
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  · ' + f)); process.exit(1); }
