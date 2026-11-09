FROM node:26.13.0-slim AS base
RUN npm install -g pnpm@12.3.4
WORKDIR /app

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/mcp/package.json packages/mcp/

FROM manifests AS web
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
RUN pnpm build

FROM manifests AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --prod --filter "@ledgerly/server..."

# The server runs its TypeScript directly, so there is no compile step.
FROM node:26.13.0-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data
WORKDIR /app
# pdftotext reads the text layer of statement PDFs.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils qpdf \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app ./
COPY apps/server/src apps/server/src
COPY packages/core/src packages/core/src
COPY packages/db/src packages/db/src
COPY packages/mcp/src packages/mcp/src
COPY packages/db/drizzle packages/db/drizzle
COPY --from=web /app/apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:4310/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
