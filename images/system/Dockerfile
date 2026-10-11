ARG RUNTIME_IMAGE=ghcr.io/lucasmeijer/agents-in-the-cloud-docker@sha256:144a54ae19731c822e750b1020bdfc5e2098348b4092e76e42b7f0cc576ca232
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM ghcr.io/tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680 AS tailscale
FROM ${RUNTIME_IMAGE}
# Keep incident-response tools in the System image, not the shared Docker runtime.
# Profiling needs host kernel support/permissions; installing systemd only supplies
# its diagnostic commands (the container still runs the AgentsInTheCloud supervisor).
RUN apt-get update && apt-get install -y --no-install-recommends \
    atop bpfcc-tools bpftrace btop coreutils dnsutils htop iftop \
    iotop-c iproute2 iputils-ping linux-perf lsof mtr-tiny ncdu nethogs \
    nftables procps psmisc smem strace sysstat systemd tcpdump tmux util-linux \
    && rm -rf /var/lib/apt/lists/*
LABEL agents-in-the-cloud.installer-config="1"
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.title="AgentsInTheCloud System"
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY .build/supervisor.js .build/client.js .build/design-system.css /opt/agents-in-the-cloud-system/
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/agents-in-the-cloud-system/supervisor.js"]
CMD []
