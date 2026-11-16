FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-fund --no-audit
COPY tsconfig.base.json prisma.config.ts ./
COPY apps ./apps
COPY scripts ./scripts
RUN DATABASE_URL=postgresql://unused:unused@localhost/unused npx prisma generate --schema apps/api/prisma/schema.prisma
ENV NODE_ENV=production
RUN npm run build

# Migration/seed tooling is explicit and never inherited by the application runtime.
FROM build AS migrate
ENV NODE_ENV=development
USER node
CMD ["node", "scripts/database.mjs", "migrate", "deploy"]

FROM build AS runtime-deps
RUN npm prune --omit=dev --omit=optional --no-fund --no-audit

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=development
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist/src ./apps/api/dist/src
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/src/main.js"]

FROM nginx:1.28-alpine AS web
COPY scripts/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
