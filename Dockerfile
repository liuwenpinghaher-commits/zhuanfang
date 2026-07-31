# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:25-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# postinstall runs copy:vad-assets — script must exist before npm ci
COPY scripts/copy-vad-assets.mjs ./scripts/
RUN npm ci

FROM deps AS build
ARG VITE_PRODUCT_API_BASE_URL=
ENV VITE_PRODUCT_API_BASE_URL=${VITE_PRODUCT_API_BASE_URL}
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3210 \
    DEPLOYMENT_PROFILE=production \
    PRODUCT_STATIC_DIR=/app/dist \
    PRODUCT_STATE_DB_PATH=/app/.data/product-state.db \
    CORPUS_UPLOAD_DIR=/app/.data/corpus-audio
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime serves SPA from dist/ (VAD assets already baked by build). Skip lifecycle
# scripts so install does not require browser asset copy tooling.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY apps ./apps
COPY packages ./packages
COPY src ./src
RUN mkdir -p /app/.data/corpus-audio && chown -R node:node /app
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3210') + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "run", "start:api"]
