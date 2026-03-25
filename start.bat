@echo off
chcp 65001 >nul
echo 正在启动小米摄像头录像查看器...
echo 按 Ctrl+C 停止服务
echo --------------------------------------------------
node server.js
pause
