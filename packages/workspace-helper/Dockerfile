# Builds the helper for the platform its workspaces run on; tests run natively.
FROM --platform=$BUILDPLATFORM golang:1.26.0 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY helper/go.mod helper/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY helper/ ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./... && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /aitc-workspace-helper .

FROM scratch
COPY --from=build /aitc-workspace-helper /aitc-workspace-helper
