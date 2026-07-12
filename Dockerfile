ARG NODE_BASE_IMAGE=node:24-bookworm-slim
FROM ${NODE_BASE_IMAGE}

ARG OPENCLAW_VERSION=2026.6.11
ARG PNPM_VERSION=11.11.0

ENV PNPM_HOME=/opt/pnpm
ENV PATH=/opt/pnpm:/usr/local/bin:/usr/bin:/bin

RUN npm install --global "pnpm@${PNPM_VERSION}" "openclaw@${OPENCLAW_VERSION}" \
    && pnpm --version \
    && openclaw --version

WORKDIR /app
COPY --chown=node:node . /app
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @agentnest/tenant-runtime-plugin build

USER node
