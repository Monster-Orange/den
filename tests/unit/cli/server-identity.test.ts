/**
 * Whose web server answers on a port: classifyServerInfo reads
 * /api/server-info's body against this distribution's root and product.
 */
import { describe, expect, it } from "@jest/globals";
import {
  classifyServerInfo,
  classifyServerInfoResponse,
  foreignServerMessage,
} from "../../../src/ui/cli/server-identity.js";

const OWN = { root: "/srv/acme", product: "acme" };
const noCwd = (): string | null => null;

describe("classifyServerInfo", () => {
  it("our root and product: ours", () => {
    expect(
      classifyServerInfo(
        { pid: 9, version: "0.2.6", root: "/srv/acme", product: "acme" },
        OWN,
        noCwd,
      ),
    ).toEqual({ kind: "ours", version: "0.2.6", pid: 9 });
  });

  it("another root, or our root under another product: foreign, named", () => {
    expect(
      classifyServerInfo(
        { root: "/srv/other", product: "acme-ops" },
        OWN,
        noCwd,
      ),
    ).toEqual({ kind: "foreign", who: "acme-ops at /srv/other" });
    expect(
      classifyServerInfo(
        { root: "/srv/acme", product: "acme-ops" },
        OWN,
        noCwd,
      ),
    ).toEqual({ kind: "foreign", who: "acme-ops at /srv/acme" });
  });

  it("an older server with no root: ours only when it runs from our root", () => {
    const old = { pid: 42, version: "0.2.3" };
    // Its pid travels with the verdict: a stop signals it (web down/restart).
    expect(classifyServerInfo(old, OWN, () => "/srv/acme")).toEqual({
      kind: "ours",
      version: "0.2.3",
      pid: 42,
    });
    expect(classifyServerInfo(old, OWN, () => "/srv/other")).toEqual({
      kind: "foreign",
      who: "another server (Den 0.2.3)",
    });
    expect(classifyServerInfo(old, OWN, noCwd).kind).toBe("foreign");
  });

  it("anything that is not a Den server-info: a non-Den server", () => {
    for (const body of [null, [], "x", { hello: 1 }])
      expect(classifyServerInfo(body, OWN, noCwd)).toEqual({
        kind: "foreign",
        who: "a non-Den server",
      });
    expect(classifyServerInfoResponse(404, "nope", OWN, noCwd)).toEqual({
      kind: "foreign",
      who: "a non-Den server",
    });
    expect(classifyServerInfoResponse(200, "<html>", OWN, noCwd).kind).toBe(
      "foreign",
    );
  });

  it("an empty 200 is a server still starting, not a foreign one", () => {
    expect(classifyServerInfoResponse(200, "", OWN, noCwd)).toEqual({
      kind: "unresponsive",
    });
  });

  it("the message names the port and the owner", () => {
    expect(foreignServerMessage(7001, "acme-ops at /srv/other")).toBe(
      "port 7001 is in use by acme-ops at /srv/other",
    );
  });
});
