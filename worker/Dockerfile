FROM node:20-alpine AS sdk-builder

RUN apk add --no-cache python3 build-base

WORKDIR /sdk
COPY sdk/package*.json ./
RUN npm install
COPY sdk/tsconfig.json ./
COPY sdk/src/ ./src/
RUN npm run build

FROM node:20-alpine AS worker-builder

RUN apk add --no-cache python3 build-base

WORKDIR /sdk
COPY --from=sdk-builder /sdk ./

WORKDIR /app
COPY worker/package*.json ./
RUN npm install
COPY worker/tsconfig.json ./
COPY worker/src/ ./src/
RUN npm run build

FROM node:20-alpine

RUN apk add --no-cache python3 build-base

WORKDIR /sdk
COPY --from=sdk-builder /sdk ./

WORKDIR /app
COPY worker/package*.json ./
RUN npm install --omit=dev
COPY --from=worker-builder /app/dist ./dist

CMD ["node", "dist/index.js"]
