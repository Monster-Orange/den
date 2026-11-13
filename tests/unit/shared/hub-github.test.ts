/**
 * The doctor's and Settings' GitHub access line, when the ask fails: a
 * 404 is a Hub that hasn't the route yet ("not available on this Hub
 * yet"), not "refused (404)"; anything else keeps Hub's words, the token
 * scrubbed.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { HubCallError, hubGithubCoverage } from "../../../src/shared/hub.js";
import { coverageError } from "../../../src/shared/hub-github.js";

const TOKEN = "hubi_example_token_0000";

describe("coverageError", () => {
  it("404: not available on this Hub yet", () => {
    const e = new HubCallError(
      "refused",
      "Hub refused it (404)",
      undefined,
      404,
    );
    expect(coverageError(e, TOKEN)).toBe("not available on this Hub yet");
  });

  it("another refusal keeps Hub's words, the token scrubbed", () => {
    const e = new HubCallError(
      "refused",
      `Hub refused it (400: bad ${TOKEN})`,
      undefined,
      400,
    );
    const w = coverageError(e, TOKEN);
    expect(w).toContain("Hub refused it (400");
    expect(w).not.toContain(TOKEN);
  });
});

describe("a Hub without the coverage route", () => {
  const servers: http.Server[] = [];
  afterAll(() => servers.forEach((x) => x.close()));

  it("its 404 reaches coverageError as status 404", async () => {
    const srv = http.createServer((_q, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "localhost", () => r()));
    const url = `http://localhost:${(srv.address() as AddressInfo).port}`;
    const e = await hubGithubCoverage(url, TOKEN).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubCallError);
    expect((e as HubCallError).status).toBe(404);
    expect(coverageError(e, TOKEN)).toBe("not available on this Hub yet");
  });
});
