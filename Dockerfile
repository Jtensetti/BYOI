FROM node:22-slim

# Chromium for the browser (RPA) adapter.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ENV BYOI_CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    NODE_NO_WARNINGS=1

WORKDIR /app
COPY package.json package-lock.json ./
# tsx (a dev dependency) runs the TypeScript directly, so install everything.
RUN npm ci --include=dev && npm cache clean --force
COPY . .

# Run as the unprivileged "node" user; it needs to write integrations/ and .secrets.json.
RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]
