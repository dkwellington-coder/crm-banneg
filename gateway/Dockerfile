# WhatsApp do suporte (servidor próprio do Banneg). Uma cópia só: as sessões ficam no disco em /data.
FROM node:22-slim
WORKDIR /app
# ffmpeg: the secretary's short videos and the sound/scenes of videos she receives
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
