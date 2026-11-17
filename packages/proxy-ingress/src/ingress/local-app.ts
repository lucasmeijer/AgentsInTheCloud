import { isWorkspaceLoopbackHost, localhostSubdomain, type WorkspaceHttpAppBackend } from "@agents-in-the-cloud/shared";

export function isSameLocalApp(backend: WorkspaceHttpAppBackend, candidate: URL): boolean {
  const { target } = backend;
  return isWorkspaceLoopbackHost(target.hostname) && isWorkspaceLoopbackHost(candidate.hostname)
    && localhostSubdomain(candidate.hostname) === backend.appHost
    && target.protocol === candidate.protocol && target.port === candidate.port
    && !candidate.username && !candidate.password;
}

export function localAppHost(backend: WorkspaceHttpAppBackend): string {
  const { target } = backend;
  return `${backend.appHost ?? "localhost"}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
}

export function translateLocalAppOrigin(backend: WorkspaceHttpAppBackend, headers: Headers, receivingOrigin: string): void {
  if (headers.get("origin") !== receivingOrigin) return;
  const upstream = new URL(`${backend.target.protocol}//${localAppHost(backend)}`).origin;
  headers.set("origin", upstream);
}

export function adaptLocalAppResponse(backend: WorkspaceHttpAppBackend, response: Response, publicOrigin: string): Response {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) {
    const base = new URL(backend.target);
    base.host = localAppHost(backend);
    const destination = URL.parse(location, base);
    if (destination && isSameLocalApp(backend, destination)) {
      headers.set("location", `${publicOrigin}${destination.pathname}${destination.search}${destination.hash}`);
    }
  }
  const cookies = headers.getSetCookie();
  if (cookies.length) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie.split(";").filter((attribute, index) => {
        if (index === 0) return true;
        const match = attribute.match(/^\s*domain\s*=\s*\.?([^\s;]+)\s*$/i);
        return !match || !isWorkspaceLoopbackHost(match[1]!);
      }).join(";"));
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
