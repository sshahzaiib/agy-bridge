# Used by registry build systems (e.g. Glama) to verify the server starts and
# answers MCP introspection. The agy CLI itself is not bundled — the server
# boots without it; tool calls require agy on the host (AGY_PATH).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
