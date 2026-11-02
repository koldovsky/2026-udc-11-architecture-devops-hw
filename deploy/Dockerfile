FROM node:22-alpine

WORKDIR /app

# Explicit COPY instead of "COPY . ." — test/ and docs/ stay out of the image.
COPY package.json ./
COPY src/          ./src/
COPY bin/          ./bin/

ENV NODE_ENV=production
# All runtime secrets (DATABASE_URL, SMS_TOKEN, …) come from the container
# environment at runtime — nothing sensitive is baked into the image.

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "src/server.js"]
