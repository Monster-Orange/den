/**
 * 0.4.3: the edge is reachable beyond this machine when its hostname
 * resolves off loopback (a LAN or VPN address) or its container publishes
 * a port on every interface. Read-only: a lookup and `docker inspect`,
 * both injected here.
 */
import { describe, expect, it } from "@jest/globals";
import {
  EDGE_EXPOSED_MESSAGE,
  edgeExposure,
  publishedOnAllInterfaces,
} from "../../../src/ui/server/edge-exposure.js";

const lookupOf = (m: Record<string, string[]>) => async (h: string) =>
  m[h] ?? [];
const none = async () => null;

describe("edgeExposure", () => {
  it("the message is the one line the page and web.log show", () => {
    expect(EDGE_EXPOSED_MESSAGE).toBe(
      "Your edge is reachable from other machines; anyone who can reach it can use terminals. Auth is coming.",
    );
  });

  it("an edge hostname that resolves to a VPN (100.x) or LAN address: exposed", async () => {
    await expect(
      edgeExposure(["den.acme.example"], "acme-edge", {
        lookup: lookupOf({ "den.acme.example": ["100.101.102.103"] }),
        portBindings: none,
      }),
    ).resolves.toBe("den.acme.example resolves to 100.101.102.103");
  });

  it("loopback only, published on 127.0.0.1 or not at all: not exposed", async () => {
    for (const bindings of [
      null,
      {},
      { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "443" }] },
    ])
      await expect(
        edgeExposure(["den.acme.localhost"], "acme-edge", {
          lookup: lookupOf({ "den.acme.localhost": ["127.0.0.1", "::1"] }),
          portBindings: async () => bindings,
        }),
      ).resolves.toBeNull();
  });

  it("the edge container publishing on every interface: exposed", async () => {
    await expect(
      edgeExposure(["den.acme.localhost"], "acme-edge", {
        lookup: lookupOf({ "den.acme.localhost": ["127.0.0.1"] }),
        portBindings: async () => ({
          "443/tcp": [{ HostIp: "", HostPort: "443" }],
        }),
      }),
    ).resolves.toBe("the edge publishes 443 on every interface");
    expect(
      publishedOnAllInterfaces({
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }],
      }),
    ).toMatch(/80 on every interface/);
    expect(publishedOnAllInterfaces({ "80/tcp": null })).toBeNull();
  });

  it("no edge hostnames: nothing to warn about", async () => {
    await expect(
      edgeExposure([], "acme-edge", {
        lookup: lookupOf({}),
        portBindings: async () => ({ "443/tcp": [{ HostIp: "" }] }),
      }),
    ).resolves.toBeNull();
  });
});
