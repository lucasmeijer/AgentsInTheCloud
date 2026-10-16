ARG ATELIER_RUNTIME_IMAGE=ghcr.io/lucasmeijer/agents-in-the-cloud-docker@sha256:149efe3189255442091157921511b6c122b0254bb07e24d08d24408b4b79deda
FROM oven/bun:1.4.0 AS bun-dist

# Built for the platform its workspaces run on; tests run natively.
FROM --platform=$BUILDPLATFORM golang:1.26.0 AS workspace-helper-build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY packages/workspace-helper/helper/go.mod packages/workspace-helper/helper/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY packages/workspace-helper/helper/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /aitc-workspace-helper .

# Just the binary, which `bun run web` exports for development.
FROM scratch AS workspace-helper
COPY --from=workspace-helper-build /aitc-workspace-helper /aitc-workspace-helper

FROM ubuntu:26.04 AS transcription-runtime
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION=0.1.0
COPY packages/dictation/install-runtime.sh /tmp/install-transcription-runtime.sh
RUN sh /tmp/install-transcription-runtime.sh "$TARGETARCH" "$NEMO_SPEECH_VERSION"

FROM ubuntu:26.04 AS deps
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates
WORKDIR /app

COPY . .

# Claude Code runs in workspaces; the Agent SDK's bundled platform binaries are never used here.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile \
    && rm -rf node_modules/.bun/@anthropic-ai+claude-agent-sdk-*

FROM deps AS build
RUN bun run --cwd apps/web build:client

FROM ${ATELIER_RUNTIME_IMAGE} AS runtime
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      git-lfs \
      gosu \
      libcap2-bin \
      openssh-client \
      sudo \
      socat \
      util-linux \
      tmux

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=transcription-runtime /opt/nemo-speech /opt/nemo-speech
RUN ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_NAMESPACE=default
ENV ATELIER_DATA_DIR=/data/app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build --exclude=node_modules /app /app
COPY --from=workspace-helper /aitc-workspace-helper /app/packages/workspace-helper/workspace_tools/aitc-workspace-helper
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec /usr/local/bin/bun /app/packages/proxy-ingress/src/ingress/tailscale-serve-helper.ts "$@"' > /usr/local/bin/agents-in-the-cloud-tailscale-serve-helper \
 && chmod 755 /usr/local/bin/agents-in-the-cloud-tailscale-serve-helper /app/apps/web/docker-entrypoint.sh

ARG ATELIER_COMMIT_ID
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_EAGERLY_PRELOAD="[]"
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      eagerly-preload="${ATELIER_EAGERLY_PRELOAD}"
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.agents-in-the-cloud-default-workspace-image

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
