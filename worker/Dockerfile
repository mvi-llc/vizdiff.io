# Node version is configurable via --build-arg NODE_VERSION; keep in sync with .nvmrc / root package.json engines
ARG NODE_VERSION=26

# Base image with Chromium dependencies
FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver \
    chromium-swiftshader \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-cjk \
    font-noto-emoji \
    font-noto-extra && \
    ln -s /usr/bin/chromium-browser /usr/bin/google-chrome

# Point WebDriver tooling at the system Chromium
ENV CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/bin/chromium-browser

# Create a non-root user and set up directories
RUN addgroup -S webuser && adduser -S -G webuser webuser \
    && mkdir -p /home/webuser/Downloads /home/webuser/.cache \
    && chown -R webuser:webuser /home/webuser \
    && chmod 755 /home/webuser

WORKDIR /app

# Install dependencies separately (cached independently)
FROM base AS deps
# corepack is no longer bundled with Node >= 25, so install it explicitly before enabling
RUN npm install -g corepack && corepack enable
COPY .yarn/releases/ ./.yarn/releases/
COPY package.json yarn.lock .yarnrc.yml tsconfig.json tsconfig.options.json ./
# Copy ALL workspace package.jsons (not just this image's) so the workspace set matches
# yarn.lock — `--immutable` fails otherwise. Cheap and cache-friendly.
COPY api/package.json ./api/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/
COPY worker/package.json ./worker/

RUN yarn install --immutable

# Build workspace separately (cached until source changes)
FROM deps AS builder
COPY worker ./worker
COPY shared ./shared
RUN yarn workspace worker build \
  && yarn workspaces focus worker shared --production \
  && chown -R webuser:webuser /app

# Final production image
FROM base
# start.sh launches chromedriver on 4444; point the worker at it regardless of NODE_ENV so
# self-hosted workers render without being forced to NODE_ENV=production (see environment.ts).
ENV NODE_ENV=production \
    CHROMEDRIVER_PORT=4444 \
    HOME=/home/webuser

# Copy built files and dependencies from builder stage
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/worker/package.json /app/worker/package.json
COPY --from=builder /app/shared/package.json /app/shared/package.json
COPY --from=builder /app/worker/dist /app/worker/dist
COPY --from=builder /app/shared /app/shared

# Switch to non-root user
USER webuser
WORKDIR /home/webuser

# Create startup script in the home directory (after all other operations)
RUN printf '#!/bin/sh\nchromedriver --port=4444 --whitelisted-ips="127.0.0.1" &\nsleep 2\nexec node --enable-source-maps /app/worker/dist/worker.mjs\n' > start.sh && chmod +x start.sh

# Product version, injected by the release workflow (release.yml). Last layer so a release rebuild
# only invalidates this step. Defaults to "dev" for main/edge builds.
ARG VIZDIFF_VERSION=dev
ENV VIZDIFF_VERSION=${VIZDIFF_VERSION}

# Run the application
CMD ["./start.sh"]
