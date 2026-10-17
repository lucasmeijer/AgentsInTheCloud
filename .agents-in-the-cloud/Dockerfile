FROM agents-in-the-cloud-workspace
# Builds the workspace helper (packages/workspace-helper) and regenerates its gRPC code.
RUN apt-get update \
 && apt-get install -y --no-install-recommends golang-go protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
