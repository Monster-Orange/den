import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bindHub, type BindHubDeps } from "../../../src/shared/hub/hub-binding.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";
import { relinkAfterMove } from "../../../src/ui/server/hub-relink-after-move.js";
import { HubConnect } from "../../../src/ui/server/hub-connect.js";

const OLD = "https://old-hub.example.test";
const NEW = "https://new-hub.example.test";
const P1 = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
const P2 = "1b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";

let stateDir = "";
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-relink-"));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function switchHubs(links: Record<string, string>) {
  let file = {
    workspaces: Object.fromEntries(
      Object.entries(links).map(([ws, id]) => [
        ws,
        { hub_project: { id, slug: `${ws}-slug`, name: `${ws} name` } },
      ]),
    ),
  } as unknown as WorkspacesFile;
  const d: BindHubDeps = {
    stateDir,
    readWorkspaces: () => file,
    writeWorkspaces: (f) => void (file = f),
  };
  bindHub(d, { url: OLD });
  bindHub(d, { url: NEW });
}

function rig(onHub: Record<string, string | null>) {
  const linked: Record<string, unknown> = {};
  const counted: number[] = [];
  return {
    linked,
    counted,
    deps: {
      stateDir: () => stateDir,
      lookup: async (id: string) =>
        id in onHub
          ? {
              id,
              slug: `${id}-s`,
              name: `${id}-n`,
              movedFrom: onHub[id] ? { hub: onHub[id]! } : null,
              movedTo: null,
            }
          : null,
      linkOf: (ws: string) => (linked[ws] ? { id: "x" } : null),
      link: (ws: string, l: unknown) => void (linked[ws] = l),
      picked: (n: number) => void counted.push(n),
    },
  };
}

describe("issue 1632 part 2: Connect to the Hub a project moved to re-links it", () => {
  it("re-links each archived project the new Hub lists as moved from the old one, stamped with the new Hub", async () => {
    switchHubs({ web: P1, api: P2 });
    const r = rig({ [P1]: OLD, [P2]: null });
    const out = await relinkAfterMove(NEW, "north", r.deps);
    expect(out).toEqual({ relinked: ["web"], ask: ["api"] });
    expect(r.linked).toEqual({
      web: {
        id: P1,
        slug: `${P1}-s`,
        name: `${P1}-n`,
        hub: { origin: NEW, company: "north" },
      },
    });
    expect(r.counted).toEqual([1]);
  });

  it("no archive for this Hub (a first Connect): nothing is looked up", async () => {
    const r = rig({ [P1]: OLD });
    expect(await relinkAfterMove(NEW, undefined, r.deps)).toEqual({
      relinked: [],
      ask: [],
    });
    expect(r.counted).toEqual([]);
  });

  it("an archive made for another Hub is never used", async () => {
    switchHubs({ web: P1 });
    const r = rig({ [P1]: OLD });
    expect(
      (await relinkAfterMove("https://third.example.test", undefined, r.deps))
        .relinked,
    ).toEqual([]);
  });
});

describe("issue 1632 part 2: Connect runs the re-link after its rebind", () => {
  const ORIGIN = "http://localhost:7300";
  const connect = (rebind: () => Promise<void>) => {
    const order: string[] = [];
    const hc = new HubConnect({
      now: () => 1,
      config: () => null,
      exchange: async () => ({
        token: "hubi_TESTONLY_rl",
        hubUrl: NEW,
        company: { slug: "north" },
      }),
      revoke: async () => true,
      store: async () => ({ kind: "file", source: "file:/s/t", where: "/s/t" }),
      forget: async () => undefined,
      readToken: async () => null,
      readUser: () => ({}),
      writeUser: () => undefined,
      installLabel: () => "den on box",
      rebind: async () => {
        order.push("rebind");
        await rebind();
      },
      relinkMoved: async (url, token, company) =>
        void order.push(`relink ${url} ${token} ${company}`),
    });
    const r = hc.start(ORIGIN, NEW);
    if (!r.ok) throw new Error(r.error);
    const state = new URL(r.location).searchParams.get("state")!;
    return { hc, order, state };
  };

  it("after the rebind, with the new Hub, its token and the company", async () => {
    const c = connect(async () => undefined);
    await c.hc.finish(new URLSearchParams({ code: "c", state: c.state }));
    expect(c.order).toEqual(["rebind", `relink ${NEW} hubi_TESTONLY_rl north`]);
  });

  it("not when the rebind failed", async () => {
    const c = connect(async () => {
      throw new Error("no");
    });
    await c.hc.finish(new URLSearchParams({ code: "c", state: c.state }));
    expect(c.order).toEqual(["rebind"]);
  });
});
