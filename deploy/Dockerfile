FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# No dependencies: copy only the runtime files, never credentials or tests.
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node bin/ ./bin/

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(4000)}); if (!r.ok) process.exit(1)"]
CMD ["node", "src/server.js"]
