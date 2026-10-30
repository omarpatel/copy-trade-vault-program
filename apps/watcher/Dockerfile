# Build context: repository root (pnpm workspace).
# The keeper key comes from the KEEPER_SECRET_KEY variable (JSON byte array or base58), never from the image.
FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/watcher/package.json apps/watcher/
RUN pnpm install --frozen-lockfile --filter @copy-trade-vault/watcher...

COPY tsconfig.base.json ./
COPY packages/sdk packages/sdk
COPY apps/watcher apps/watcher

# Keeper state (signatures, decisions, report queue) lives on a volume mounted at /data. /status listens dual-stack.
ENV NODE_ENV=production STATUS_HOST=:: PORT=8792 KEEPER_DB=/data/keeper.db
WORKDIR /app/apps/watcher
EXPOSE 8792
# node is PID 1, so SIGTERM reaches the keeper's graceful shutdown (flushes pending indexer reports).
CMD ["node", "--import", "tsx", "src/index.ts"]
