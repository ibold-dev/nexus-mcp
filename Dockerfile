# One image, both halves of the stack: the MCP server is the default entry
# point, and the agent is the same image with a different command.
FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Dependency manifests first, so a source change does not reinstall everything.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY bench ./bench

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app
ENV NODE_ENV=production

# The built workspace, including the workspace links pnpm made between packages.
COPY --from=build /app /app

# The MCP server speaks stdio, so this image works as an MCP server as it stands:
#   docker run -i --rm -e NEXUS_ROOT=/repo -v /path/to/repo:/repo nexus-mcp
ENTRYPOINT ["node"]
CMD ["packages/mcp/dist/main.js"]
