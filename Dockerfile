# Open Lounge — production image (Next.js + custom Node server with raw WebSockets)
# Build:  docker build -t openlounge .
# Run:    docker run -p 3000:3000 -v openlounge-data:/data \
#           -e DATABASE_URL=postgresql://user:pass@host:5432/openlounge \
#           -e LIVEKIT_URL=wss://<project>.livekit.cloud -e LIVEKIT_API_KEY=... -e LIVEKIT_API_SECRET=... openlounge
# (server/migrations/*.sql ship inside ./server and run automatically at boot)

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
# static files: /sw.js (notifications service worker) and /icons/* (manifest + notification icons)
COPY --from=build /app/public ./public
COPY --from=build /app/server ./server
COPY --from=build /app/src/lib ./src/lib
COPY --from=build /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docs ./docs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Starts as root only long enough to chown the (root-mounted) volume at $DATA_DIR, then drops to `node`.
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# Same as `npm start` (NODE_ENV=production is set above) without npm in the signal path
CMD ["/app/node_modules/.bin/tsx", "server/index.ts"]
