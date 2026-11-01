/* ============================================================
 * 数据层：指令知识库、寄存器表、示例代码
 * 供自动补全、逐行分析、帮助面板共用
 * ============================================================ */
(function (global) {
  'use strict';

  // 指令分类（用于着色与统计）
  const CAT = {
    data:  { name: '数据传送', color: '#2563eb', bg: '#dbeafe' },
    arith: { name: '算术运算', color: '#c2410c', bg: '#ffedd5' },
    logic: { name: '逻辑运算', color: '#7c3aed', bg: '#ede9fe' },
    shift: { name: '移位运算', color: '#0e7490', bg: '#cffafe' },
    ctrl:  { name: '控制转移', color: '#b91c1c', bg: '#fee2e2' },
    stack: { name: '栈操作',   color: '#047857', bg: '#d1fae5' },
    call:  { name: '函数调用', color: '#a21caf', bg: '#fae8ff' },
    fpu:   { name: '浮点 / SSE', color: '#0369a1', bg: '#e0f2fe' },
    misc:  { name: '其他',     color: '#4b5563', bg: '#e5e7eb' }
  };

  /* ---------------- 指令知识库 ----------------
   * name   助记符
   * cn     中文名
   * cat    分类
   * desc   作用说明（讲清"做什么"）
   * flags  对标志位的影响
   * forms  常见书写形式
   * eg     示例
   * tip    易错点 / 记忆点
   */
  const INSTRS = [
    { name: 'mov', cn: '传送', cat: 'data', desc: '把源操作数的值复制到目标操作数，目标原来的值被覆盖。源可以是立即数、寄存器或内存，但源和目标不能同时为内存。', flags: '不影响标志位', forms: ['mov 目标, 源'], eg: 'mov eax, 5', tip: 'mov 只搬数据，不改变任何标志位；这是它和 add/sub 的关键区别。' },
    { name: 'movzx', cn: '零扩展传送', cat: 'data', desc: '把较小的源操作数读入较大的寄存器，高位补 0。常用于把 8 位/16 位无符号数提升为 32 位。', flags: '不影响标志位', forms: ['movzx 大寄存器, 小操作数'], eg: 'movzx eax, al', tip: '无符号数用 movzx（补 0），有符号数要用 movsx（补符号位）。' },
    { name: 'movsx', cn: '符号扩展传送', cat: 'data', desc: '把较小的源操作数读入较大的寄存器，高位用源的最高位（符号位）填充，保持数值不变。', flags: '不影响标志位', forms: ['movsx 大寄存器, 小操作数'], eg: 'movsx eax, al', tip: '把 -1（0xFF）扩展到 32 位，用 movsx 得 0xFFFFFFFF，用 movzx 得 0x000000FF。' },
    { name: 'lea', cn: '取有效地址', cat: 'data', desc: '计算内存操作数的有效地址（不访问内存），把地址本身放进目标寄存器。常被编译器用来做加法。', flags: '不影响标志位', forms: ['lea 目标, [地址表达式]'], eg: 'lea rdi, [.LC0]', tip: 'lea 只看"[ ]"里算出来的地址，绝不读那块内存的内容。' },
    { name: 'push', cn: '入栈', cat: 'stack', desc: '先把 rsp 减去 8，再把操作数写到 [rsp] 处。栈向低地址方向生长。', flags: '不影响标志位', forms: ['push 源'], eg: 'push rbp', tip: 'push 是先改 rsp 再写内存，所以压入的数据总在"新 rsp"处。' },
    { name: 'pop', cn: '出栈', cat: 'stack', desc: '把 [rsp] 处的值读到目标，然后 rsp 加 8。', flags: '不影响标志位', forms: ['pop 目标'], eg: 'pop rbp', tip: 'push 和 pop 必须成对出现，否则函数返回时栈就错位了。' },
    { name: 'add', cn: '加法', cat: 'arith', desc: '目标 = 目标 + 源，结果写回目标并设置标志位。', flags: '影响 ZF/SF/CF/OF', forms: ['add 目标, 源'], eg: 'add eax, ecx', tip: 'add 有两个操作数却要读三处数据：目标原值、源、结果。' },
    { name: 'sub', cn: '减法', cat: 'arith', desc: '目标 = 目标 - 源，结果写回目标并设置标志位。比较两个数的大小本质上就是做一次 sub 但不保存结果（即 cmp）。', flags: '影响 ZF/SF/CF/OF', forms: ['sub 目标, 源'], eg: 'sub rsp, 32', tip: 'sub rsp, N 是"在栈上开辟 N 字节局部空间"的标准写法。' },
    { name: 'inc', cn: '自增 1', cat: 'arith', desc: '目标 = 目标 + 1。比 add 目标, 1 少一个字节，且不改变 CF。', flags: '影响 ZF/SF/OF，不影响 CF', forms: ['inc 目标'], eg: 'inc DWORD PTR [rbp-8]', tip: '循环计数器 i++ 编译后通常就是 inc 或 add ..., 1。' },
    { name: 'dec', cn: '自减 1', cat: 'arith', desc: '目标 = 目标 - 1，同样不改变 CF。', flags: '影响 ZF/SF/OF，不影响 CF', forms: ['dec 目标'], eg: 'dec ecx', tip: 'dec 到 0 时 ZF=1，所以常用 dec + jnz 组成循环。' },
    { name: 'imul', cn: '有符号乘法', cat: 'arith', desc: '双操作数形式：目标 = 目标 × 源，只保留低 32/64 位。', flags: 'CF/OF 表示结果是否溢出', forms: ['imul 目标, 源'], eg: 'imul eax, ecx', tip: '乘法结果可能超出寄存器宽度，超出部分被直接丢弃（溢出则由 OF 标记）。' },
    { name: 'idiv', cn: '有符号除法', cat: 'arith', desc: '用 edx:eax 组成的 64 位被除数除以源操作数：商存入 eax，余数存入 edx。', flags: '结果未定义（不要依赖）', forms: ['idiv 除数'], eg: 'idiv ecx', tip: '除法前必须用 cdq 把 eax 的符号扩展到 edx，否则商是错的。' },
    { name: 'cdq', cn: '符号扩展', cat: 'arith', desc: '把 eax 的符号位扩展到 edx（正数 edx=0，负数 edx=0xFFFFFFFF）。专为 idiv 准备 64 位被除数。', flags: '不影响标志位', forms: ['cdq'], eg: 'cdq', tip: 'cdq 是"除法前戏"，单独出现没有意义。' },
    { name: 'neg', cn: '取负', cat: 'arith', desc: '目标 = 0 - 目标，即取相反数。', flags: '影响 ZF/SF/CF/OF', forms: ['neg 目标'], eg: 'neg eax', tip: '对最小值取负会溢出，这是补码表示的固有问题。' },
    { name: 'and', cn: '按位与', cat: 'logic', desc: '逐位与运算，结果写回目标。常用于"屏蔽某些位"或"清零"。', flags: '影响 ZF/SF/OF，CF=0', forms: ['and 目标, 源'], eg: 'and eax, 15', tip: 'and eax, 0 等于清零；and eax, 15 等于对 16 取模（仅对非负数成立）。' },
    { name: 'or', cn: '按位或', cat: 'logic', desc: '逐位或运算，结果写回目标。常用于"置位"。', flags: '影响 ZF/SF/OF，CF=0', forms: ['or 目标, 源'], eg: 'or eax, 8', tip: 'or 常用来把某个标志位置 1。' },
    { name: 'xor', cn: '按位异或', cat: 'logic', desc: '逐位异或运算。最经典的用法是 xor eax, eax 把寄存器清零（比 mov eax, 0 更短更快）。', flags: '影响 ZF/SF/OF，CF=0', forms: ['xor 目标, 源'], eg: 'xor eax, eax', tip: 'xor 自己和自己 = 0，所以编译器爱用 xor eax, eax 清零。' },
    { name: 'not', cn: '按位取反', cat: 'logic', desc: '把目标的每一位取反（0→1，1→0）。', flags: '不影响标志位', forms: ['not 目标'], eg: 'not eax', tip: 'not 不影响标志位，这一点很容易被忽略。' },
    { name: 'shl', cn: '左移', cat: 'shift', desc: '各位左移，低位补 0。左移 n 位等价于乘以 2^n。', flags: '影响 ZF/SF/CF/OF', forms: ['shl 目标, 位数'], eg: 'shl eax, 2', tip: '左移 2 位 = ×4，编译器常用移位代替乘法。' },
    { name: 'shr', cn: '逻辑右移', cat: 'shift', desc: '各位右移，高位补 0。对无符号数来说等价于除以 2^n。', flags: '影响 ZF/SF/CF', forms: ['shr 目标, 位数'], eg: 'shr eax, 1', tip: '负数用 shr 会把符号位"移丢"，要用 sar。' },
    { name: 'sar', cn: '算术右移', cat: 'shift', desc: '各位右移，高位补符号位，保持负数的符号。', flags: '影响 ZF/SF/CF', forms: ['sar 目标, 位数'], eg: 'sar eax, 1', tip: '负数除以 2 用 sar；sar 会向负无穷取整，和 C 的除法朝 0 取整略有差别。' },
    { name: 'cmp', cn: '比较', cat: 'ctrl', desc: '计算 目标 - 源 并设置标志位，但不保存结果。它只负责"表态"，后续靠条件跳转来用这些标志。', flags: '影响 ZF/SF/CF/OF', forms: ['cmp 左, 右'], eg: 'cmp eax, ecx', tip: 'cmp 后面 99% 会跟一条条件跳转指令，两条一起看才完整。' },
    { name: 'test', cn: '测试', cat: 'logic', desc: '计算 目标 AND 源 并设置标志位，不保存结果。常用于测试某位是否为 0 或整个寄存器是否为 0。', flags: '影响 ZF/SF，CF=OF=0', forms: ['test 目标, 源'], eg: 'test eax, eax', tip: 'test eax, eax 是"判断 eax 是不是 0"的惯用法。' },
    { name: 'jmp', cn: '无条件跳转', cat: 'ctrl', desc: '直接跳到标签处继续执行，不看任何标志位。', flags: '不影响标志位', forms: ['jmp 标签'], eg: 'jmp .L2', tip: '循环的"回到开头"、if/else 的"跳过 else"都靠 jmp。' },
    { name: 'je', cn: '相等则跳转', cat: 'ctrl', desc: 'ZF=1（上一条比较结果相等 / 差值为 0）时跳转。等价于 jz。', flags: '读取 ZF', forms: ['je 标签'], eg: 'je .L5', tip: 'je 和 jz 是同一条指令的两个名字。' },
    { name: 'jne', cn: '不等则跳转', cat: 'ctrl', desc: 'ZF=0 时跳转。等价于 jnz。', flags: '读取 ZF', forms: ['jne 标签'], eg: 'jne .L2', tip: '循环条件 i != n 编译出来就是 cmp + jne/jl。' },
    { name: 'jz', cn: '为零则跳转', cat: 'ctrl', desc: 'ZF=1 时跳转，与 je 完全等价。', flags: '读取 ZF', forms: ['jz 标签'], eg: 'jz .Lend', tip: 'dec ecx 后接 jz 是经典的倒计数循环。' },
    { name: 'jnz', cn: '非零则跳转', cat: 'ctrl', desc: 'ZF=0 时跳转，与 jne 完全等价。', flags: '读取 ZF', forms: ['jnz 标签'], eg: 'jnz .L2', tip: '常见于 do-while 结构：先干活，再判断要不要继续。' },
    { name: 'jl', cn: '小于则跳转（有符号）', cat: 'ctrl', desc: '有符号比较 左 < 右 时跳转，条件为 SF≠OF。', flags: '读取 SF/OF', forms: ['jl 标签'], eg: 'jl .L3', tip: '有符号用 jl/jg，无符号要用 jb/ja，混用会出错。' },
    { name: 'jle', cn: '小于等于则跳转', cat: 'ctrl', desc: '有符号比较 左 ≤ 右 时跳转，条件为 ZF=1 或 SF≠OF。', flags: '读取 ZF/SF/OF', forms: ['jle 标签'], eg: 'jle .L3', tip: '' },
    { name: 'jg', cn: '大于则跳转（有符号）', cat: 'ctrl', desc: '有符号比较 左 > 右 时跳转，条件为 ZF=0 且 SF=OF。', flags: '读取 ZF/SF/OF', forms: ['jg 标签'], eg: 'jg .L3', tip: '' },
    { name: 'jge', cn: '大于等于则跳转', cat: 'ctrl', desc: '有符号比较 左 ≥ 右 时跳转，条件为 SF=OF。', flags: '读取 SF/OF', forms: ['jge 标签'], eg: 'jge .L3', tip: '' },
    { name: 'jb', cn: '低于则跳转（无符号）', cat: 'ctrl', desc: '无符号比较 左 < 右（借位 CF=1）时跳转，也叫 jnae。', flags: '读取 CF', forms: ['jb 标签'], eg: 'jb .L3', tip: '无符号比较只看 CF，此时 SB 位没有意义。' },
    { name: 'jbe', cn: '低于等于则跳转', cat: 'ctrl', desc: '无符号 左 ≤ 右 时跳转（CF=1 或 ZF=1）。', flags: '读取 CF/ZF', forms: ['jbe 标签'], eg: 'jbe .L3', tip: '' },
    { name: 'ja', cn: '高于则跳转（无符号）', cat: 'ctrl', desc: '无符号 左 > 右 时跳转（CF=0 且 ZF=0）。', flags: '读取 CF/ZF', forms: ['ja 标签'], eg: 'ja .L3', tip: '' },
    { name: 'jae', cn: '高于等于则跳转', cat: 'ctrl', desc: '无符号 左 ≥ 右 时跳转（CF=0）。', flags: '读取 CF', forms: ['jae 标签'], eg: 'jae .L3', tip: '' },
    { name: 'setl', cn: '置位（小于）', cat: 'ctrl', desc: '把 8 位目标寄存器设为 0 或 1，表示上次比较是否满足"小于"。', flags: '读取 SF/OF', forms: ['setl 字节寄存器'], eg: 'setl al', tip: 'setcc 系列常配合 movzx 把布尔结果变成 32 位整数。' },
    { name: 'sete', cn: '置位（等于）', cat: 'ctrl', desc: 'ZF=1 时把目标字节置 1，否则置 0。', flags: '读取 ZF', forms: ['sete 字节寄存器'], eg: 'sete al', tip: '' },
    { name: 'setne', cn: '置位（不等）', cat: 'ctrl', desc: 'ZF=0 时把目标字节置 1，否则置 0。', flags: '读取 ZF', forms: ['setne 字节寄存器'], eg: 'setne al', tip: '' },
    { name: 'setg', cn: '置位（大于）', cat: 'ctrl', desc: '有符号 左 > 右 时置 1。', flags: '读取 ZF/SF/OF', forms: ['setg 字节寄存器'], eg: 'setg al', tip: '' },
    { name: 'call', cn: '调用函数', cat: 'call', desc: '把下一条指令的地址压栈（作为返回地址），然后跳到函数入口。', flags: '不影响标志位', forms: ['call 函数名'], eg: 'call printf', tip: 'call = push 返回地址 + jmp 目标。' },
    { name: 'ret', cn: '函数返回', cat: 'call', desc: '从栈顶弹出返回地址送进 rip，回到调用者的下一条指令继续执行。', flags: '不影响标志位', forms: ['ret'], eg: 'ret', tip: 'ret 只负责"跳回去"，栈的清理要靠 leave 或调用约定来完成。' },
    { name: 'leave', cn: '恢复栈帧', cat: 'call', desc: '等价于 mov rsp, rbp 再 pop rbp：丢弃整个局部变量区，恢复调用者的栈基址。', flags: '不影响标志位', forms: ['leave'], eg: 'leave', tip: 'leave 是函数尾声，和序言的 push rbp / mov rbp, rsp 严格对应。' },
    { name: 'nop', cn: '空操作', cat: 'misc', desc: '什么都不做，只占用一个字节。用于对齐或占位。', flags: '不影响标志位', forms: ['nop'], eg: 'nop', tip: '' },
    { name: 'xchg', cn: '交换', cat: 'data', desc: '交换两个操作数的值。', flags: '不影响标志位', forms: ['xchg 目标, 源'], eg: 'xchg eax, ecx', tip: '' },
    { name: 'int3', cn: '断点', cat: 'misc', desc: '调试器断点指令，一般出现在调试版本的程序中。', flags: '无', forms: ['int3'], eg: 'int3', tip: '' },

    /* ── 浮点 / SSE ── */
    { name: 'movsd', cn: '双精度传送', cat: 'fpu', desc: '在 64 位内存和 xmm 寄存器之间搬一个 double（双精度浮点）。SSE 指令用 xmm 寄存器，和通用寄存器是两套并行通路。', flags: '不影响标志位', forms: ['movsd xmm, QWORD PTR [地址]', 'movsd QWORD PTR [地址], xmm'], eg: 'movsd xmm0, QWORD PTR [rbp-8]', tip: '整数走 eax/ecx，小数走 xmm0/xmm1；同一个程序里两条通路同时存在。' },
    { name: 'movss', cn: '单精度传送', cat: 'fpu', desc: '搬一个 float（单精度，32 位）。读进 xmm 时会被扩展成 double 参与运算，写回内存时再截断成 32 位。', flags: '不影响标志位', forms: ['movss xmm, DWORD PTR [地址]', 'movss DWORD PTR [地址], xmm'], eg: 'movss xmm0, DWORD PTR [rbp-4]', tip: 'float 只有约 7 位有效数字，故 0.1 存成 float 再读出来已经不是精确的 0.1。' },
    { name: 'addsd', cn: '浮点加法', cat: 'fpu', desc: '目标 = 目标 + 源，两个操作数都是双精度浮点。', flags: '不设置 ZF/SF/CF/OF（浮点比较要用 ucomisd）', forms: ['addsd 目标, 源'], eg: 'addsd xmm0, xmm1', tip: '浮点运算不会更新整数标志位，所以后面不能直接接 je/jl，要用 ucomisd。' },
    { name: 'subsd', cn: '浮点减法', cat: 'fpu', desc: '目标 = 目标 - 源，双精度浮点。', flags: '不影响整数标志位', forms: ['subsd 目标, 源'], eg: 'subsd xmm0, xmm1', tip: '' },
    { name: 'mulsd', cn: '浮点乘法', cat: 'fpu', desc: '目标 = 目标 × 源，双精度浮点。', flags: '不影响整数标志位', forms: ['mulsd 目标, 源'], eg: 'mulsd xmm0, xmm1', tip: '' },
    { name: 'divsd', cn: '浮点除法', cat: 'fpu', desc: '目标 = 目标 ÷ 源，双精度浮点。注意它和 idiv 完全不是一回事：不需要 cdq，也不会碰 edx。', flags: '不影响整数标志位', forms: ['divsd 目标, 源'], eg: 'divsd xmm0, xmm1', tip: '浮点除以 0 得到 inf 而不是崩溃；整数除以 0 会触发异常。' },
    { name: 'ucomisd', cn: '浮点比较', cat: 'fpu', desc: '比较两个双精度浮点数，只设置 ZF/PF/CF：相等时 ZF=1，左边更小时 CF=1。', flags: '设置 ZF/PF/CF，OF/SF 清零', forms: ['ucomisd 左, 右'], eg: 'ucomisd xmm0, xmm1', tip: '浮点比较后面要用 ja/jb/jae/jbe（无符号系列），因为 CF 表示"小于"。' },
    { name: 'cvtsi2sd', cn: '整数转浮点', cat: 'fpu', desc: '把通用寄存器中的整数转换成双精度浮点，写进 xmm 寄存器。', flags: '不影响标志位', forms: ['cvtsi2sd xmm, r32/r64'], eg: 'cvtsi2sd xmm0, eax', tip: 'C 里 int 和 double 混合运算时，编译器会插入这条转换指令。' },
    { name: 'cvttsd2si', cn: '浮点转整数（截断）', cat: 'fpu', desc: '把浮点数截断成整数（直接丢掉小数部分，不四舍五入）。', flags: '不影响标志位', forms: ['cvttsd2si r32/r64, xmm'], eg: 'cvttsd2si eax, xmm0', tip: '所以 (int)3.9 得到 3，而 (int)(-3.9) 得到 -3（朝 0 取整）。' },
    { name: 'cvtsd2ss', cn: '双精度转单精度', cat: 'fpu', desc: '把 64 位浮点压成 32 位浮点，可能损失精度。', flags: '不影响标志位', forms: ['cvtsd2ss xmm, xmm'], eg: 'cvtsd2ss xmm0, xmm0', tip: '' },
    { name: 'cvtss2sd', cn: '单精度转双精度', cat: 'fpu', desc: '把 32 位浮点扩展成 64 位浮点，不会丢精度。', flags: '不影响标志位', forms: ['cvtss2sd xmm, xmm'], eg: 'cvtss2sd xmm0, xmm0', tip: '' },
    { name: 'xorpd', cn: '浮点寄存器清零', cat: 'fpu', desc: '同一个寄存器和自己异或，结果为 0。这是把 xmm 清零的标准写法。', flags: '不影响标志位', forms: ['xorpd xmm, xmm'], eg: 'xorpd xmm0, xmm0', tip: '编译器用 xorpd/xorps 清零浮点寄存器，相当于整数里的 xor eax, eax。' },
    { name: 'movsxd', cn: '符号扩展传送（32→64）', cat: 'data', desc: '把 32 位有符号数扩展成 64 位，高 32 位用符号位填满。', flags: '不影响标志位', forms: ['movsxd r64, r32'], eg: 'movsxd rcx, eax', tip: '指针做下标运算时常见：先把 int 下标变成 64 位偏移量，再乘元素大小。' },
    { name: 'cdqe', cn: 'eax 符号扩展到 rax', cat: 'arith', desc: '把 eax 按符号扩展成 rax（32 位 → 64 位）。', flags: '不影响标志位', forms: ['cdqe'], eg: 'cdqe', tip: '和 cdq 容易混：cdq 是填充 edx（为除法准备），cdqe 是填充 rax 的高 32 位。' },
    { name: 'cqo', cn: 'rax 符号扩展到 rdx:rax', cat: 'arith', desc: '把 rax 的符号位扩展到 rdx，为 64 位 idiv 准备 128 位被除数。', flags: '不影响标志位', forms: ['cqo'], eg: 'cqo', tip: '64 位除法：cqo + idiv rcx，对应 32 位的 cdq + idiv ecx。' },

    /* ── 补齐：模拟器支持但原先没有知识卡片的助记符 ── */
    { name: 'div', cn: '无符号除法', cat: 'arith', desc: '用 rdx:rax（或 edx:eax）除以操作数，商放 rax/eax，余数放 rdx/edx。被除数的高位必须提前清零，否则会除溢出。', flags: '执行后标志位无定义（不要依赖）', forms: ['div 寄存器', 'div 内存'], eg: 'xor edx, edx / div ecx', tip: '这是无符号除法；有符号除法要用 idiv，并且提前用 cdq（32 位）或 cqo（64 位）把符号位铺开。', },
    { name: 'setle', cn: '小于等于时置 1（有符号）', cat: 'ctrl', desc: '如果上一次比较的结果满足「小于等于」（ZF=1 或 SF≠OF），就把目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['setle 字节寄存器'], eg: 'cmp eax, ecx / setle al', tip: 'setcc 只写 1 个字节，要配合 movzx 才能得到干净的 0/1。', },
    { name: 'setge', cn: '大于等于时置 1（有符号）', cat: 'ctrl', desc: '如果上一次比较满足「大于等于」（SF=OF），就把目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['setge 字节寄存器'], eg: 'cmp eax, ecx / setge al', tip: '有符号用 setge，无符号对应的是 setae。', },
    { name: 'seta', cn: '大于时置 1（无符号）', cat: 'ctrl', desc: '如果上一次无符号比较满足「大于」（CF=0 且 ZF=0），目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['seta 字节寄存器'], eg: 'cmp eax, ecx / seta al', tip: 'a = above，专用于无符号；有符号「大于」是 setg。', },
    { name: 'setae', cn: '大于等于时置 1（无符号）', cat: 'ctrl', desc: '如果上一次无符号比较满足「大于等于」（CF=0），目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['setae 字节寄存器'], eg: 'cmp eax, ecx / setae al', tip: 'ae = above or equal，检查的是 CF 是否为 0。', },
    { name: 'setb', cn: '小于时置 1（无符号）', cat: 'ctrl', desc: '如果上一次无符号比较满足「小于」（CF=1），目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['setb 字节寄存器'], eg: 'cmp eax, ecx / setb al', tip: 'b = below，专用于无符号；有符号「小于」是 setl。', },
    { name: 'setbe', cn: '小于等于时置 1（无符号）', cat: 'ctrl', desc: '如果上一次无符号比较满足「小于等于」（CF=1 或 ZF=1），目标字节置 1，否则置 0。', flags: '不改变标志位', forms: ['setbe 字节寄存器'], eg: 'cmp eax, ecx / setbe al', tip: 'be = below or equal；无符号比较看 CF，有符号看 SF 与 OF 的组合。', },
    { name: 'sal', cn: '算术左移', cat: 'shift', desc: '和 shl 完全等价的另一种写法：整体左移，低位补 0，最高位移进 CF。', flags: '影响 CF、OF、ZF、SF、PF', forms: ['sal 目标, 位数'], eg: 'sal eax, 1', tip: '左移没有「算术 / 逻辑」区别，所以 sal 和 shl 是同一条指令。', },
    { name: 'hlt', cn: '停机', cat: 'misc', desc: '让处理器停下，等待中断。在用户程序里一般不会出现，属于特权指令。', flags: '不影响标志位', forms: ['hlt'], eg: 'hlt', tip: '本工具的模拟器把它当作停机处理，用来结束程序。', },
    { name: 'adc', cn: '带进位加法', cat: 'arith', desc: '目标 = 目标 + 源 + CF。用于把多个字节 / 长整数分段相加时把低位产生的进位带上来。', flags: '影响 CF、OF、ZF、SF、PF', forms: ['adc 目标, 源'], eg: 'adc rax, rcx', tip: '和 add 的唯一区别就是多加了 CF，多精度加法必须用它。', },
    { name: 'sbb', cn: '带借位减法', cat: 'arith', desc: '目标 = 目标 - 源 - CF。用于多精度减法，把低位借的位继续往下扣。', flags: '影响 CF、OF、ZF、SF、PF', forms: ['sbb 目标, 源'], eg: 'sbb rax, rcx', tip: '和 sub 的区别是多减了 CF（借位）。', },
    { name: 'cmove', cn: '相等则搬（条件传送）', cat: 'ctrl', desc: '如果 ZF=1（上一次比较相等），把源操作数写进目标；否则目标保持不变。', flags: '不改变标志位', forms: ['cmove 目标, 源'], eg: 'cmove eax, ecx', tip: 'cmov 系列没有分支，编译器常用它替代「if 里只赋一次值」，避免分支预测失败。', },
    { name: 'cmovne', cn: '不相等则搬', cat: 'ctrl', desc: '如果 ZF=0（上一次比较不相等），把源写进目标。', flags: '不改变标志位', forms: ['cmovne 目标, 源'], eg: 'cmovne eax, ecx', tip: '和 cmove 互补，条件正好相反。', },
    { name: 'cmovl', cn: '小于则搬（有符号）', cat: 'ctrl', desc: '如果上一次有符号比较结果是「小于」（SF≠OF），把源写进目标。', flags: '不改变标志位', forms: ['cmovl 目标, 源'], eg: 'cmovl eax, ecx', tip: '有符号用 l/g，无符号用 b/a。', },
    { name: 'cmovg', cn: '大于则搬（有符号）', cat: 'ctrl', desc: '如果上一次有符号比较结果是「大于」（ZF=0 且 SF=OF），把源写进目标。', flags: '不改变标志位', forms: ['cmovg 目标, 源'], eg: 'cmovg eax, ecx', tip: '条件传送要求源和目标不能同时为内存。', },
    { name: 'cmovle', cn: '小于等于则搬（有符号）', cat: 'ctrl', desc: '如果上一次有符号比较结果是「小于等于」（ZF=1 或 SF≠OF），把源写进目标。', flags: '不改变标志位', forms: ['cmovle 目标, 源'], eg: 'cmovle eax, ecx', tip: '', },
    { name: 'cmovge', cn: '大于等于则搬（有符号）', cat: 'ctrl', desc: '如果上一次有符号比较结果是「大于等于」（SF=OF），把源写进目标。', flags: '不改变标志位', forms: ['cmovge 目标, 源'], eg: 'cmovge eax, ecx', tip: '', },
    { name: 'cltq', cn: 'eax 符号扩展到 rax（AT&T 写法）', cat: 'arith', desc: '和 cdqe 是同一条指令，只是 AT&T 语法的助记符名字。', flags: '不影响标志位', forms: ['cltq'], eg: 'cltq', tip: 'GCC 的 AT&T 输出里叫 cltq，Intel 语法里叫 cdqe，含义一致。', },
    { name: 'cwd', cn: 'ax 符号扩展到 dx:ax', cat: 'arith', desc: '把 ax 的符号位扩展到 dx，为 16 位 idiv 准备被除数。', flags: '不影响标志位', forms: ['cwd'], eg: 'cwd', tip: '16 位除法才用它；32 位用 cdq，64 位用 cqo。', },
    { name: 'cqto', cn: 'rax 符号扩展到 rdx:rax（AT&T 写法）', cat: 'arith', desc: '和 cqo 是同一条指令，AT&T 语法下的名字。', flags: '不影响标志位', forms: ['cqto'], eg: 'cqto', tip: '看到 cqto 就想到「64 位 idiv 前的准备工作」。', },
    { name: 'movd', cn: '32 位通用/浮点传送', cat: 'fpu', desc: '在通用寄存器（或内存）和 xmm 寄存器之间搬 32 位数据，不做格式转换。', flags: '不影响标志位', forms: ['movd xmm, r32', 'movd r32, xmm'], eg: 'movd xmm0, eax', tip: 'movd 搬的是原始位模式，不是数值转换；要转数值用 cvtsi2sd。', },
    { name: 'movq', cn: '64 位通用/浮点传送', cat: 'fpu', desc: '在通用寄存器（或内存）和 xmm 之间搬 64 位数据，也不做格式转换。', flags: '不影响标志位', forms: ['movq xmm, r64', 'movq r64, xmm'], eg: 'movq xmm0, rax', tip: '和 movd 的关系就像 64 位对 32 位。', },
    { name: 'movaps', cn: '对齐的 128 位搬移', cat: 'fpu', desc: '在 xmm 之间或 xmm 与内存之间搬 16 个字节，要求内存地址 16 字节对齐，否则会异常。', flags: '不影响标志位', forms: ['movaps xmm, xmm/m128'], eg: 'movaps xmm0, xmm1', tip: '地址没对齐就崩，这是新手最常见的段错误来源之一；不确定时用 movups。', },
    { name: 'movups', cn: '不对齐的 128 位搬移', cat: 'fpu', desc: '和 movaps 一样搬 16 字节，但允许任意地址对齐。', flags: '不影响标志位', forms: ['movups xmm, xmm/m128'], eg: 'movups xmm0, [rax]', tip: 'u = unaligned；性能略低但绝不因对齐出错。', },
    { name: 'comisd', cn: '比较两个 double（会报异常）', cat: 'fpu', desc: '比较两个双精度浮点数，设置 ZF/PF/CF，用来判断大小。和 ucomisd 的唯一区别是遇到 NaN 会触发无效操作异常。', flags: '影响 ZF、PF、CF（不影响 OF/SF）', forms: ['comisd xmm, xmm/m64'], eg: 'comisd xmm0, xmm1', tip: '浮点比较之后要用 ja/jae/jb/jbe（无符号条件），因为浮点只看 CF 和 ZF。', },
    { name: 'ucomiss', cn: '比较两个 float（不报异常）', cat: 'fpu', desc: '比较两个单精度浮点数，设置 ZF/PF/CF。遇到 NaN 只置标志位、不触发异常。', flags: '影响 ZF、PF、CF', forms: ['ucomiss xmm, xmm/m32'], eg: 'ucomiss xmm0, xmm1', tip: '单精度版是 ucomiss，双精度版是 ucomisd，注意末尾多一个 s。', },
    { name: 'comiss', cn: '比较两个 float（会报异常）', cat: 'fpu', desc: '比较两个单精度浮点数并设置 ZF/PF/CF，NaN 参与时会触发无效操作异常。', flags: '影响 ZF、PF、CF', forms: ['comiss xmm, xmm/m32'], eg: 'comiss xmm0, xmm1', tip: '编译器一般优先用 ucomiss，因为它不会因 NaN 抛异常。', },
    { name: 'xorps', cn: '单精度浮点寄存器清零', cat: 'fpu', desc: '同一个 xmm 寄存器和自己异或，结果为全 0，常用于把单精度浮点寄存器清零。', flags: '不影响标志位', forms: ['xorps xmm, xmm'], eg: 'xorps xmm0, xmm0', tip: '和 xorpd 功能一样，只是指令编码针对单精度；清零效果完全相同。', },
    { name: 'pxor', cn: '整数型 xmm 异或', cat: 'fpu', desc: '对两个 xmm 寄存器按 128 位整数做按位异或，自己异或自己就是清零。', flags: '不影响标志位', forms: ['pxor xmm, xmm'], eg: 'pxor xmm0, xmm0', tip: 'p 开头表示「打包整数运算」；清零时它和 xorps 效果一样。', },
    { name: 'addss', cn: '单精度浮点加法', cat: 'fpu', desc: '把两个 float 相加，结果留在目标 xmm 的低 32 位。', flags: '影响 ZF、PF、CF（浮点标志）', forms: ['addss xmm, xmm/m32'], eg: 'addss xmm0, xmm1', tip: 'sd = scalar double，ss = scalar single；float 用 ss，double 用 sd。', },
    { name: 'subss', cn: '单精度浮点减法', cat: 'fpu', desc: '目标 float 减去源 float，结果留在目标 xmm 低 32 位。', flags: '影响 ZF、PF、CF', forms: ['subss xmm, xmm/m32'], eg: 'subss xmm0, xmm1', tip: '注意方向：subss xmm0, xmm1 算的是 xmm0 - xmm1。', },
    { name: 'mulss', cn: '单精度浮点乘法', cat: 'fpu', desc: '两个 float 相乘，结果留在目标 xmm 低 32 位。', flags: '影响 ZF、PF、CF', forms: ['mulss xmm, xmm/m32'], eg: 'mulss xmm0, xmm1', tip: '浮点乘法不会影响整数标志位，别拿 jz 去判断浮点结果。', },
    { name: 'divss', cn: '单精度浮点除法', cat: 'fpu', desc: '目标 float 除以源 float，结果留在目标 xmm 低 32 位。', flags: '影响 ZF、PF、CF', forms: ['divss xmm, xmm/m32'], eg: 'divss xmm0, xmm1', tip: '除零得到 inf 或 NaN，不会像整数 idiv 那样让程序崩掉。', },
    { name: 'cvtsi2ss', cn: '整数转单精度', cat: 'fpu', desc: '把通用寄存器里的整数转换成 float，写进 xmm 低 32 位。', flags: '不影响标志位', forms: ['cvtsi2ss xmm, r32/r64'], eg: 'cvtsi2ss xmm0, eax', tip: 'si = signed integer，ss = single；int→float 用它，int→double 用 cvtsi2sd。', },
    { name: 'cvttss2si', cn: '单精度转整数（截断）', cat: 'fpu', desc: '把 float 转成整数（截断取整，直接丢掉小数部分），写进通用寄存器。', flags: '不影响标志位', forms: ['cvttss2si r32/r64, xmm'], eg: 'cvttss2si eax, xmm0', tip: 'tt 表示「截断」：3.9 变成 3，-3.9 变成 -3，不是四舍五入。', },
    { name: 'sqrtsd', cn: '双精度平方根', cat: 'fpu', desc: '对 xmm 里的双精度浮点数开平方，结果写回目标 xmm。', flags: '影响 ZF、PF、CF', forms: ['sqrtsd xmm, xmm/m64'], eg: 'sqrtsd xmm0, xmm1', tip: '对负数开方得到 NaN，不会崩溃，但后续比较都会失真。', }
  ];

  const INSTR_MAP = {};
  INSTRS.forEach(i => { INSTR_MAP[i.name] = i; });

  /* ---------------- 寄存器知识 ----------------
   * 只保留教学常用部分：64/32/16/8 位别名关系
   */
  const REG_FAMILIES = [
    { r64: 'rax', r32: 'eax', r16: 'ax', r8l: 'al', r8h: 'ah', use: '返回值 / 累加器 / 乘法除法专用' },
    { r64: 'rbx', r32: 'ebx', r16: 'bx', r8l: 'bl', r8h: 'bh', use: '被调用者保存，常作基址' },
    { r64: 'rcx', r32: 'ecx', r16: 'cx', r8l: 'cl', r8h: 'ch', use: '计数 / 循环 / 移位位数' },
    { r64: 'rdx', r32: 'edx', r16: 'dx', r8l: 'dl', r8h: 'dh', use: '除法余数 / 第二返回值' },
    { r64: 'rsi', r32: 'esi', r16: 'si', r8l: 'sil', r8h: null, use: '源索引 / 第 2 个参数' },
    { r64: 'rdi', r32: 'edi', r16: 'di', r8l: 'dil', r8h: null, use: '目的索引 / 第 1 个参数' },
    { r64: 'rbp', r32: 'ebp', r16: 'bp', r8l: 'bpl', r8h: null, use: '栈基址指针（栈帧的锚点）' },
    { r64: 'rsp', r32: 'esp', r16: 'sp', r8l: 'spl', r8h: null, use: '栈顶指针（永远指向栈顶）' }
  ];
  for (let i = 8; i <= 15; i++) {
    REG_FAMILIES.push({ r64: 'r' + i, r32: 'r' + i + 'd', r16: 'r' + i + 'w', r8l: 'r' + i + 'b', r8h: null, use: '通用寄存器' });
  }

  const REG_DOC = {}; // name -> {family, bits, tip}
  REG_FAMILIES.forEach(f => {
    const mk = (n, bits) => { if (!n) return; REG_DOC[n] = { family: f, bits: bits, tip: f.use }; };
    mk(f.r64, 64); mk(f.r32, 32); mk(f.r16, 16); mk(f.r8l, 8); mk(f.r8h, 8);
  });
  REG_DOC['rip'] = { family: null, bits: 64, tip: '指令指针：下一条要执行的指令的地址' };
  REG_DOC['rflags'] = { family: null, bits: 64, tip: '标志寄存器：ZF/SF/CF/OF 等' };
  REG_DOC['eflags'] = REG_DOC['rflags'];
  // SSE 浮点寄存器：整数走通用寄存器，小数走 xmm
  for (let i = 0; i <= 15; i++) {
    REG_DOC['xmm' + i] = {
      family: null, bits: 128,
      tip: i < 8 ? 'SSE 浮点寄存器（第 ' + (i + 1) + ' 个，也用于传浮点参数）' : 'SSE 浮点寄存器'
    };
  }

  const REG_NAMES = Object.keys(REG_DOC);

  /* ---------------- 示例程序 ---------------- */
  const EXAMPLES_C = [
    {
      name: '两数相加',
      desc: '最简单的顺序结构：变量 + 算术 + 输出',
      code:
`#include <stdio.h>

int main() {
    int a = 5;
    int b = 3;
    int c = a + b;
    printf("c = %d\\n", c);
    return 0;
}`
    },
    {
      name: '1 到 10 累加（while）',
      desc: '循环 + 累加器，观察栈变量在循环中反复变化',
      code:
`#include <stdio.h>

int main() {
    int sum = 0;
    int i = 1;
    while (i <= 10) {
        sum = sum + i;
        i = i + 1;
    }
    printf("sum = %d\\n", sum);
    return 0;
}`
    },
    {
      name: '判断奇偶（if / else）',
      desc: '除法取余 + 条件分支',
      code:
`#include <stdio.h>

int main() {
    int n = 7;
    int r = n % 2;
    if (r == 0) {
        printf("%d is even\\n", n);
    } else {
        printf("%d is odd\\n", n);
    }
    return 0;
}`
    },
    {
      name: '求最大值（if / else）',
      desc: '带比较与两分支赋值',
      code:
`#include <stdio.h>

int main() {
    int a = 12;
    int b = 25;
    int max = 0;
    if (a > b) {
        max = a;
    } else {
        max = b;
    }
    printf("max = %d\\n", max);
    return 0;
}`
    },
    {
      name: 'for 循环求阶乘',
      desc: 'for 循环 + 乘法',
      code:
`#include <stdio.h>

int main() {
    int n = 5;
    int f = 1;
    int i = 1;
    for (i = 1; i <= n; i = i + 1) {
        f = f * i;
    }
    printf("%d! = %d\\n", n, f);
    return 0;
}`
    },
    {
      name: '指针：交换两个数',
      desc: '指针做参数 + 取地址 & + 解引用 *，观察函数如何改调用者的变量',
      code:
`#include <stdio.h>

void swap(int *a, int *b) {
    int t = *a;
    *a = *b;
    *b = t;
}

int main() {
    int x = 3;
    int y = 9;
    printf("before: x=%d y=%d\\n", x, y);
    swap(&x, &y);
    printf("after : x=%d y=%d\\n", x, y);
    return 0;
}`
    },
    {
      name: '数组与指针遍历',
      desc: '数组名退化为首地址，指针算术按元素大小缩放',
      code:
`#include <stdio.h>

int main() {
    int a[5] = { 10, 20, 30, 40, 50 };
    int *p = a;
    int sum = 0;
    for (int i = 0; i < 5; i++) {
        sum = sum + *(p + i);
    }
    printf("sum = %d\\n", sum);
    printf("a[2] = %d, *(a+2) = %d\\n", a[2], *(a + 2));
    return 0;
}`
    },
    {
      name: '结构体：学生信息',
      desc: 'struct 定义、成员访问 .、结构体指针 ->、成员在栈上的偏移',
      code:
`#include <stdio.h>

struct Student {
    int id;
    double score;
};

void printStudent(struct Student *s) {
    printf("id=%d score=%.1f\\n", s->id, s->score);
}

int main() {
    struct Student s;
    s.id = 1001;
    s.score = 91.5;
    printStudent(&s);

    struct Student *p = &s;
    p->score = 95.0;
    printf("after update: %.1f\\n", s.score);
    return 0;
}`
    },
    {
      name: '浮点数：圆面积',
      desc: 'double 常量、浮点乘法、%.3f 输出，观察 xmm 寄存器与 SSE 指令',
      code:
`#include <stdio.h>

int main() {
    double r = 2.5;
    double pi = 3.14159;
    double area = pi * r * r;
    double round = 2.0 * pi * r;
    printf("area = %.3f\\n", area);
    printf("round = %.3f\\n", round);
    return 0;
}`
    },
    {
      name: '综合：结构体数组求平均分',
      desc: '结构体数组 + 指针参数 + 浮点累加，把前面的知识合起来',
      code:
`#include <stdio.h>

struct Student {
    int id;
    double score;
};

double average(struct Student *s, int n) {
    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        sum += s[i].score;
    }
    return sum / n;
}

int main() {
    struct Student a[3];
    a[0].id = 1;  a[0].score = 88.5;
    a[1].id = 2;  a[1].score = 92.0;
    a[2].id = 3;  a[2].score = 76.5;
    printf("avg = %.2f\\n", average(a, 3));
    return 0;
}`
    }
  ];

  const EXAMPLES_ASM = [
    {
      name: '顺序计算（无函数框架）',
      desc: '最朴素的几条指令，适合第一次点"单步"',
      code:
`; 计算 (20 + 4) * 3 然后结束
    mov eax, 20
    mov ecx, 4
    add eax, ecx      ; eax = 24
    imul eax, 3       ; eax = 72
    nop`
    },
    {
      name: '完整的栈帧（手工版 main）',
      desc: '观察 push rbp / sub rsp / leave 如何组织栈',
      code:
`main:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    mov DWORD PTR [rbp-4], 10    ; a = 10
    mov DWORD PTR [rbp-8], 20    ; b = 20
    mov eax, DWORD PTR [rbp-4]
    add eax, DWORD PTR [rbp-8]
    mov DWORD PTR [rbp-12], eax  ; c = a + b
    mov eax, 0
    leave
    ret`
    },
    {
      name: '循环累加（手工版）',
      desc: 'cmp + jle 构成循环，观察 ZF 如何控制跳转',
      code:
`main:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    mov DWORD PTR [rbp-4], 0     ; sum = 0
    mov DWORD PTR [rbp-8], 1     ; i = 1
.L2:
    cmp DWORD PTR [rbp-8], 5
    jg .L3
    mov eax, DWORD PTR [rbp-4]
    add eax, DWORD PTR [rbp-8]
    mov DWORD PTR [rbp-4], eax
    add DWORD PTR [rbp-8], 1
    jmp .L2
.L3:
    mov eax, 0
    leave
    ret`
    },
    {
      name: '调用 printf 输出',
      desc: '参数寄存器 + call + 只读数据段',
      code:
`    .section .rodata
.LC0:
    .string "answer = %d\\n"

main:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    mov DWORD PTR [rbp-4], 42
    lea rdi, [.LC0]
    mov esi, DWORD PTR [rbp-4]
    mov eax, 0
    call printf
    mov eax, 0
    leave
    ret`
    },
    {
      name: '浮点相加（SSE 指令）',
      desc: 'xmm 寄存器 + addsd + .quad 浮点常量，对比整数版的加法',
      code:
`; 3.14 + 2.0，结果 5.14
    .section .rodata
.LC0:
    .string "sum = %.2f\\n"
.LF0:
    .quad 0x40091eb851eb851f     ; 双精度 3.14
.LF1:
    .quad 0x4000000000000000     ; 双精度 2.0

main:
    push rbp
    mov rbp, rsp
    sub rsp, 16
    movsd xmm0, QWORD PTR [.LF0]
    addsd xmm0, QWORD PTR [.LF1]
    lea rdi, [.LC0]
    mov eax, 1                   ; 有 1 个浮点参数
    call printf
    mov eax, 0
    leave
    ret`
    },
    {
      name: '指针遍历（手工版）',
      desc: '观察 lea 取地址、movsxd 扩展下标、乘 4 缩放',
      code:
`    .section .rodata
.LC0:
    .string "sum = %d\\n"

main:
    push rbp
    mov rbp, rsp
    sub rsp, 32
    mov DWORD PTR [rbp-12], 10   ; a[0] 在最低地址
    mov DWORD PTR [rbp-8], 20    ; a[1]
    mov DWORD PTR [rbp-4], 30    ; a[2]
    mov DWORD PTR [rbp-16], 0    ; sum = 0
    mov DWORD PTR [rbp-20], 0    ; i = 0
.L2:
    cmp DWORD PTR [rbp-20], 3
    jge .L3
    lea rax, [rbp-12]            ; a 的首地址（最低的那个）
    movsxd rcx, DWORD PTR [rbp-20]
    imul rcx, rcx, 4             ; 每个元素 4 字节
    add rax, rcx
    mov ecx, DWORD PTR [rax]
    add DWORD PTR [rbp-16], ecx
    add DWORD PTR [rbp-20], 1
    jmp .L2
.L3:
    lea rdi, [.LC0]
    mov esi, DWORD PTR [rbp-16]
    mov eax, 0
    call printf
    mov eax, 0
    leave
    ret`
    }
  ];

  const API = {
    CAT, INSTRS, INSTR_MAP, REG_FAMILIES, REG_DOC, REG_NAMES,
    EXAMPLES_C, EXAMPLES_ASM,
    // 按分类取色
    catOf(name) { return CAT[name] || CAT.misc; }
  };

  global.ASM_DATA = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
