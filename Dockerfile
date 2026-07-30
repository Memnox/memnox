FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
RUN npm ci && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/packages ./packages
RUN npm ci --omit=dev && npm cache clean --force
VOLUME /data
EXPOSE 7466
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["serve", "--host", "0.0.0.0", "--data-dir", "/data", "--policies", "/data/memnox.policies.yaml"]
