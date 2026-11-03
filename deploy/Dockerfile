ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node app/package.json ./package.json
COPY --chown=node:node app/src/ ./src/

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/server.js"]
