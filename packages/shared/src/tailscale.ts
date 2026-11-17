export const tailscaleHttpsSettingsUrl = "https://login.tailscale.com/admin/dns";

export class TailscaleHttpsDisabledError extends Error {
  constructor() {
    super(`Tailscale HTTPS certificates are not enabled. Ask your tailnet admin to enable MagicDNS and HTTPS Certificates at ${tailscaleHttpsSettingsUrl}. Setup resumes automatically.`);
    this.name = "TailscaleHttpsDisabledError";
  }
}

export function requireTailscaleHttps(host: string, certDomains: string[] | null | undefined): void {
  if (!certDomains?.includes(host.replace(/\.$/, ""))) {
    throw new TailscaleHttpsDisabledError();
  }
}
