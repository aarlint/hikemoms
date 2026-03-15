FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules/
COPY package.json server.js db.js ./
COPY public/ ./public/
RUN mkdir -p /app/data/uploads
ENV NODE_ENV=production
ENV DATA_PATH=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
