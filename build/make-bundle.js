/* ============================================================
 * make-bundle.js · 把前端共用的计算模块 + 服务端合成单个脚本
 * （SEA 单文件 exe 的主脚本必须是一个文件，不能 require 相对路径）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODS = ['data', 'vm', 'c2asm', 'decompile', 'analyze', 'diagnose'];

let out = `/* 自动生成，请勿手改 —— 源文件在 js/ 与 build/server.js */
'use strict';
const __defs = Object.create(null);
const __mods = Object.create(null);
const __realRequire = require;
function __req(spec) {
  if (spec[0] !== '.') return __realRequire(spec);
  const name = spec.replace(/^\\.\\.?\\//, '').replace(/^js\\//, '').replace(/\\.js$/, '');
  return __load(name);
}
function __load(name) {
  if (__mods[name]) return __mods[name];
  const module = { exports: {} };
  __mods[name] = module.exports;
  if (!__defs[name]) throw new Error('模块未打包：' + name);
  __defs[name](module, module.exports, __req);
  __mods[name] = module.exports;
  return __mods[name];
}
`;

MODS.forEach(n => {
  const src = fs.readFileSync(path.join(ROOT, 'js', n + '.js'), 'utf8');
  out += `__defs[${JSON.stringify(n)}] = function (module, exports, require) {\n` + src + `\n};\n`;
});

let srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const before = srv;
srv = srv.replace(/require\('\.\.\/js\/([A-Za-z0-9_]+)\.js'\)/g, "__load('$1')");
srv = srv.replace(/if \(require\.main === module\)\s*main\(\);/, 'main();');
if (srv === before) throw new Error('服务端的 require 没有被替换，检查 server.js 的写法');

out += '\n/* ================= 服务端 ================= */\n' + srv;

const dst = path.join(__dirname, 'bundle.js');
fs.writeFileSync(dst, out, 'utf8');
const kb = Math.round(Buffer.byteLength(out) / 1024);
console.log('已生成 build/bundle.js（' + kb + ' KB，含 ' + MODS.length + ' 个模块）');
