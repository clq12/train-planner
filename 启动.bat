@echo off
chcp 65001 >nul
echo 🚂 车票路径规划器 - 正在启动...
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js
    echo 📥 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 安装依赖
echo 📦 正在安装依赖...
call npm install --production
if %errorlevel% neq 0 (
    echo ⚠️ 依赖安装失败，尝试继续...
)

:: 启动服务
echo 🚀 正在启动服务...
start http://localhost:3000
node server.js
pause
