import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTailscaleHttps } from "../../../packages/shared/src/tailscale.ts";
import { command } from "./process.ts";

export class TailscaleCertificateError extends Error {
  constructor(cause: Error) {
    super(`Tailscale HTTPS certificate provisioning failed. Retrying automatically. ${cause.message}`, { cause });
    this.name = "TailscaleCertificateError";
  }
}

export class TailscaleHttps {
  private verifiedHost?: string;

  constructor(private run: typeof command = command) {}

  reset(): void {
    this.verifiedHost = undefined;
  }

  async prepare(host: string, certDomains: string[] | null | undefined): Promise<void> {
    try {
      requireTailscaleHttps(host, certDomains);
    } catch (error) {
      this.reset();
      throw error;
    }
    if (host === this.verifiedHost) return;
    this.reset();
    const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-tailscale-cert-"));
    try {
      await this.run([
        "tailscale", "cert", "--cert-file", join(directory, "cert.pem"),
        "--key-file", join(directory, "key.pem"), host,
      ], undefined, 180_000);
      this.verifiedHost = host;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new TailscaleCertificateError(error);
    } finally {
      await rm(directory, { recursive: true });
    }
  }
}
