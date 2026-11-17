import { shellQuote } from "@agents-in-the-cloud/core";

export type TurnBoundary = "started" | "finished" | "failed";

export function turnSignalArgv(command: string, boundary: TurnBoundary): string[] {
  return ["sh", command, boundary];
}

export function turnSignalShell(command: string, boundary: TurnBoundary): string {
  return `sh ${shellQuote(command)} ${boundary}`;
}
