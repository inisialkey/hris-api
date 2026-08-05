# One image, three entrypoints (`APP_ROLE` = api | worker | both) — ADR-0001
# decision 7. The api and the worker are the same bytes, which is what makes
# ADR-0019's "promote the digest" meaningful: there is one digest to promote.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The migrate Job runs from this same image (ci-cd §7.1), so the SQL ships with
# the code that expects it. A migration directory that could drift from the
# binary is a rollback that half-works.
COPY src/database/migrations ./src/database/migrations

# Non-root. The `node` user exists in the base image; creating one here would
# only invent a second uid to keep track of.
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]
