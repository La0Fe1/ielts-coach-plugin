# ---------------------------------------------------------------------------
#  IELTS Speaking Coach v2.2.0 — build stage
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install --no-audit --no-fund
# v2.1.0：只复制构建真正需要的源码/资源，避免把宿主机的 node_modules、.venv、
# 日志与缓存带进镜像（仓库没有 .dockerignore 时的安全做法）。
COPY shared/src ./shared/src
COPY shared/content ./shared/content
COPY shared/tsconfig.json ./shared/tsconfig.json
COPY server/src ./server/src
COPY server/tsconfig.json ./server/tsconfig.json
COPY web/src ./web/src
COPY web/public ./web/public
COPY web/index.html web/tsconfig.json web/vite.config.ts ./web/
# MCP / Skill 资产：镜像里 HTTP 模式直接可用；stdio 包装脚本也一并带上（可选）。
COPY skills ./skills
COPY scripts ./scripts
COPY ielts-mcp.bat ielts-mcp.sh ./
RUN npm run build

# ---------------------------------------------------------------------------
#  IELTS Speaking Coach v2.2.0 — runtime stage
#  The container path is the MCP Streamable HTTP endpoint: POST/GET /mcp
#  (same port as the web app). The stdio wrappers + scripts/ + skills/ are
#  copied too, so the same image can also be used by a local MCP client.
# ---------------------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    IELTS_COACH_DATA_DIR=/data
RUN mkdir -p /data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist

# v2.1.0: MCP + Skill assets (used by external AI tools; harmless in HTTP mode).
# v2.2.0: DeepSeek 纯语音依赖 @andresaya/edge-tts 已在 node_modules 中，无需额外的系统级 TTS 依赖；
COPY --from=build /app/skills ./skills
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/ielts-mcp.bat /app/ielts-mcp.sh ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1
CMD ["npm", "exec", "tsx", "--", "server/src/index.ts"]
