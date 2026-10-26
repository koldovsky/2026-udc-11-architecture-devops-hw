FROM node:22-alpine

RUN addgroup -S poshtomat && adduser -S poshtomat -G poshtomat

WORKDIR /app

# Copy source — no npm dependencies, nothing to install
COPY --chown=poshtomat:poshtomat package.json ./
COPY --chown=poshtomat:poshtomat src/  ./src/
COPY --chown=poshtomat:poshtomat bin/  ./bin/

USER poshtomat
ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
