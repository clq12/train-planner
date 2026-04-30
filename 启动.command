#!/bin/bash
cd "$(dirname "$0")"
echo "🚂 车票路径规划器 - 正在启动..."
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js"
    echo "📥 下载地址: https://nodejs.org/"
    exit 1
fi

# 安装依赖
echo "📦 正在安装依赖..."
npm install --production 2>/dev/null

# 启动服务
echo "🚀 正在启动服务..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open http://localhost:3000
else
    xdg-open http://localhost:3000 2>/dev/null || sensible-browser http://localhost:3000 2>/dev/null &
fi
node server.js
