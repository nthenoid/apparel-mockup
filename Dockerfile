# Rebuilt weekly by GitHub Actions so the base system, Node and Ghostscript
# pick up security patches automatically.
FROM node:26-alpine

RUN apk upgrade --no-cache && apk add --no-cache ghostscript tini

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
