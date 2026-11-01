// 校验内置示例：C 示例要能编译并跑出输出，汇编示例要能汇编并执行
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const C2 = require(path.join(ROOT, 'js', 'c2asm.js'));
const D = require(path.join(ROOT, 'js', 'data.js'));

let bad = 0;
console.log('=== C 示例 ===');
D.EXAMPLES_C.forEach(ex => {
  const r = C2.compile(ex.code);
  if (!r.ok) { bad++; console.log('✗ ' + ex.name + '：编译失败 ' + r.error); return; }
  const prog = VM.assemble(r.asm);
  if (!prog.ok) { bad++; console.log('✗ ' + ex.name + '：汇编失败 ' + prog.errors.join(' | ')); return; }
  const m = new VM.Machine(prog);
  let g = 0;
  while (!m.halted && g++ < 300000) m.step();
  if (m.errorMsg) { bad++; console.log('✗ ' + ex.name + '：运行错误 ' + m.errorMsg); return; }
  console.log('✓ ' + ex.name + ' → ' + JSON.stringify(m.output.trim()).slice(0, 90));
});

console.log('\n=== 汇编示例 ===');
D.EXAMPLES_ASM.forEach(ex => {
  const prog = VM.assemble(ex.code);
  if (!prog.ok) { bad++; console.log('✗ ' + ex.name + '：' + prog.errors.join(' | ')); return; }
  const m = new VM.Machine(prog);
  let g = 0;
  while (!m.halted && g++ < 300000) m.step();
  if (m.errorMsg) { bad++; console.log('✗ ' + ex.name + '：运行错误 ' + m.errorMsg); return; }
  console.log('✓ ' + ex.name + ' → ' + JSON.stringify((m.output || '').trim()).slice(0, 90) + ' / ' + m.haltReason);
});

console.log('\n=== 指令库统计 ===');
console.log('指令条目：' + D.INSTRS.length + '，分类：' + Object.keys(D.CAT).length);
console.log('寄存器文档：' + D.REG_NAMES.length + '（含 xmm：' + D.REG_NAMES.filter(n => n.indexOf('xmm') === 0).length + '）');
console.log(bad ? '\n有 ' + bad + ' 个示例有问题' : '\n全部示例正常');
process.exitCode = bad ? 1 : 0;
