FROM node:20-alpine AS builder

RUN apk add --no-cache python3 build-base

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

RUN apk add --no-cache python3 build-base

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

VOLUME /app/data

EXPOSE 8080 3000

CMD ["node", "dist/index.js"]
