# Node version is configurable via --build-arg NODE_VERSION; keep in sync with .nvmrc / root package.json engines
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN apk add --no-cache git
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

FROM deps AS builder
ARG GIT_HASH=0000000000000000000000000000000000000000
ENV GIT_HASH=${GIT_HASH}
ENV NEXT_SKIP_ESLINT=1
# The self-hosted image is the product only — `/` redirects to /projects (see frontend index.tsx).
# Override with --build-arg NEXT_PUBLIC_APP_ONLY=false to build a marketing-style image.
ARG NEXT_PUBLIC_APP_ONLY=true
ENV NEXT_PUBLIC_APP_ONLY=${NEXT_PUBLIC_APP_ONLY}
# Product version, injected by the release workflow (release.yml). Inlined into the static build
# via NEXT_PUBLIC_*, so it must be set before `next build`. Defaults to "dev" for main/edge builds.
ARG VIZDIFF_VERSION=dev
ENV NEXT_PUBLIC_VIZDIFF_VERSION=${VIZDIFF_VERSION}
COPY shared ./shared
COPY frontend ./frontend
RUN yarn workspace frontend build

FROM nginx:1.31-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/frontend/out /usr/share/nginx/html

EXPOSE 80
