@echo off
rem 本地AI对话工作台 · 停止所有 node 进程（含最小化启动的那个）
rem 注意：会一并结束本机其它 node 程序（DSH、编辑器插件等），确认后再用。
echo 正在结束 node.exe ……
taskkill /IM node.exe /F >nul 2>nul
if errorlevel 1 (
  echo   没有找到正在运行的 node.exe
) else (
  echo   已结束
)
timeout /t 2 >nul
