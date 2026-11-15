/**
 * 0.4.48: Den on the Docker bridge, for the edge, on Linux.
 *
 * The edge container reaches Den as host.docker.internal (`host-gateway`).
 * On macOS Docker Desktop and OrbStack deliver that to loopback, where Den
 * listens. On Linux it is the Docker bridge's gateway (172.17.0.1), where
 * nothing listened: every request through the edge got a 502, unless the
 * person set DEN_BIND_HOST by hand. Now, with an edge set up here, Den also
 * listens on the bridge's gateway address, read again at every start (the
 * bridge can change), and says where (start-up log, doctor).
 *
 * `web.bridge_listen`: auto (the default) or off. DEN_BIND_HOST set: the
 * person chose the bind; nothing more. A request on the bridge is never
 * this machine: the request checks place it by its peer (a bridge address,
 * beyond loopback), and only the edge's proof makes X-Forwarded-For
 * believed (H1).
 *
 * No docker CLI, a daemon that doesn't answer, an address outside
 * 172.16.0.0/12: Den stays on 127.0.0.1 and says why. Never a crash, never
 * a wait: the probe runs after Den listens, within its timeout.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { isDockerBridgeAddress } from "../../ui/server/request-guard.js";

export type BridgeListen = "auto" | "off";

/** Why Den isn't on the bridge, or where it is. */
export type BridgeOutcome =
  | { state: "listening"; address: string; plainHttp: boolean }
  | { state: "skipped"; why: string };

/** What the probe found: the gateway's address, or why there is none. */
export type GatewayProbe = { address: string } | { why: string };

/**
 * Whether to look for the bridge at all, or why not (null: look). A
 * platform other than Linux, or no edge here, says nothing (no line).
 */
export function bridgeWanted(o: {
  platform: NodeJS.Platform;
  setting: BridgeListen;
  bindHost: string | undefined;
  edgeHere: boolean;
}): { why: string; quiet: boolean } | null {
  if (o.platform !== "linux")
    return { why: "not Linux: the edge reaches loopback", quiet: true };
  if (!o.edgeHere) return { why: "no edge set up here", quiet: true };
  if (o.setting === "off")
    return { why: "web.bridge_listen is off", quiet: false };
  if (o.bindHost !== undefined && o.bindHost.trim() !== "")
    return {
      why: `DEN_BIND_HOST is set (${o.bindHost.trim()}): only that address`,
      quiet: false,
    };
  return null;
}

/** Runs a command: its stdout, or an error carrying `code` (ENOENT…). */
export type Run = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

const realRun: Run = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

/**
 * The Docker bridge's gateway address (`docker network inspect bridge`),
 * or why there is none, in words for the log and doctor.
 */
export async function bridgeGateway(
  run: Run = realRun,
  timeoutMs = 10_000,
): Promise<GatewayProbe> {
  let out: string;
  try {
    out = await run(
      "docker",
      [
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
      ],
      timeoutMs,
    );
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; signal?: unknown };
    if (err.code === "ENOENT") return { why: "no docker CLI on PATH" };
    if (err.killed || err.signal)
      return {
        why: `the Docker daemon didn't answer within ${Math.round(timeoutMs / 1000)} s`,
      };
    return { why: "the Docker daemon isn't answering" };
  }
  const addrs = out.split(/\s+/).filter(Boolean);
  const address = addrs.find((a) => isDockerBridgeAddress(a));
  if (address) return { address };
  return addrs.length
    ? {
        why: `the bridge's gateway (${addrs[0]}) isn't a Docker bridge address (172.16.0.0/12)`,
      }
    : { why: "the Docker bridge has no gateway address" };
}

/** The line the start-up log and doctor say. */
export function bridgeLine(o: BridgeOutcome, title: string): string {
  if (o.state === "listening")
    return (
      `Listening on the Docker bridge (${o.address}) for the edge` +
      (o.plainHttp ? "; plain HTTP because tls: none" : "")
    );
  return `Not on the Docker bridge: ${o.why}. The edge reaches ${title} only if it can reach 127.0.0.1.`;
}

/** Where the running Den records what it did (doctor reads it). */
export const bridgeStateFile = (stateDir: string) =>
  path.join(stateDir, "web-bridge.json");

export function writeBridgeState(
  stateDir: string,
  o: BridgeOutcome,
  now = new Date(),
): void {
  const file = bridgeStateFile(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...o, at: now.toISOString() }));
  fs.renameSync(tmp, file);
}

export function readBridgeState(
  stateDir: string,
): (BridgeOutcome & { at?: string }) | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(bridgeStateFile(stateDir), "utf-8"),
    ) as Record<string, unknown>;
    if (v.state === "listening" && typeof v.address === "string")
      return {
        state: "listening",
        address: v.address,
        plainHttp: v.plainHttp === true,
        ...(typeof v.at === "string" ? { at: v.at } : {}),
      };
    if (v.state === "skipped" && typeof v.why === "string")
      return {
        state: "skipped",
        why: v.why,
        ...(typeof v.at === "string" ? { at: v.at } : {}),
      };
    return null;
  } catch {
    return null;
  }
}
