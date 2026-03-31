# Stage 1: Build frontend
FROM node:22-slim AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:22-slim AS backend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Stage 3: Runtime
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep openssh-client curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend /app/dist/ dist/
COPY --from=frontend /app/web/dist/ web/dist/
COPY src/migrations/ dist/migrations/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
