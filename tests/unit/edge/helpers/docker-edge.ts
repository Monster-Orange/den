/** Shared by the edge tests that run a real Traefik in a throwaway container. */
import { execFileSync } from "child_process";
import * as net from "net";
import type { AddressInfo } from "net";

/** Docker answers, and DEN_SKIP_DOCKER_TESTS isn't set. */
export function dockerOk(): boolean {
  if (process.env.DEN_SKIP_DOCKER_TESTS === "1") return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** A port free on 127.0.0.1 just now. */
export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
