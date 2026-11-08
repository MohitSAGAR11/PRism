# PRism web demo: one image serving the API and the web app.
#
#   docker build -t prism-demo .
#   docker run --rm -p 8787:8787 --env-file .env prism-demo
#
# The GitHub Action does not use this image; it runs from the committed dist/.

# ---- build: compile the web app and bundle the server ----------------------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build:web && npm run build:server

# ---- runtime: no node_modules, no sources, no secrets ----------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app

# The ncc bundle is self-contained, so the runtime needs no npm install.
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node samples ./samples

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
