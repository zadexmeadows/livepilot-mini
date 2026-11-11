FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder

COPY . .
RUN npm run db:generate && npm run build

FROM node:22-bookworm-slim AS browser-runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99 \
    APP_DATA_DIR=/app/data \
    DATABASE_URL=file:../data/app.db

WORKDIR /app

RUN npx --yes playwright@1.62.1 install --with-deps chrome \
    && apt-get update \
    && apt-get install -y --no-install-recommends fluxbox gosu novnc tini websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin livepilot \
    && mkdir -p /app/data /run/livepilot-vnc \
    && chown -R livepilot:livepilot /app /ms-playwright /run/livepilot-vnc

FROM browser-runtime AS runtime

COPY --chown=livepilot:livepilot --from=builder /app/node_modules ./node_modules
COPY --chown=livepilot:livepilot --from=builder /app/.next ./.next
COPY --chown=livepilot:livepilot --from=builder /app/public ./public
COPY --chown=livepilot:livepilot --from=builder /app/prisma ./prisma
COPY --chown=livepilot:livepilot --from=builder /app/scripts ./scripts
COPY --chown=livepilot:livepilot --from=builder /app/package.json ./package.json
COPY --chown=livepilot:livepilot --chmod=0755 deploy/docker-entrypoint.sh /usr/local/bin/livepilot-entrypoint
COPY --chown=livepilot:livepilot deploy/railway-proxy.mjs ./deploy/railway-proxy.mjs
RUN sed -i 's/\r$//' /usr/local/bin/livepilot-entrypoint

USER root

EXPOSE 3000 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/livepilot-entrypoint"]
