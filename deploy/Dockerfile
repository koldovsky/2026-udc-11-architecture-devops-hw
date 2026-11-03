FROM node:22.14.0-alpine3.21

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY src ./src
COPY bin ./bin
RUN addgroup -S app && adduser -S -G app app \
    && chown -R app:app /app

USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["node"]
CMD ["src/server.js"]
