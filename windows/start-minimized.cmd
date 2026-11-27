@echo off
rem ============================================================
rem  本地AI对话工作台 · Windows 最小化启动（不占桌面）
rem
rem  用法：
rem    start-minimized.cmd              默认 5178，只监听本机
rem    start-minimized.cmd 5178 0.0.0.0 手机也能连
rem
rem  实际逻辑都在 start.cmd 里（Node 探测 / 自动下载便携版），
rem  这里只是把它丢进一个最小化的窗口。
rem  想开机自启：右键本文件 → 发送到 → 桌面快捷方式，
rem  再把快捷方式放进  shell:startup  文件夹。
rem  停止：任务管理器里结束 node.exe（或跑 stop.cmd）
rem ============================================================
chcp 65001 >nul

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5178"
set "HOST=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"

start "本地AI对话工作台 %PORT%" /min "%~dp0start.cmd" %PORT% %HOST%
echo   已在最小化窗口里启动： http://127.0.0.1:%PORT%
timeout /t 2 >nul
