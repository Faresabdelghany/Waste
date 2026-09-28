# syntax=docker/dockerfile:1

# PROTOTYPE — throwaway, ticket #134: the Pilot image, the API and the worker
# in one container under apps/pilot/supervise.mjs (the shape of #128). The
# two existing recipes (apps/api/Dockerfile, apps/worker/Dockerfile) with
# both closures laid out, built from the repository root:
#
#     docker build -f apps/pilot/Dockerfile -t waste-pilot:proto .
#
# Both `pnpm deploy` directories live under /app/apps, each with its own
# node_modules (the shared dependencies are on disk twice; RSS, the gate, is
# not disk), and tsconfig.base.json two levels up so each package's
# `"extends": "../../tsconfig.base.json"` resolves as on a workstation. The
# supervisor runs each child as its own image would: `node --import tsx` in
# its deploy directory, TSX_TSCONFIG_PATH naming its tsconfig. Only the API's
# port is exposed; the worker's probes stay on loopback inside the container.
#
# The API reads HOST, PORT, DATABASE_URL and SUPABASE_URL; the worker reads
# WORKER_DATABASE_URL and DATABASE_URL, its HOST/PORT set by the supervisor
# (WORKER_HOST, WORKER_PORT). Render sets PORT.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

COPY package.json ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/tooling/package.json packages/tooling/
RUN pnpm install --frozen-lockfile --prod --filter @waste/api... --filter @waste/worker...

COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm --filter @waste/api deploy --prod /app/apps/api \
 && pnpm --filter @waste/worker deploy --prod /app/apps/worker
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/pilot/supervise.mjs /app/apps/pilot/supervise.mjs

# Both tsconfig chains resolve (the refusal comes when tsx's loader registers).
RUN cd /app/apps/api && TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --eval "console.log('api tsconfig read')" \
 && cd /app/apps/worker && TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --eval "console.log('worker tsconfig read')"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    WORKER_HOST=127.0.0.1 \
    WORKER_PORT=3002
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/pilot
USER node
EXPOSE 3001
# Liveness of the API, the container's one public process; the worker's
# health is the supervisor's restart lines in the log (#128, Q9).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "supervise.mjs"]
