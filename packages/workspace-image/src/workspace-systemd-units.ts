/** Installed in the workspace image; provisioning and standalone tests share these. */
export function workspaceRuntimeUnits() {
  return {
    "agents-in-the-cloud-tmux.service": `[Unit]
Description=AgentsInTheCloud workspace terminal workloads
[Service]
Type=exec
User=agents-in-the-cloud
EnvironmentFile=/.agents-in-the-cloud/environment
WorkingDirectory=/work
# -D keeps the server in the foreground and disables exit-empty. Use the
# default socket so ordinary tmux commands share this managed server.
ExecStart=/usr/bin/tmux -D
# Do not release initialization until the server accepts commands. -N forbids
# a readiness probe from accidentally starting another server.
ExecStartPost=/bin/sh -ec 'until /usr/bin/tmux -N show-options -g >/dev/null 2>&1; do sleep 0.05; done'
TimeoutStartSec=10s
CPUWeight=10
Nice=10
OOMScoreAdjust=500
# An individual workload OOM must not cause systemd to kill every terminal.
OOMPolicy=continue
Restart=always
RestartSec=1s
TimeoutStopSec=10s
`,
    "agents-in-the-cloud-init.service": `[Unit]
Description=AgentsInTheCloud workspace initialization
[Service]
Type=oneshot
EnvironmentFile=/.agents-in-the-cloud/environment
WorkingDirectory=/work
ExecStart=/bin/sh /.agents-in-the-cloud/init.sh
RemainAfterExit=yes
TimeoutStartSec=infinity
`,
    "agents-in-the-cloud-gateway.service": `[Unit]
Description=AgentsInTheCloud workspace gateway
Requires=agents-in-the-cloud-init.service
After=agents-in-the-cloud-init.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
EnvironmentFile=/.agents-in-the-cloud/environment
WorkingDirectory=/work
ExecStart=/usr/local/bin/agents-in-the-cloud-workspace-gateway
ExecStopPost=/usr/bin/rm -f /.agents-in-the-cloud/ready
Restart=on-failure
RestartSec=2s
KillMode=mixed
TimeoutStopSec=30s
[Install]
WantedBy=multi-user.target
`,
    "agents-in-the-cloud-helper.service": `[Unit]
Description=AgentsInTheCloud workspace helper
[Service]
# The helper passes this environment on to the processes it runs.
EnvironmentFile=/.agents-in-the-cloud/environment
WorkingDirectory=/work
# Comes from the tools mount, so it matches the app rather than the image.
ExecStart=/opt/agents-in-the-cloud/bin/aitc-workspace-helper
Restart=always
RestartSec=1s
# Processes the app started, such as servers, outlive a helper restart.
KillMode=process
[Install]
WantedBy=multi-user.target
`,
    "docker.socket": `[Unit]
Description=AgentsInTheCloud Docker API socket
[Socket]
ListenStream=/run/docker.sock
SocketMode=0660
SocketUser=root
SocketGroup=docker
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
`,
    "docker.service": `[Unit]
Description=AgentsInTheCloud workspace Docker daemon
Requires=docker.socket containerd.service
After=docker.socket containerd.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
Type=notify
# System services do not inherit the workspace shell's proxy environment.
EnvironmentFile=/.agents-in-the-cloud/environment
ExecStart=/usr/local/bin/dockerd --live-restore
Restart=on-failure
RestartSec=2s
TimeoutStartSec=90s
TimeoutStopSec=120s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
    "containerd.service": `[Unit]
Description=AgentsInTheCloud workspace containerd
[Service]
Type=notify
ExecStart=/usr/local/bin/containerd --config /etc/containerd/config.toml
Restart=on-failure
RestartSec=2s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
  };
}
