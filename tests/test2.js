// 边界与组合用例
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const C2 = require(path.join(ROOT, 'js', 'c2asm.js'));

let pass = 0, fail = 0;
const fails = [];
function run(src) {
  const r = C2.compile(src);
  if (!r.ok) return { compileErr: r.error };
  const prog = VM.assemble(r.asm);
  if (!prog.ok) return { asmErr: prog.errors.join(' | ') };
  const m = new VM.Machine(prog);
  let g = 0;
  while (!m.halted && g++ < 500000) m.step();
  return { out: m.output, err: m.errorMsg, asm: r.asm };
}
function test(name, src, want) {
  const r = run(src);
  if (r.compileErr) { fail++; fails.push(name + ' → 编译失败：' + r.compileErr); return; }
  if (r.asmErr) { fail++; fails.push(name + ' → 汇编失败：' + r.asmErr); return; }
  if (r.err) { fail++; fails.push(name + ' → 运行错误：' + r.err); return; }
  const got = (r.out || '').replace(/\s+$/, '');
  if (got !== String(want).replace(/\s+$/, '')) {
    fail++;
    fails.push(name + ' → 期望 ' + JSON.stringify(want) + ' 实际 ' + JSON.stringify(got));
    return;
  }
  pass++;
}

test('递归阶乘', `
int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
int main() { printf("%d\\n", fact(6)); return 0; }`, '720');

test('斐波那契', `
int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
int main() { printf("%d\\n", fib(10)); return 0; }`, '55');

test('返回 double 的函数', `
double half(double x) { return x / 2.0; }
int main() { printf("%.2f\\n", half(9.0)); return 0; }`, '4.50');

test('混合参数（int + double + 指针）', `
struct S { int k; double v; };
double mix(int a, struct S *s, double b) { return a + s->v * b; }
int main() {
    struct S s; s.k = 1; s.v = 2.5;
    printf("%.2f\\n", mix(3, &s, 4.0));
    return 0;
}`, '13.00');

test('结构体对齐与 sizeof', `
struct A { int a; double b; int c; };
int main() {
    printf("%d %d %d\\n", sizeof(int), sizeof(double), sizeof(struct A));
    return 0;
}`, '4 8 24');

test('char 类型', `
int main() {
    char c = 'A';
    c = c + 2;
    printf("%c %d\\n", c, c);
    return 0;
}`, 'C 67');

test('do-while', `
int main() {
    int i = 0, s = 0;
    do { s = s + i; i++; } while (i < 5);
    printf("%d\\n", s);
    return 0;
}`, '10');

test('三目运算符', `
int main() {
    int a = 7, b = 12;
    int m = a > b ? a : b;
    double d = a > b ? 1.5 : 2.5;
    printf("%d %.1f\\n", m, d);
    return 0;
}`, '12 2.5');

test('复合赋值', `
int main() {
    int x = 10;
    x += 5; x -= 3; x *= 2; x /= 4; x %= 4;
    double d = 1.0;
    d += 0.5; d *= 4.0;
    printf("%d %.1f\\n", x, d);
    return 0;
}`, '2 6.0');

test('exit 提前结束', `
int main() {
    printf("a");
    exit(3);
    printf("b");
    return 0;
}`, 'a');

test('puts 与 putchar', `
int main() {
    puts("hello");
    putchar('!');
    putchar(10);
    return 0;
}`, 'hello\n!');

test('break 与 continue', `
int main() {
    int s = 0;
    for (int i = 0; i < 10; i++) {
        if (i % 2 == 0) continue;
        if (i > 7) break;
        s = s + i;
    }
    printf("%d\\n", s);
    return 0;
}`, '16');

test('指针参数修改数组', `
void fill(int *a, int n, int v) {
    for (int i = 0; i < n; i++) a[i] = v + i;
}
int main() {
    int a[4];
    fill(a, 4, 10);
    printf("%d %d %d %d\\n", a[0], a[1], a[2], a[3]);
    return 0;
}`, '10 11 12 13');

test('结构体作为数组元素含 double', `
struct P { int id; double w; };
int main() {
    struct P a[2];
    a[0].id = 1; a[0].w = 1.5;
    a[1].id = 2; a[1].w = 2.5;
    double t = a[0].w + a[1].w;
    printf("%d %.1f\\n", a[1].id, t);
    return 0;
}`, '2 4.0');

test('浮点自增与复合', `
int main() {
    double x = 1.5;
    x++;
    x += 2.0;
    printf("%.2f\\n", x);
    return 0;
}`, '4.50');

test('整数与浮点混合比较', `
int main() {
    int a = 3;
    double b = 3.0;
    if (a == b) printf("eq\\n"); else printf("ne\\n");
    return 0;
}`, 'eq');

test('字符串拼接输出', `
int main() {
    char *name = "Asm";
    int n = 3;
    printf("%s-%d\\n", name, n);
    return 0;
}`, 'Asm-3');

test('多级指针', `
int main() {
    int a = 5;
    int *p = &a;
    int **pp = &p;
    **pp = 9;
    printf("%d\\n", a);
    return 0;
}`, '9');

test('负数与长整型', `
int main() {
    long x = 1000000;
    long y = x * 3;
    printf("%ld %d\\n", y, (int)(y / 7));
    return 0;
}`, '3000000 428571');

test('while 里嵌套 if-else 链', `
int grade(int s) {
    if (s >= 90) return 1;
    else if (s >= 75) return 2;
    else if (s >= 60) return 3;
    else return 4;
}
int main() {
    printf("%d %d %d\\n", grade(95), grade(80), grade(50));
    return 0;
}`, '1 2 4');

test('数组初始化与求和', `
int main() {
    int a[5] = {1, 2, 3, 4, 5};
    int s = 0;
    for (int i = 0; i < 5; i++) s += a[i];
    printf("%d\\n", s);
    return 0;
}`, '15');

console.log('通过 ' + pass + ' / ' + (pass + fail));
if (fails.length) { console.log('\n失败：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
