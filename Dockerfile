# 票路 · 单机部署镜像
# 适用于：阿里云/腾讯云 轻量应用服务器（香港或国内）、任意 VPS
FROM node:20-alpine

WORKDIR /app

# 用国内镜像源，避免在香港/国内拉包超时
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force

COPY server.js ./
COPY public ./public
COPY vercel.json ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
