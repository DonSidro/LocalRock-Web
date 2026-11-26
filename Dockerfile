# syntax=docker/dockerfile:1

# ---- Build: compile the server and bundle the page ----
# The output is plain JavaScript, so it is built once on the build machine's own platform
# and copied into every architecture's image (no slow emulated npm build).
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Run: only production dependencies and the built output ----
FROM node:20-alpine
LABEL org.opencontainers.image.source="https://github.com/DonSidro/LocalRock-Web"       org.opencontainers.image.description="LocalRock Web: control Roborock vacuums through a local_roborock_server"       org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOCALROCK_DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The data folder holds the server session and login code; owned by the unprivileged user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
