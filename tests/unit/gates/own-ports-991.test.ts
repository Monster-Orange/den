/**
 * Issue 991: the ports a box run's "host:*" covers are the ones this test
 * process is serving on now, plus those a helper claimed for a child server
 * it saw answer. A port bound and closed (freePort's pick before a child
 * takes it) stops counting when it closes, so a port nobody of ours holds
 * is never left allowed.
 */
import { describe, expect, it } from "@jest/globals";
import * as net from "net";
import { boxOwnPort, ownPorts } from "../helpers/own-ports.js";

const listen = (s: net.Server) =>
  new Promise<number>((r) =>
    s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)),
  );
const close = (s: net.Server) => new Promise((r) => s.close(r));

describe("issue 991: a run's own ports", () => {
  it("counts a port while its server listens, and drops it when it closes", async () => {
    const s = net.createServer();
    const port = await listen(s);
    expect(ownPorts().has(port)).toBe(true);
    await close(s);
    expect(ownPorts().has(port)).toBe(false);
  });

  it("keeps a claimed port (a child server seen answering on it)", async () => {
    const s = net.createServer();
    const port = await listen(s);
    await close(s);
    boxOwnPort(port);
    expect(ownPorts().has(port)).toBe(true);
  });
});
