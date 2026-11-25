# KIU-USCAS production images. UNTESTED IN THIS REPOSITORY'S DEVELOPMENT ENVIRONMENT (no Docker there): build and smoke-test
# on the target host following docs/DEPLOYMENT.md before relying on it.
#   docker build -f deploy/Dockerfile --target api -t kiu-uscas-api .
#   docker build -f deploy/Dockerfile --target web -t kiu-uscas-web .

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /repo
COPY . .
# Empty API base = the browser calls the same origin it was served from; the reverse proxy forwards /api to the API.
ENV VITE_API_URL=""
RUN pnpm install --frozen-lockfile \
  && pnpm exec prisma generate \
  && pnpm build

# ── API: runs migrations and the (idempotent) roles/permissions seed, then serves ──
FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* && corepack enable
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
RUN chown -R node:node /repo
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node apps/api/dist/seed/run.js && exec node apps/api/dist/main.js"]

# ── Web: static single-page apps behind Caddy (automatic HTTPS) ──
FROM caddy:2-alpine AS web
COPY --from=build /repo/apps/admin/dist /srv/admin
COPY --from=build /repo/apps/student-portal/dist /srv/wallet
COPY --from=build /repo/apps/reader/dist /srv/reader
COPY deploy/Caddyfile /etc/caddy/Caddyfile
