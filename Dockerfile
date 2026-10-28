# Knot API — production image. Build from the repository root:
#   docker build -f server/Dockerfile -t knot-api .
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --include-workspace-root=false --no-audit --no-fund
COPY server server
RUN cd server && npx prisma generate && npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --workspace server --include-workspace-root=false --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN apk add --no-cache openssl tini && addgroup -S knot && adduser -S knot -G knot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY server/package.json ./server/package.json
RUN mkdir -p /data/uploads && chown -R knot:knot /data
USER knot
WORKDIR /app/server
ENV PORT=4000 UPLOAD_DIR=/data/uploads
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
