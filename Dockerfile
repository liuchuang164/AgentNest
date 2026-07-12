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
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
COPY --chown=node:node apps/control-plane/package.json /app/apps/control-plane/package.json
COPY --chown=node:node apps/data-gateway-mock/package.json /app/apps/data-gateway-mock/package.json
COPY --chown=node:node apps/external-gateway-mock/package.json /app/apps/external-gateway-mock/package.json
COPY --chown=node:node packages/capability/package.json /app/packages/capability/package.json
COPY --chown=node:node packages/contracts/package.json /app/packages/contracts/package.json
COPY --chown=node:node packages/openclaw-adapter/package.json /app/packages/openclaw-adapter/package.json
COPY --chown=node:node packages/persistence/package.json /app/packages/persistence/package.json
COPY --chown=node:node packages/tenant-runtime-plugin/package.json /app/packages/tenant-runtime-plugin/package.json
COPY --chown=node:node packages/test-support/package.json /app/packages/test-support/package.json
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . /app
RUN pnpm --filter @agentnest/tenant-runtime-plugin build
RUN chown node:node /app

USER node
