# -*- coding: utf-8 -*-
"""
make-exe.py · 把整个工具打成单文件 Windows 可执行程序

原理（Node 官方 SEA / Single Executable Application）：
  1. node --experimental-sea-config 生成 sea-prep.blob（内含主脚本 + 前端静态资源）
  2. 复制 node.exe
  3. 把 SEA 熔断开关 NODE_SEA_FUSE_...:0 改成 :1（否则 exe 仍按普通 node 运行）
  4. 用 Win32 资源接口把 blob 写成 exe 的 NODE_SEA_BLOB 资源
  5. 双击 exe → 它就是「node + 本工具」，不需要单独装 Node

用法：python build/make-exe.py
"""
import ctypes
import ctypes.wintypes as wt
import os
import shutil
import struct
import subprocess
import sys
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
BLOB = BUILD / "sea-prep.blob"
EXE_NAME = "汇编学习台.exe"
FUSE = b"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0"
RES_NAME = "NODE_SEA_BLOB"
RT_RCDATA = 10   # 关键：类型必须是 RT_RCDATA，名称才是 NODE_SEA_BLOB


def step(msg):
    print("[*] " + msg)


def fail(msg):
    print("[x] " + msg)
    sys.exit(1)


def run(cmd):
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    if p.returncode != 0:
        fail("命令失败：%s\n%s\n%s" % (" ".join(cmd), p.stdout, p.stderr))
    return p.stdout


def pick_node():
    """优先标准安装版的 node，其次 PATH 里的"""
    cands = [
        r"C:/Program Files/nodejs/node.exe",
        r"C:/Program Files (x86)/nodejs/node.exe",
        shutil.which("node"),
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def set_gui_subsystem(exe):
    """把 PE 的 Subsystem 从「控制台」改成「窗口」：双击不再弹黑色命令行窗口。
    返回原来的值，方便出错时回滚。"""
    b = bytearray(exe.read_bytes())
    e_lfanew = struct.unpack_from("<I", b, 0x3C)[0]
    if bytes(b[e_lfanew:e_lfanew + 4]) != b"PE\0\0":
        return None
    opt = e_lfanew + 24
    # PE32 与 PE32+ 的 Subsystem 字段都在 Optional Header + 68
    sub_off = opt + 68
    old = struct.unpack_from("<H", b, sub_off)[0]
    struct.pack_into("<H", b, sub_off, 2)   # 2 = WINDOWS_GUI
    exe.write_bytes(bytes(b))
    return old


def probe_health(exe, port, timeout=25):
    """自检：启动服务并请求 /api/health，确认真能跑起来"""
    proc = subprocess.Popen([str(exe), "--no-window", "--quiet", "--port", str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/api/health" % port, timeout=2) as r:
                    return True, r.read().decode("utf-8")
            except Exception:
                if proc.poll() is not None:
                    return False, "进程提前退出，退出码 %s" % proc.returncode
                time.sleep(0.4)
        return False, "等待 %d 秒仍未响应" % timeout
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def main():
    node = pick_node()
    if not node:
        fail("找不到 node.exe，请先安装 Node.js 18+ 并加入 PATH")

    # 1) 合成主脚本
    step("合成主脚本 build/bundle.js")
    run([node, str(BUILD / "make-bundle.js")])

    # 2) 生成 SEA blob
    step("生成 SEA blob（含前端静态资源）")
    run([node, "--experimental-sea-config", "sea-config.json"])
    if not BLOB.exists():
        fail("没有生成 " + str(BLOB))
    print("    blob 大小 %.1f MB" % (BLOB.stat().st_size / 1048576.0))

    # 3) 复制 node.exe
    DIST.mkdir(exist_ok=True)
    exe = DIST / EXE_NAME
    if exe.exists():
        try:
            exe.unlink()
        except OSError:
            fail("dist/%s 正在运行或被占用，先关掉它再打包" % EXE_NAME)
    ver = subprocess.run([node, "-v"], capture_output=True, text=True).stdout.strip()
    step("复制运行时：%s（%s）" % (node, ver))
    shutil.copy2(node, exe)

    # 4) 打开 SEA 熔断开关
    step("打开 SEA 熔断开关")
    buf = bytearray(exe.read_bytes())
    idx = bytes(buf).find(FUSE)
    if idx < 0:
        fail("这个 node.exe 里找不到 SEA fuse，可能是不支持 SEA 的版本")
    buf[idx + len(FUSE) - 1] = ord("1")
    exe.write_bytes(bytes(buf))

    # 5) 注入资源
    step("注入 NODE_SEA_BLOB 资源")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.BeginUpdateResourceW.argtypes = [wt.LPCWSTR, wt.BOOL]
    k32.BeginUpdateResourceW.restype = wt.HANDLE
    k32.UpdateResourceW.argtypes = [wt.HANDLE, wt.LPVOID, wt.LPVOID, wt.WORD,
                                    ctypes.c_void_p, wt.DWORD]
    k32.UpdateResourceW.restype = wt.BOOL
    k32.EndUpdateResourceW.argtypes = [wt.HANDLE, wt.BOOL]
    k32.EndUpdateResourceW.restype = wt.BOOL

    h = k32.BeginUpdateResourceW(str(exe), False)
    if not h:
        fail("BeginUpdateResource 失败，错误码 %d" % ctypes.get_last_error())

    data = BLOB.read_bytes()
    cbuf = ctypes.create_string_buffer(data, len(data))
    # 类型是整数 RT_RCDATA，名称是字符串 NODE_SEA_BLOB —— 两者都用字符串会直接崩
    rtype = ctypes.cast(ctypes.c_void_p(RT_RCDATA), wt.LPVOID)
    rname = ctypes.c_wchar_p(RES_NAME)
    ok = k32.UpdateResourceW(h, rtype, rname, 0,
                             ctypes.cast(cbuf, ctypes.c_void_p), len(data))
    if not ok:
        k32.EndUpdateResourceW(h, True)
        fail("UpdateResource 失败，错误码 %d" % ctypes.get_last_error())
    if not k32.EndUpdateResourceW(h, False):
        fail("EndUpdateResource 失败，错误码 %d" % ctypes.get_last_error())

    # 6) 去掉控制台窗口（双击直接开界面，不弹黑框）
    old_sub = set_gui_subsystem(exe)
    if old_sub is None:
        print("    警告：没找到 PE 头，保留控制台窗口")
    else:
        step("PE Subsystem %d → 2（窗口程序，双击不弹黑框）" % old_sub)

    size = exe.stat().st_size / 1048576.0
    step("完成：dist/%s（%.1f MB）" % (EXE_NAME, size))

    # 7) 自检：真正启动并请求接口
    step("自检：启动服务并请求 /api/health")
    ok, info = probe_health(exe, 41998)
    if not ok:
        fail("自检失败：" + info)
    print(info)
    step("双击 dist/%s 即可使用" % EXE_NAME)


if __name__ == "__main__":
    main()
