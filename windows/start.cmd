@echo off
rem ============================================================
rem  本地AI对话工作台 · Windows 启动脚本（双击即可）
rem
rem  用法：
rem    start.cmd                  默认 5178，只监听本机
rem    start.cmd 5179             换端口
rem    start.cmd 5178 0.0.0.0     同 Wi-Fi 的手机 / 平板也能连
rem
rem  Node 从哪来：优先用项目里的便携版 runtime\node\node.exe；
rem  没有就用系统 PATH 里的 node；两样都没有会先自动下载便携版。
rem  想手动装： https://nodejs.org/  （需要 18+）
rem  开机自启：把本文件的快捷方式丢进  shell:startup
rem ============================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set "NODE_EXE=node"
if exist "%~dp0..\runtime\node\node.exe" set "NODE_EXE=%~dp0..\runtime\node\node.exe"

if not exist "%~dp0..\runtime\node\node.exe" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   没找到 Node.js，先下载一份便携版到 runtime\ ...
    powershell -ExecutionPolicy Bypass -File "%~dp0get-node.ps1"
    if exist "%~dp0..\runtime\node\node.exe" (
      set "NODE_EXE=%~dp0..\runtime\node\node.exe"
    ) else (
      echo.
      echo   [错误] 便携版没下下来，系统里也没有 node。
      echo   请手动安装 Node.js 18+ ： https://nodejs.org/
      echo.
      pause
      exit /b 1
    )
  )
)

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5178"
set "HOST=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"

echo.
echo   启动中……  本机打开： http://127.0.0.1:%PORT%
echo   停止：按 Ctrl+C  或直接关掉本窗口
echo.

"%NODE_EXE%" start.js %PORT% %HOST%

echo.
echo   服务已停止（退出码 %ERRORLEVEL%）。
pause
