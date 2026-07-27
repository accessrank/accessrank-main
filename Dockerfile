# Accessrank — single image serving the marketing site and the audit API.
#
# Based on the official Playwright image because the scanner and the PDF renderer
# both need a real Chromium with its system libraries. Building Chromium's ~90
# runtime dependencies onto a slim base by hand is the usual source of
# "works locally, blank pages in production", so we take the supported image.
#
# The tag must stay in step with the playwright version in package.json.

FROM mcr.microsoft.com/playwright:v1.62.0-noble AS base
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present, otherwise fall back so the image builds
# from a fresh clone too.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# ── build the static site ────────────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi
COPY . .
ARG SITE_URL=https://accessrank.ai
ARG TURNSTILE_SITE_KEY=
ARG PLAUSIBLE_DOMAIN=
# SITE_URL is baked into canonical tags and the sitemap at build time, so it
# must be the real public origin.
RUN SITE_URL=$SITE_URL TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY PLAUSIBLE_DOMAIN=$PLAUSIBLE_DOMAIN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
COPY server/      ./server/
COPY db/          ./db/
COPY scripts/     ./scripts/

# The Playwright image ships Chromium outside the npm package.
ENV CHROMIUM_PATH=/ms-playwright/chromium-*/chrome-linux/chrome
RUN CHROME_BIN="$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -n1)" \
 && printf '%s' "$CHROME_BIN" > /app/.chromium-path \
 && echo "Chromium: $CHROME_BIN"

# The base image provides an unprivileged `pwuser`. Running the browser as root
# is both unnecessary and the reason --no-sandbox is often needed.
RUN chown -R pwuser:pwuser /app
USER pwuser

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Resolve the globbed Chromium path at start, then boot.
CMD ["sh", "-c", "export CHROMIUM_PATH=$(cat /app/.chromium-path) && node server/index.js"]
