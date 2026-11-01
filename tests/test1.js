// 编译器 + 虚拟机联合测试（Node 直接跑，不依赖浏览器）
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const C2 = require(path.join(ROOT, 'js', 'c2asm.js'));

let pass = 0, fail = 0;
const fails = [];

function runAsm(asm, maxSteps = 200000) {
  const prog = VM.assemble(asm);
  if (!prog.ok) return { error: '汇编错误：' + prog.errors.join(' | '), asm: asm };
  const m = new VM.Machine(prog);
  let guard = 0;
  while (!m.halted && guard++ < maxSteps) m.step();
  return { out: m.output, err: m.errorMsg, halt: m.haltReason, machine: m, prog: prog };
}

function test(name, src, expectOut) {
  const r = C2.compile(src);
  if (!r.ok) {
    fail++; fails.push(name + ' → 编译失败：' + r.error);
    return;
  }
  const res = runAsm(r.asm);
  if (res.error) { fail++; fails.push(name + ' → ' + res.error); return; }
  if (res.err) { fail++; fails.push(name + ' → 运行错误：' + res.err); return; }
  const got = (res.out || '').replace(/\s+$/, '');
  const want = String(expectOut).replace(/\s+$/, '');
  if (got !== want) {
    fail++;
    fails.push(name + ' → 输出不符\n      期望: ' + JSON.stringify(want) + '\n      实际: ' + JSON.stringify(got));
    return;
  }
  pass++;
}

/* ---------------- 基础（回归） ---------------- */
test('两数相加', `
int main() {
    int a = 5, b = 3;
    int c = a + b;
    printf("c = %d\\n", c);
    return 0;
}`, 'c = 8');

test('while 累加', `
int main() {
    int i = 1, sum = 0;
    while (i <= 100) { sum = sum + i; i = i + 1; }
    printf("sum = %d\\n", sum);
    return 0;
}`, 'sum = 5050');

test('for + 嵌套', `
int main() {
    int t = 0;
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 4; j++) t = t + i * j;
    }
    printf("%d\\n", t);
    return 0;
}`, '18');

test('除法与取余', `
int main() {
    int a = -17, b = 5;
    printf("%d %d\\n", a / b, a % b);
    return 0;
}`, '-3 -2');

test('短路逻辑', `
int main() {
    int x = 0;
    if (x != 0 && 10 / x > 1) printf("bad\\n");
    else printf("ok\\n");
    return 0;
}`, 'ok');

/* ---------------- 指针 ---------------- */
test('指针读写', `
int main() {
    int a = 7;
    int *p = &a;
    *p = 42;
    printf("a=%d *p=%d\\n", a, *p);
    return 0;
}`, 'a=42 *p=42');

test('指针交换两数', `
void swap(int *x, int *y) {
    int t = *x;
    *x = *y;
    *y = t;
}
int main() {
    int a = 3, b = 9;
    swap(&a, &b);
    printf("%d %d\\n", a, b);
    return 0;
}`, '9 3');

test('数组与下标', `
int main() {
    int a[5];
    int i;
    for (i = 0; i < 5; i++) a[i] = i * i;
    int s = 0;
    for (i = 0; i < 5; i++) s = s + a[i];
    printf("s=%d a[3]=%d\\n", s, a[3]);
    return 0;
}`, 's=30 a[3]=9');

test('指针遍历数组', `
int main() {
    int a[4] = {10, 20, 30, 40};
    int *p = a;
    int s = 0;
    for (int i = 0; i < 4; i++) s = s + *(p + i);
    printf("%d\\n", s);
    return 0;
}`, '100');

test('指针自增与指针差', `
int main() {
    int a[4] = {1, 2, 3, 4};
    int *p = a;
    int *q = a + 3;
    p++;
    printf("diff=%d val=%d\\n", (int)(q - p), *p);
    return 0;
}`, 'diff=2 val=2');

test('字符串遍历', `
int main() {
    char *s = "hello";
    int n = 0;
    while (s[n] != 0) n++;
    printf("len=%d first=%c\\n", n, s[0]);
    return 0;
}`, 'len=5 first=h');

/* ---------------- 结构体 ---------------- */
test('结构体成员', `
struct Point { int x; int y; };
int main() {
    struct Point p;
    p.x = 3;
    p.y = 4;
    printf("(%d,%d)\\n", p.x, p.y);
    return 0;
}`, '(3,4)');

test('结构体指针与函数', `
struct Point { int x; int y; };
int sum(struct Point *p) {
    return p->x + p->y;
}
int main() {
    struct Point p;
    p.x = 5; p.y = 7;
    printf("sum=%d\\n", sum(&p));
    return 0;
}`, 'sum=12');

test('结构体数组', `
struct Item { int id; int num; };
int main() {
    struct Item a[3];
    for (int i = 0; i < 3; i++) { a[i].id = i; a[i].num = (i + 1) * 10; }
    int t = 0;
    for (int i = 0; i < 3; i++) t = t + a[i].num;
    printf("t=%d last=%d\\n", t, a[2].num);
    return 0;
}`, 't=60 last=30');

test('结构体整体赋值', `
struct P { int x; int y; };
int main() {
    struct P a, b;
    a.x = 1; a.y = 2;
    b = a;
    b.x = 9;
    printf("%d %d %d\\n", a.x, b.x, b.y);
    return 0;
}`, '1 9 2');

/* ---------------- 浮点数 ---------------- */
test('浮点基本运算', `
int main() {
    double a = 3.5, b = 2.0;
    double c = a * b + 1.25;
    printf("c=%.2f\\n", c);
    return 0;
}`, 'c=8.25');

test('浮点除法与格式化', `
int main() {
    double a = 7.0;
    double b = 2.0;
    printf("%.3f %.0f\\n", a / b, a / b);
    return 0;
}`, '3.500 4');

test('浮点比较', `
int main() {
    double x = 2.5;
    if (x > 2.0) printf("big\\n");
    else printf("small\\n");
    return 0;
}`, 'big');

test('float 与 double 混合', `
int main() {
    float f = 1.5;
    double d = 2.25;
    double s = f + d;
    printf("%.2f\\n", s);
    return 0;
}`, '3.75');

test('整数转浮点', `
int main() {
    int a = 3;
    int b = 4;
    double avg = (double)(a + b) / 2.0;
    printf("%.1f\\n", avg);
    return 0;
}`, '3.5');

/* ---------------- 综合 ---------------- */
test('结构体+指针+浮点：平均分', `
struct Student { int id; double score; };
int main() {
    struct Student a[3];
    a[0].id = 1; a[0].score = 88.5;
    a[1].id = 2; a[1].score = 92.0;
    a[2].id = 3; a[2].score = 76.5;
    double total = 0.0;
    for (int i = 0; i < 3; i++) total = total + a[i].score;
    printf("avg=%.2f\\n", total / 3.0);
    return 0;
}`, 'avg=85.67');

test('sqrt 类：牛顿迭代求平方根', `
int main() {
    double x = 2.0;
    double g = 1.0;
    for (int i = 0; i < 20; i++) g = (g + x / g) / 2.0;
    printf("%.4f\\n", g);
    return 0;
}`, '1.4142');

/* ---------------- 输出 ---------------- */
console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fails.length) {
  console.log('\n失败用例：');
  fails.forEach(f => console.log('  ✗ ' + f));
  process.exitCode = 1;
}
