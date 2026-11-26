import * as net from "net";

/**
 * A Docker bridge address (172.16.0.0/12): where a Linux host's containers
 * reach it as host.docker.internal (`host-gateway`, the edge's
 * extra_hosts). One address, never 0.0.0.0 or ::.
 */
export function isDockerBridgeAddress(addr: string): boolean {
  const a = addr.trim();
  if (!net.isIPv4(a)) return false;
  const [x, y] = a.split(".").map(Number);
  return x === 172 && y >= 16 && y <= 31;
}
