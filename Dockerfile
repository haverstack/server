# deps: install production dependencies only
FROM node:22-slim AS deps
RUN npm install -g pnpm@10
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# builder: compile TypeScript
FROM node:22-slim AS builder
RUN npm install -g pnpm@10
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

# runner: minimal production image
FROM node:22-slim AS runner
RUN groupadd -r app && useradd -r -g app app
WORKDIR /app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./
RUN mkdir -p /app/data && chown app:app /app/data
VOLUME ["/app/data"]
ENV NODE_ENV=production
ENV DB_PATH=/app/data/stack.db
EXPOSE 3000
USER app
CMD ["node", "dist/index.js"]
