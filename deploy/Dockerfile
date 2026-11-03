FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Залежностей немає (див. package.json), тому npm install не потрібен.
# Секрети (SMS_TOKEN тощо) в образ не вшиваються — лише через оточення під час запуску.
COPY --chown=node:node . .

USER node

EXPOSE 8080

# Перевіряє API; для worker healthcheck вимкнено в compose.yaml.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
