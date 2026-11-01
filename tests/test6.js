// 逐行解释覆盖率：97 条指令是否都能给出非空、有信息量的解释
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'js', 'vm.js'));
const A = require(path.join(ROOT, 'js', 'analyze.js'));
const D = require(path.join(ROOT, 'js', 'data.js'));

// 建一台最小机器，供解释器取寄存器/内存的值
const boot = VM.assemble('main:\npush rbp\nmov rbp, rsp\nmov eax, 42\nleave\nret');
const mach = new VM.Machine(boot);
const prog = boot;

const REG64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi'];
const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esi', 'edi'];
const OPF = {
  // 默认操作数：目标 + 源
  two: () => [
    { kind: 'reg', name: 'eax', size: 4, text: 'eax' },
    { kind: 'reg', name: 'ecx', size: 4, text: 'ecx' }
  ],
  one: () => [{ kind: 'reg', name: 'eax', size: 4, text: 'eax' }],
  zero: () => []
};

function opsFor(mn) {
  const arity = VM.INSTR_ARITY[mn];
  // 分支/调用需要标签
  if (mn === 'jmp' || mn[0] === 'j' && mn !== 'jmp') return [{ kind: 'label', label: '.L1', text: '.L1' }];
  if (mn === 'call') return [{ kind: 'label', label: 'printf', text: 'printf' }];
  if (mn === 'lea') return [{ kind: 'reg', name: 'rax', size: 8, text: 'rax' }, { kind: 'mem', base: 'rbp', disp: -8, size: 8, text: 'QWORD PTR [rbp-8]' }];
  if (/^cmov/.test(mn)) return [{ kind: 'reg', name: 'eax', size: 4, text: 'eax' }, { kind: 'reg', name: 'ecx', size: 4, text: 'ecx' }];
  if (mn === 'movsd' || mn === 'movss' || /^(add|sub|mul|div)(sd|ss)$/.test(mn) || /^cvt/.test(mn) || /comi/.test(mn) || mn === 'sqrtsd' || mn === 'xorpd' || mn === 'xorps' || mn === 'pxor') {
    return [{ kind: 'reg', name: 'xmm0', size: 16, text: 'xmm0' }, { kind: 'reg', name: 'xmm1', size: 16, text: 'xmm1' }];
  }
  if (mn === 'push') return [{ kind: 'reg', name: 'rbp', size: 8, text: 'rbp' }];
  if (mn === 'pop') return [{ kind: 'reg', name: 'rbp', size: 8, text: 'rbp' }];
  if (/^set/.test(mn)) return [{ kind: 'reg', name: 'al', size: 1, text: 'al' }];
  if (mn === 'imul' || mn === 'idiv' || mn === 'div') return [{ kind: 'reg', name: 'ecx', size: 4, text: 'ecx' }];
  if (arity === 0) return [];
  if (arity === 1) return OPF.one();
  return OPF.two();
}

let pass = 0, fail = 0; const bad = [];
D.INSTRS.forEach(info => {
  const mn = info.name;
  const ops = opsFor(mn);
  const ins = {
    index: 0, addr: 0x400000, lineNo: 1, mnem: mn, ops,
    text: mn + ' ' + ops.map(o => o.text).join(', '), comment: '', opStr: ''
  };
  let r;
  try {
    r = A.explainLine(ins, mach, { prog });
  } catch (e) {
    fail++; bad.push(mn + ' → 抛异常：' + e.message); return;
  }
  if (!r || !r.headline || r.headline.length < 4) { fail++; bad.push(mn + ' → 没有 headline'); return; }
  if (/暂未收录/.test(r.detail || '')) { fail++; bad.push(mn + ' → 详情仍是「暂未收录」'); return; }
  if (!r.cat || !r.cat.name) { fail++; bad.push(mn + ' → 缺分类'); return; }
  pass++;
});

console.log('逐行解释覆盖：' + pass + ' / ' + (pass + fail) + ' 条指令都有实质性解释');
if (fail) { console.log('\n问题：'); bad.forEach(b => console.log('  · ' + b)); process.exit(1); }
