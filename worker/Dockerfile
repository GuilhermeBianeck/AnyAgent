FROM node:22-alpine AS sdk-builder

RUN apk add --no-cache python3 build-base

WORKDIR /sdk
COPY sdk/package*.json ./
RUN npm ci
COPY sdk/tsconfig.json ./
COPY sdk/src/ ./src/
RUN npm run build

FROM node:22-alpine AS worker-builder

RUN apk add --no-cache python3 build-base

WORKDIR /sdk
COPY --from=sdk-builder /sdk ./

WORKDIR /app
COPY worker/package*.json ./
RUN npm ci
COPY worker/tsconfig.json ./
COPY worker/src/ ./src/
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache python3 build-base
RUN addgroup -S app && adduser -S app -G app

WORKDIR /sdk
COPY --from=sdk-builder --chown=app:app /sdk ./

WORKDIR /app
COPY worker/package*.json ./
RUN npm ci --omit=dev && chown -R app:app /app
COPY --from=worker-builder --chown=app:app /app/dist ./dist

USER app

CMD ["node", "dist/index.js"]
