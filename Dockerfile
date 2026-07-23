FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4020
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app public ./public
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app scripts ./scripts
USER app
EXPOSE 4020
CMD ["node", "dist/server.js"]
