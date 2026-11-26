/**
 * Issue 869: after an address change Den tells the connected Hub
 * (PUT /api/installs/self/den-url). Each answer: 200 changed true or
 * false; 400, 401, 403 recorded and shown on Settings › Hub; 404 an older
 * Hub, skipped quietly with an activity row. It never throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  denUrlTellProblem,
  readDenUrlTell,
  tellHubDenUrl,
} from "../../../src/shared/hub/hub-den-url.js";
import { HubCallError, hubPutDenUrl } from "../../../src/shared/hub.js";
import { setConfigAuditSink } from "../../../src/shared/config-audit.js";
import { readAuditRows } from "../../../src/shared/audit-queue.js";

let dir = "";
beforeEach(() => {
  setConfigAuditSink(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-869-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ADDR = "https://den.example.test";
// Issue 1369: the file and the CLI's queue.
const audit = () => readAuditRows(dir);

/** A Hub answering `status` with `body`, through the real hubPutDenUrl. */
function hubAnswering(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    seen,
    deps: {
      hub: async () => ({ url: "https://hub.example.test", token: "tok" }),
      put: (h: string, t: string, u: string) =>
        hubPutDenUrl(h, t, u, { fetch: fetchFn }),
      stateDir: dir,
    },
  };
}

describe("telling Hub the address", () => {
  it("PUTs the address with the install token", async () => {
    const h = hubAnswering(200, { changed: true });
    await tellHubDenUrl(ADDR, h.deps);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].url).toBe(
      "https://hub.example.test/api/installs/self/den-url",
    );
    expect(h.seen[0].init.method).toBe("PUT");
    expect(
      (h.seen[0].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok");
    expect(JSON.parse(String(h.seen[0].init.body))).toEqual({ url: ADDR });
  });

  it("200 changed true: recorded, nothing for the card", async () => {
    const r = await tellHubDenUrl(
      ADDR,
      hubAnswering(200, { changed: true }).deps,
    );
    expect(r.outcome).toBe("changed");
    expect(audit()).toEqual([expect.objectContaining({ verb: "hub-den-url" })]);
    expect(audit()[0].outcome).toBeUndefined();
    expect(denUrlTellProblem(readDenUrlTell(dir))).toBeNull();
  });

  it("200 changed false: Hub had it", async () => {
    const r = await tellHubDenUrl(
      ADDR,
      hubAnswering(200, { changed: false }).deps,
    );
    expect(r.outcome).toBe("unchanged");
    expect(denUrlTellProblem(readDenUrlTell(dir))).toBeNull();
  });

  for (const status of [400, 401, 403])
    it(`${status}: recorded as refused, and shown on the Hub card`, async () => {
      const r = await tellHubDenUrl(
        ADDR,
        hubAnswering(status, { error: "bad_url", message: "not allowed" }).deps,
      );
      expect(r).toMatchObject({ outcome: "refused", status });
      const row = audit()[0];
      expect(row).toMatchObject({ verb: "hub-den-url", outcome: "refused" });
      expect(String(row.reason)).toContain(String(status));
      expect(denUrlTellProblem(readDenUrlTell(dir))).toMatchObject({
        status,
        url: ADDR,
      });
    });

  it("404: an older Hub, skipped quietly with an activity row", async () => {
    const r = await tellHubDenUrl(ADDR, hubAnswering(404, {}).deps);
    expect(r.outcome).toBe("old_hub");
    const row = audit()[0];
    expect(row).toMatchObject({ verb: "hub-den-url" });
    expect(row.outcome).toBeUndefined();
    expect(denUrlTellProblem(readDenUrlTell(dir))).toBeNull();
  });

  it("no Hub connected: nothing asked, nothing recorded", async () => {
    let asked = false;
    const r = await tellHubDenUrl(ADDR, {
      hub: async () => null,
      put: async () => {
        asked = true;
        return {};
      },
      stateDir: dir,
    });
    expect(r.outcome).toBe("not_connected");
    expect(asked).toBe(false);
    expect(audit()).toEqual([]);
  });

  it("Hub not answering never throws", async () => {
    const r = await tellHubDenUrl(ADDR, {
      hub: async () => ({ url: "https://hub.example.test", token: "t" }),
      put: async () => {
        throw new HubCallError("unreachable", "Hub did not answer in 10 ms");
      },
      stateDir: dir,
    });
    expect(r.outcome).toBe("unreachable");
    expect(audit()[0]).toMatchObject({ outcome: "refused" });
  });

  it("a later tell that goes through clears the card's note", async () => {
    await tellHubDenUrl(ADDR, hubAnswering(403, {}).deps);
    expect(denUrlTellProblem(readDenUrlTell(dir))).not.toBeNull();
    await tellHubDenUrl(ADDR, hubAnswering(200, { changed: true }).deps);
    expect(denUrlTellProblem(readDenUrlTell(dir))).toBeNull();
  });
});

describe("Settings › Hub shows a refused address", () => {
  const connected = {
    configured: true,
    connected: true,
    state: "connected",
    url: "https://hub.example.test",
  };
  it("refused: Hub's words and the address, on the card", async () => {
    const { hubHtml } =
      await import("../../../src/ui/server/public/settings-registry.js");
    const html = hubHtml({
      ...connected,
      denUrl: { url: ADDR, outcome: "refused", status: 403, error: "nope" },
    });
    expect(html).toContain('data-hub-den-url="refused"');
    expect(html).toContain(ADDR);
    expect(html).toContain("nope");
  });

  it("nothing refused: no note", async () => {
    const { hubHtml } =
      await import("../../../src/ui/server/public/settings-registry.js");
    expect(hubHtml(connected)).not.toContain("data-hub-den-url");
  });
});
