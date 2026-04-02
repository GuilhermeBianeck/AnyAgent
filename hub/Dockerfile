FROM node:20-alpine AS builder

RUN apk add --no-cache python3 build-base

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

RUN apk add --no-cache python3 build-base
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && chown -R app:app /app
COPY --from=builder --chown=app:app /app/dist ./dist

RUN mkdir -p /app/data && chown app:app /app/data
VOLUME /app/data

USER app
EXPOSE 8080 3000

CMD ["node", "dist/index.js"]
