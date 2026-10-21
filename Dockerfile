# syntax=docker/dockerfile:1.7
# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Dependency layer: only lockfile + manifests, so source edits don't bust the cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/demo/package.json apps/demo/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
 && pnpm --filter @gamenotify/server deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/web

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
# Production by default: refuses to start with dev secrets and hides /v1/dev/*.
# Run with NODE_ENV=development for the demo UI (docker-compose.yml does).
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
