@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   汇编学习台 · 打包成单文件 exe
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [x] 没有找到 node，请先安装 Node.js 18+ 并加入 PATH
    pause
    exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
    echo [x] 没有找到 python，请先安装 Python 3
    pause
    exit /b 1
)

python build\make-exe.py
if errorlevel 1 (
    echo.
    echo [x] 打包失败，看上面的错误信息
    pause
    exit /b 1
)

echo.
echo 完成：dist\汇编学习台.exe
pause
