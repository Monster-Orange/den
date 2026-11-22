/**
 * Issue 666: a `.localhost` web.url locked a person out of an install they
 * opened on its edge alias (a split-DNS name). Each clause:
 *
 * 1. No path writes a loopback address (localhost, *.localhost, 127.x,
 *    ::1) as web.url: the migration takes the edge alias instead, and
 *    replaces a loopback one with it; setWebUrl refuses one; create's
 *    --url refuses one.
 * 2. Doctor fails a loopback web.url and offers the alias as the fix.
 * 3. A browser on a known alias, while web.url is wrong or loopback, gets
 *    "Make <alias> this Den's address", which only the owner confirms; a
 *    loopback address is never "proven", so sign-in stays where the
 *    person is.
 * 4. Every change to web.url is an activity row: who, old → new, path.
 *
 * Invented names only (acme.localhost, acme.internal).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cmdWebClaimLink } from "../../../src/ui/cli/web-command.js";
import {
  migrateWebUrl,
  readWebUrl,
  setWebUrl,
  type WebUrl,
} from "../../../src/shared/web-url.js";
import {
  setConfigAuditSink,
  type ConfigAuditRow,
} from "../../../src/shared/config-audit.js";
import type { UserConfig } from "../../../src/shared/den-config.js";
import { httpsAddress } from "../../../src/ui/server/named-address.js";
import { addressLines } from "../../../src/ui/cli/doctor-command.js";
import { parseCreateArgs } from "../../../src/ui/cli/create.js";
import { denRouteTarget } from "../../../src/ui/cli/edge-command.js";
import {
  adoptAllowed,
  handleWebUrlRoutes,
  type WebUrlRouteDeps,
} from "../../../src/ui/server/web-url-routes.js";

const LOOP = "https://acme.localhost";
const ALIAS = "https://acme.internal";

const store = (init: UserConfig = {}) => {
  let user: UserConfig = init;
  return {
    read: () => user,
    merge: (p: Partial<UserConfig>) => (user = { ...user, ...p }),
    get: () => user,
  };
};

let rows: ConfigAuditRow[] = [];
beforeAll(() => setConfigAuditSink((r) => void rows.push(r)));
afterEach(() => {
  rows = [];
});
afterAll(() => setConfigAuditSink(null));

describe("issue 666: the writer", () => {
  it("is gone: the migration no longer takes a loopback edge route, and setting one is refused", () => {
    // Before: the migration took https://acme.localhost (unconfirmed), and
    // doctor's own fix (`web url <it>`, setWebUrl) confirmed it.
    const s = store();
    const w = migrateWebUrl(
      () => ({ url: LOOP, from: "the edge route to this install" }),
      s.merge,
      s.read,
    );
    expect(w).toBeNull();
    expect(() => setWebUrl(LOOP, s.merge, s.read)).toThrow(/this machine only/);
    expect(readWebUrl(s.read)).toBeNull();
  });
});

describe("issue 666 clause 1: no path writes a loopback address", () => {
  it("the migration takes the alias over a loopback route", () => {
    const s = store();
    const w = migrateWebUrl(
      () => [
        { url: LOOP, from: "the edge route to this install" },
        { url: ALIAS, from: "the edge route to this install" },
      ],
      s.merge,
      s.read,
    );
    expect(w).toEqual({
      url: ALIAS,
      confirmed: false,
      from: "the edge route to this install",
    });
  });

  it("a loopback web.url already there is replaced by the alias, unconfirmed", () => {
    const s = store({ web: { url: LOOP } } as UserConfig);
    const w = migrateWebUrl(
      () => [{ url: ALIAS, from: "the edge route to this install" }],
      s.merge,
      s.read,
    );
    expect(w?.url).toBe(ALIAS);
    expect(w?.confirmed).toBe(false);
    expect(w?.from).toMatch(/acme\.localhost/);
  });

  it("a loopback web.url with no alias to take stays (doctor fails it)", () => {
    const s = store({ web: { url: LOOP } } as UserConfig);
    expect(migrateWebUrl(() => [], s.merge, s.read)?.url).toBe(LOOP);
  });

  it("every loopback form is refused by setWebUrl", () => {
    for (const bad of [
      "http://localhost:7000",
      "https://acme.localhost",
      "http://127.0.0.1:7000",
      "http://[::1]:7000",
    ]) {
      const s = store();
      expect(() => setWebUrl(bad, s.merge, s.read)).toThrow(
        /this machine only/,
      );
    }
  });

  it("create --url refuses a loopback address", () => {
    expect(() =>
      parseCreateArgs(["acme", "--url", "https://acme.localhost"], "/tmp"),
    ).toThrow(/this machine only/);
    expect(parseCreateArgs(["acme", "--url", ALIAS], "/tmp").url).toBe(ALIAS);
  });

  it("edge route never builds on a loopback web.url", () => {
    expect(
      denRouteTarget({ url: LOOP, confirmed: true }, "acme.internal", 80),
    ).toEqual({ host: "acme.internal", listen: 80, loopback: true });
  });
});

describe("issue 666 clause 2: doctor fails a loopback web.url", () => {
  it("fails, with the alias as the fix", () => {
    const r = addressLines(
      { url: LOOP, confirmed: true },
      "Den",
      "den",
      null,
      ALIAS,
    );
    expect(r.problem).toBe(true);
    expect(r.check.status).toBe("fail");
    expect(r.check.fix).toBe(`den web url ${ALIAS}`);
    expect(r.check.detail).toMatch(/this machine only/);
    expect(r.lines.join("\n")).toMatch(/address {2}✗/);
  });

  it("fails with no alias known, asking for the address", () => {
    const r = addressLines({ url: LOOP, confirmed: false }, "Den", "den");
    expect(r.check.status).toBe("fail");
    expect(r.check.ask).toBeTruthy();
  });
});

describe("issue 666 clause 3: never locked out on a known alias", () => {
  it("a loopback web.url is never Den's named https address", () => {
    expect(httpsAddress(LOOP)).toBeNull();
    expect(httpsAddress(ALIAS)?.origin).toBe(ALIAS);
  });

  describe("who may make the alias the address (the trust boundary)", () => {
    const base = {
      agent: false,
      personToken: false,
      beyond: true,
      session: null as { via?: string; login?: string } | null,
      ownerLogin: "acme-owner" as string | null,
    };
    it("the owner's own terminal (person token)", () => {
      expect(adoptAllowed({ ...base, personToken: true }).ok).toBe(true);
    });
    it("a signed-in browser on this machine", () => {
      expect(
        adoptAllowed({ ...base, beyond: false, session: { via: "link" } }).ok,
      ).toBe(true);
    });
    it("the owner's GitHub sign-in, from anywhere", () => {
      expect(
        adoptAllowed({
          ...base,
          session: { via: "github", login: "Acme-Owner" },
        }).ok,
      ).toBe(true);
    });
    it("a device code or link the owner approved in their terminal", () => {
      expect(adoptAllowed({ ...base, session: { via: "code" } }).ok).toBe(true);
      expect(adoptAllowed({ ...base, session: { via: "link" } }).ok).toBe(true);
    });
    it("never: no sign-in, another GitHub account, an org claim, an agent", () => {
      expect(adoptAllowed(base).ok).toBe(false);
      expect(adoptAllowed({ ...base, beyond: false }).ok).toBe(false);
      expect(
        adoptAllowed({ ...base, session: { via: "github", login: "someone" } })
          .ok,
      ).toBe(false);
      expect(
        adoptAllowed({
          ...base,
          ownerLogin: null,
          session: { via: "github", login: "someone" },
        }).ok,
      ).toBe(false);
      expect(
        adoptAllowed({ ...base, session: { via: "claim", login: "x" } }).ok,
      ).toBe(false);
      expect(adoptAllowed({ ...base, agent: true, personToken: true }).ok).toBe(
        false,
      );
    });
  });

  describe("the routes", () => {
    let saved: WebUrl | null = { url: LOOP, confirmed: true };
    let sets: { url: string; how?: { path: string; who: string } }[] = [];
    let server: http.Server;
    let base = "";
    let owner = true;
    const deps: WebUrlRouteDeps = {
      isAgent: (r) => r.headers["x-den-actor"] === "agent",
      read: () => saved,
      set: (url, how) => {
        sets.push({ url, how });
        saved = { url, confirmed: true };
        return url;
      },
      ping: async (url) => {
        const u = new URL(url);
        if (u.origin !== ALIAS) return { error: "timeout" };
        const r = await fetch(`${base}${u.pathname}${u.search}`);
        return { status: r.status };
      },
      checkMs: () => 2000,
      readBody: (req) =>
        new Promise((ok) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => ok(b));
        }),
      sendJson: (res, body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      aliases: () => [ALIAS],
      here: (r) => (r.headers["x-test-alias"] ? ALIAS : null),
      works: () => true,
      owner: () =>
        owner
          ? { ok: true, who: "person:owner (a browser on this machine)" }
          : { ok: false, why: "only this Den's owner" },
    };
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", "http://den.invalid").pathname;
        if (!handleWebUrlRoutes(req, res, p, deps)) {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });
    afterEach(() => {
      saved = { url: LOOP, confirmed: true };
      sets = [];
      owner = true;
    });

    it("GET on the alias with a loopback web.url offers the alias", async () => {
      const r = await fetch(`${base}/api/web-url`, {
        headers: { "x-test-alias": "1" },
      });
      const b = (await r.json()) as Record<string, unknown>;
      expect(b).toMatchObject({ url: LOOP, loopback: true, offer: ALIAS });
    });

    it("GET on this machine with a loopback web.url offers the alias too", async () => {
      const b = (await (await fetch(`${base}/api/web-url`)).json()) as Record<
        string,
        unknown
      >;
      expect(b.offer).toBe(ALIAS);
    });

    it("GET with a working, confirmed address offers nothing", async () => {
      saved = { url: "https://acme.example.com", confirmed: true };
      const b = (await (
        await fetch(`${base}/api/web-url`, { headers: { "x-test-alias": "1" } })
      ).json()) as Record<string, unknown>;
      expect(b.offer).toBeUndefined();
    });

    const adopt = (url: string, agent = false) =>
      fetch(`${base}/api/web-url/adopt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(agent ? { "x-den-actor": "agent" } : {}),
        },
        body: JSON.stringify({ url }),
      });

    it("the owner makes the alias the address, with who and the path", async () => {
      const r = await adopt(ALIAS);
      expect(r.status).toBe(200);
      expect(sets).toEqual([
        {
          url: ALIAS,
          how: {
            path: "make-alias-the-address",
            who: "person:owner (a browser on this machine)",
          },
        },
      ]);
    });

    it("anyone else is refused, and nothing changes", async () => {
      owner = false;
      const r = await adopt(ALIAS);
      expect(r.status).toBe(403);
      expect(sets).toEqual([]);
    });

    it("an agent is refused", async () => {
      expect((await adopt(ALIAS, true)).status).toBe(403);
      expect(sets).toEqual([]);
    });

    it("only a known alias of this install", async () => {
      expect((await adopt("https://elsewhere.example.com")).status).toBe(400);
      expect((await adopt(LOOP)).status).toBe(400);
      expect(sets).toEqual([]);
    });
  });
});

describe("issue 666 clause 4: every web.url change is an activity row", () => {
  it("setWebUrl: who, old → new, and the path", () => {
    const s = store({ web: { url: "https://old.example.com" } } as UserConfig);
    setWebUrl(ALIAS, s.merge, s.read, {
      path: "cli web url",
      who: "person:acme",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        verb: "web-url",
        detail: expect.stringMatching(
          /https:\/\/old\.example\.com → https:\/\/acme\.internal .*cli web url.*person:acme/,
        ),
      }),
    ]);
  });

  it("the migration too", () => {
    const s = store({ web: { url: LOOP } } as UserConfig);
    migrateWebUrl(
      () => [{ url: ALIAS, from: "the edge route to this install" }],
      s.merge,
      s.read,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        verb: "web-url",
        detail: expect.stringMatching(
          /https:\/\/acme\.localhost → https:\/\/acme\.internal .*migration/,
        ),
      }),
    ]);
  });

  it("a refused write is a row too", () => {
    const s = store();
    expect(() => setWebUrl(LOOP, s.merge, s.read)).toThrow();
    expect(rows[0]).toMatchObject({ verb: "web-url", outcome: "refused" });
  });
});

describe("issue 666: claim-link while the address is unset (D80's one exception)", () => {
  const run = (w: WebUrl | null, json = false) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-666-claim-"));
    let out = "";
    let err = "";
    try {
      const code = cmdWebClaimLink(
        ["--port", "4321", ...(json ? ["--json"] : [])],
        {
          out: (s) => (out += s),
          err: (s) => (err += s),
          stateDir: dir,
          // Sign-in: the person's own terminal.
          person: { tty: true, line: () => [process.pid, 1] },
          webUrl: () => w,
        },
      );
      return { code, out, err };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("unset: a link on this machine's own origin, and a note that the address isn't set", () => {
    const r = run(null);
    expect(r.code).toBe(0);
    expect(new URL(r.out.trim()).origin).toBe("http://localhost:4321");
    expect(r.err).toMatch(/address not set: run `\S+ web url <address>`/);
    expect(r.err).toMatch(/split-DNS name or edge alias/);
    const j = JSON.parse(run(null, true).out) as {
      url: string;
      address?: string;
    };
    expect(new URL(j.url).origin).toBe("http://localhost:4321");
    expect(j.address).toMatch(/address not set/);
  });

  it("set: on the address, as before, with no note", () => {
    const set = { url: ALIAS, confirmed: true };
    const r = run(set);
    expect(r.code).toBe(0);
    expect(new URL(r.out.trim()).origin).toBe(ALIAS);
    expect(r.err).not.toMatch(/address not set/);
    expect(
      (JSON.parse(run(set, true).out) as { address?: string }).address,
    ).toBeUndefined();
  });
});
