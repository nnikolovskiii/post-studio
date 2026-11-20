# Post Studio (Phase 6): API + editor + pstudio CLI in one image. Motion (Part 2): Debian's ffmpeg
# encodes the MP4 exports (found on PATH; POST_STUDIO_FFMPEG overrides).
# Runs the TypeScript through tsx like the laptop does (no server build step); only the editor is built.
# Build:  docker compose -f deploy/compose.yaml build
# The data dir is a bind mount (/data); nothing in the image holds state or secrets.

FROM node:22-bookworm-slim AS build
# Fallback toolchain for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9.15.0
ENV CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build:editor \
 && test -f apps/editor/dist/index.html

FROM node:22-bookworm-slim
# ffmpeg from the Debian archive (signed packages, no binary from a random URL): libx264 for MP4.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264
ENV NODE_ENV=production \
    POST_STUDIO_DATA=/data \
    POST_STUDIO_HOST=0.0.0.0 \
    POST_STUDIO_PORT=3472
WORKDIR /app
COPY --from=build --chown=root:root /app /app
RUN ln -s /app/apps/cli/bin/pstudio /usr/local/bin/pstudio \
 && mkdir -p /data && chown node:node /data
# uid 1000 = node in this image = the usual first user on a Linux host, so the bind-mounted data dir keeps its owner.
USER node
EXPOSE 3472
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3472/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["pstudio", "serve", "--no-build"]
