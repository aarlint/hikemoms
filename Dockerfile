FROM cgr.dev/chainguard/node:latest-dev AS builder

USER root
RUN apk add --no-cache python3 build-base && npm install -g node-gyp
USER node

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM cgr.dev/chainguard/node:latest

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules/
COPY package.json server.js db.js ./
COPY public/ ./public/

RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
ENV DATA_PATH=/app/data
EXPOSE 3000
CMD ["server.js"]
