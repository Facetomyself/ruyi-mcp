# syntax=docker/dockerfile:1
ARG NODE_BASE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
FROM ${NODE_BASE} AS python
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

FROM python AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt requirements-container.txt ./
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --only-binary=:all: -r requirements-container.txt \
    && pip check
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY bridge/ bridge/
COPY contracts/ contracts/
COPY scripts/ scripts/
RUN npm run check && npm prune --omit=dev --ignore-scripts

FROM python AS core
WORKDIR /app
ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    RUYI_MCP_PYTHON=/opt/venv/bin/python \
    RUYI_MCP_PROFILE_ROOT=/tmp/ruyi-profiles
COPY --from=build /opt/venv /opt/venv
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/build/ build/
COPY --from=build /app/bridge/ bridge/
COPY --from=build /app/contracts/ contracts/
RUN groupadd --gid 10001 ruyi && useradd --uid 10001 --gid 10001 --no-create-home ruyi
USER 10001:10001
ENTRYPOINT ["node", "/app/build/src/index.js"]

# Browser binaries are supplied at runtime as a read-only mount. No download
# or browser fallback occurs at container startup.
FROM core AS browser
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation libasound2t64 libdbus-glib-1-2 libfontconfig1 libgbm1 libglib2.0-0t64 \
    libgtk-3-0t64 libnss3 libpci3 libpulse0 libx11-6 libx11-xcb1 libxcb-shm0 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxtst6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/firefox
ENV RUYI_FIREFOX_PATH=/opt/firefox/firefox
USER 10001:10001

# Stock Firefox is a reference for CI only, not the released Trace kernel.
FROM browser AS browser-test
USER root
RUN apt-get update && apt-get install -y --no-install-recommends firefox-esr \
    && rm -rf /var/lib/apt/lists/*
ENV RUYI_FIREFOX_PATH=/usr/bin/firefox-esr
USER 10001:10001

FROM core AS default
