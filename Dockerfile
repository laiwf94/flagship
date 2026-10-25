# syntax=docker/dockerfile:1
FROM node:22.23.4-alpine AS build
RUN npm install -g pnpm@10.22.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/conformance/package.json packages/conformance/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY packages/sdk-browser/package.json packages/sdk-browser/
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @flagship/core --filter @flagship/server --filter @flagship/admin build \
 && pnpm --filter @flagship/server deploy --prod --legacy /out \
 && cp -r apps/admin/dist /out/admin

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production FLAGSHIP_ADMIN_UI_DIR=/app/admin
USER nonroot:nonroot
EXPOSE 8080
CMD ["dist/main.js"]
