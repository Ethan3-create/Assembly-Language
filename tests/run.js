// 一次跑完所有测试：在项目根目录执行  node tests/run.js
const path = require('path');
const { execFileSync } = require('child_process');

const files = ['test1.js', 'test2.js', 'test3.js', 'test4.js', 'test5.js', 'test6.js', 'test7.js', 'test8.js'];
let bad = 0;
files.forEach(f => {
  const p = path.join(__dirname, f);
  process.stdout.write('── ' + f + ' ' + '─'.repeat(Math.max(0, 30 - f.length)) + '\n');
  try {
    const out = execFileSync(process.execPath, [p], { encoding: 'utf8' });
    process.stdout.write(out.replace(/\n+$/, '') + '\n');
  } catch (e) {
    bad++;
    process.stdout.write((e.stdout || '') + (e.stderr || '') + '\n');
  }
});
process.stdout.write('\n' + (bad ? '有 ' + bad + ' 个测试文件未通过' : '全部测试通过') + '\n');
process.exit(bad ? 1 : 0);
