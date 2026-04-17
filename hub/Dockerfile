FROM node:22-alpine AS builder

# No build tools needed — hub is now native-module free (node:sqlite is built in)
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && chown -R app:app /app
COPY --from=builder --chown=app:app /app/dist ./dist

RUN mkdir -p /app/data /app/logs && chown app:app /app/data /app/logs
VOLUME /app/data

USER app
EXPOSE 8080 3000

# Silence "SQLite is an experimental feature" — it's stable API since Node 22.5,
# the warning is a category flag that still fires in 22.x.
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
