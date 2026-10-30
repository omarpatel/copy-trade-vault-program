# Build context: repository root (pnpm workspace).
FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# curl: the wallet directory's GMGN source goes through it (Cloudflare blocks Node's TLS client there).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile --filter @copy-trade-vault/indexer...

COPY tsconfig.base.json ./
COPY packages/sdk packages/sdk
COPY apps/indexer apps/indexer

# SQLite DB + local uploads live on a volume mounted at /data. HOST=:: listens dual-stack (some private networks are
# IPv6 only). TRUST_PROXY is left to the environment.
ENV NODE_ENV=production HOST=:: PORT=8790 DB_PATH=/data/indexer.db FILES_DIR=/data/files
WORKDIR /app/apps/indexer
EXPOSE 8790
# node is PID 1, so SIGTERM reaches the indexer's graceful shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
