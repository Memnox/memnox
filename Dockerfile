FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
COPY packages ./packages
RUN npm ci && npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/packages ./packages
# npm is a build tool, not a runtime one — the entrypoint execs node directly.
# Left in place it is the whole of this image's CVE surface, via its own bundled
# tar, glob and undici, none of which anything here ever calls.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Runs unprivileged; the only writable path is the data volume.
RUN addgroup -S memnox && adduser -S memnox -G memnox && mkdir -p /data \
  && chown -R memnox:memnox /data
USER memnox
COPY --chown=memnox:memnox --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# No `VOLUME /data`: it declares an anonymous volume nobody names, and both
# compose files already mount `memnox-data:/data` themselves, so it bought
# nothing here. Platforms that manage their own volumes reject the instruction
# outright — Railway fails the build on it — and whoever runs this image still
# has to mount /data somewhere, which is the part that was never optional.
EXPOSE 7466
# The entrypoint seeds a policy file on a fresh volume; without it the first
# "docker compose up" crash-loops on a file the volume cannot yet contain.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
