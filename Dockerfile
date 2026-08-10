# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:25-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# ignore-scripts: 跳过 onnxruntime-node 原生二进制下载（国内 302/失败）；生产默认用云端 embed
# @surrealdb/node 不在 npmmirror，必须走官方 registry
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
# postinstall runs copy:vad-assets — script must exist before npm ci
COPY scripts/copy-vad-assets.mjs ./scripts/
RUN npm ci --ignore-scripts \
 && node scripts/copy-vad-assets.mjs

FROM deps AS build
ARG VITE_PRODUCT_API_BASE_URL=
ARG VITE_BASE=/
ENV VITE_PRODUCT_API_BASE_URL=${VITE_PRODUCT_API_BASE_URL}
ENV VITE_BASE=${VITE_BASE}
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    DEPLOYMENT_PROFILE=production \
    PRODUCT_STATIC_DIR=/app/dist \
    PRODUCT_STATE_DB_PATH=/app/.data/product-state.db \
    CORPUS_UPLOAD_DIR=/app/.data/corpus-audio \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    OTEL_SDK_DISABLED=true
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime serves SPA from dist/ (VAD assets already baked by build). Skip lifecycle
# scripts so install does not require browser asset copy tooling / onnx native download.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY apps ./apps
COPY packages ./packages
COPY src ./src
RUN mkdir -p /app/.data/corpus-audio && chown -R node:node /app
USER node
EXPOSE 3210
# Require readiness (ready:true), not mere HTTP 200 / ok:true — persist.degraded keeps
# the process alive but must fail the container healthcheck so orchestrators do not
# route traffic to a write-untrusted instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3210')+'/api/health').then(async(r)=>{if(!r.ok)process.exit(1);const j=await r.json();process.exit(j&&j.ready===true?0:1)}).catch(()=>process.exit(1))"
CMD ["npm", "run", "start:api"]
