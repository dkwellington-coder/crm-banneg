# WhatsApp do suporte (servidor próprio do Banneg). Uma cópia só: as sessões ficam no disco em /data.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
