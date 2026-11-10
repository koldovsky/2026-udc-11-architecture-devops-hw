# syntax=docker/dockerfile:1
#
# Image for the Community Parcel Locker service (api, worker and the nightly expiry job).
# Build context is app/:  docker build -f deploy/Dockerfile app
#
# - base pinned by version AND digest: rebuilds are reproducible, updates are deliberate
#   (bump both together; Dependabot/Renovate can do it for the "docker" ecosystem);
# - no secrets in the image: SMS_TOKEN, DATABASE_URL etc. come only at runtime;
# - only the runtime code is copied (no tests, docs, .env, .git);
# - the code belongs to root and is read-only for the process, which runs as `node` (uid 1000).

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV NODE_ENV=production

WORKDIR /app

# The service has no npm dependencies, so there is no `npm ci` step.
# Add a separate build stage with `npm ci --omit=dev` if dependencies ever appear.
COPY package.json ./
COPY src ./src
COPY bin ./bin

USER node:node

EXPOSE 8080
STOPSIGNAL SIGTERM

# Health check of the default command (the API). The slim image has no curl, so it uses node's fetch.
# The same image also runs the worker and the nightly job, which have no HTTP server:
# compose.yaml explicitly disables this check for them (they publish no ports).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Default is the API; the worker and the nightly job override the command in compose.yaml.
CMD ["node", "src/server.js"]
