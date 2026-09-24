# syntax=docker/dockerfile:1

# The API's container image. Build it from the repository root, because the
# API runs the TypeScript source of three workspace packages that live beside
# it:
#
#     docker build -f apps/api/Dockerfile .
#
# Two stages. The first installs the API's workspace closure with the pnpm
# the root manifest pins and lets `pnpm deploy` lay the package out as one
# self-contained directory: its source, its production dependencies, and the
# workspace packages it runs (@waste/contracts, @waste/db, @waste/domain)
# copied in with their `src/`, since they ship source and there is nothing to
# compile (see the root CLAUDE.md, Workspace packages). The second stage is
# Node alone, running that directory as the unprivileged `node` user through
# tsx, the way `pnpm --filter @waste/api start` does, minus the --env-file: a
# container's environment comes from its host. Where the container runs is not
# decided here (docs/architecture/backend-architecture.md); this image serves
# every candidate.
#
# The API reads HOST, PORT, DATABASE_URL and SUPABASE_URL (apps/api/src/env.ts)
# and refuses to start without the last two.

# Node 22, the major .nvmrc names, on Alpine.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# pnpm at the version `packageManager` pins, read from the manifest so the two
# cannot drift. Installed with npm, which every Node image has: corepack is
# leaving Node's distribution (gone from Node 25).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"

# Every workspace manifest, so --frozen-lockfile can hold the lockfile to the
# workspace as a whole, and then only the API's closure is installed. This
# layer is redone when a manifest or the lockfile changes, not when source
# does.
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/tooling/package.json packages/tooling/
RUN pnpm install --frozen-lockfile --prod --filter @waste/api...

# The API and the three packages it runs. `pnpm deploy` resolves the same
# lockfile into /out: the tarballs come from the store the install above
# filled, and only pnpm's supply-chain check goes back to the registry, for
# release metadata, which is why this step is not --offline. Each workspace
# package is copied in whole; .dockerignore keeps tests and reference data out.
COPY apps/api apps/api
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm --filter @waste/api deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
# Liveness: the process answers. Readiness (the database answers) is GET
# /readyz, which is the balancer's question, not the container's. Shell form,
# so a PORT set at run time is the one probed; busybox wget fails on any
# status but 2xx.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node_modules/.bin/tsx", "src/server.ts"]
