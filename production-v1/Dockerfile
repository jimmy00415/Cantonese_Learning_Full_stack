FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ENV NODE_ENV=production \
  PORT=8080
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node data/knowledge/hkbu-v1.json ./data/knowledge/hkbu-v1.json
COPY --chown=node:node scripts/run-migrations.js ./scripts/run-migrations.js
COPY --chown=node:node scripts/image-release-contract.js ./scripts/image-release-contract.js
COPY --chown=node:node scripts/provider-smoke.js ./scripts/provider-smoke.js
COPY --chown=node:node scripts/real-dependencies-acceptance.js ./scripts/real-dependencies-acceptance.js
COPY --chown=node:node scripts/voice-provider-smoke.js ./scripts/voice-provider-smoke.js
COPY --chown=node:node scripts/create-image-release-manifest.js ./scripts/create-image-release-manifest.js

ARG V1_RELEASE_COMMIT_SHA
ARG V1_SOURCE_ARCHIVE_SHA256
RUN node scripts/create-image-release-manifest.js \
  && rm scripts/create-image-release-manifest.js

USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
