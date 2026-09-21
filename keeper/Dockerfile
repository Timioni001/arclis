# The keeper, as a long-running container.
#
# Not a cron job, deliberately. An open market gives a published price sixty
# seconds before the program refuses to trade against it, and the keeper
# publishes every ten. The smallest interval a scheduler like GitHub Actions
# will honour is five minutes, and it is routinely late by more, so a
# scheduled keeper would be stale more often than fresh. This has to be a
# process that stays up.
#
# Node 22 to match `app/.nvmrc` and the version the suites run on.
FROM node:22-slim

# dumb-init, because node as PID 1 does not forward signals to itself the way
# an init does, and the keeper's SIGTERM handler is what drains it cleanly on
# a deploy or a restart. Without this, every deploy is a hard kill mid-flight.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Dependencies first, as their own layer: they change far less often than the
# keeper does, so a code change rebuilds in seconds rather than minutes.
COPY package.json package-lock.json ./
# Dev dependencies included on purpose. The keeper runs from TypeScript
# through `tsx`, which lives there; compiling to JS first would mean a second
# tsconfig and a build artifact that can silently drift from the source the
# tests run against. The image is bigger and the thing that runs is the thing
# that was tested.
RUN npm ci --ignore-scripts

# Only what the keeper reads. `app/`, `programs/` and `target/` are not needed
# at runtime and `.dockerignore` keeps them out of the build context entirely.
COPY tsconfig.json ./
COPY idl ./idl
COPY keeper ./keeper

ENV NODE_ENV=production
# Answered by keeper/src/health.ts. Off unless set, so a local `npm run keeper`
# does not open a socket.
ENV HEALTH_PORT=8080
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "keeper/src/run.ts"]
