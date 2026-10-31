# Build context: app/ (deploy/compose.yaml, build.context ../app). The service has no npm
# dependencies, so one stage is enough.
# The base is pinned by digest: CI (pipeline/deploy.yml, build job) and the VM build the image
# at different times and must start from the same base. node:22-alpine, Node 22.23.4, as of
# 2026-10-31. Base updates come only through a pull request that changes the digest
# (`docker buildx imagetools inspect node:22-alpine` shows the current one).
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ENV NODE_ENV=production

WORKDIR /app

# Only what runs in production. The files stay owned by root: the node user can read them,
# not change them.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# No secrets in the image: SMS_TOKEN comes from compose at run time.
USER node

EXPOSE 8080

# Liveness of the API. The worker has no HTTP server, so compose switches this off for it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
