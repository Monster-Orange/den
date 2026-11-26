import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";
import { signedIn } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { wsConnect, type TestWs } from "./helpers/ws-client.js";

let s: AgentsPageServer;
let host: HostClient;
let csrf = "";
let cookie = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const signed = await signedIn(s.stateDir, s.base);
  csrf = signed.csrf;
  cookie = signed.cookie;
}, 60_000);

afterAll(async () => {
  host?.close();
  await s?.stop();
});

async function session(name: string): Promise<[SessionInfo, number]> {
  const info = await host.start({
    name: `acme-north:${name}`,
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  return [info, s.made.length - 1];
}

async function attach(info: SessionInfo, view?: string): Promise<TestWs> {
  const q = view ? `?view=${encodeURIComponent(view)}` : "";
  const r = await wsConnect(s.port, `/api/sessions/${info.ref.id}/io${q}`, {
    origin: s.base,
    "sec-websocket-protocol": `den.io, den.csrf.${csrf}`,
    cookie,
  });
  if (!r.ok) throw new Error(`upgrade refused: ${r.status}`);
  await r.ws.until(() => r.ws.controls().some((m) => m.type === "session"));
  return r.ws;
}

const resize = (w: TestWs, cols: number, rows: number, claim = false) =>
  w.sendText(
    JSON.stringify({ type: "resize", cols, rows, ...(claim ? { claim } : {}) }),
  );
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const lastResize = (i: number) => s.made[i].resizes.at(-1) ?? [0, 0];
const sessionFrame = (w: TestWs) =>
  w.controls().find((m) => m.type === "session") as
    | { lead?: boolean; held?: boolean }
    | undefined;
const leadFrames = (w: TestWs) =>
  w.controls().filter((m) => m.type === "lead") as {
    yours: boolean;
    held: boolean;
  }[];

async function setGrace(seconds: number): Promise<void> {
  const r = await fetch(`${s.base}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: s.base,
      cookie,
      "x-den-csrf": csrf,
    },
    body: JSON.stringify({
      sessions: { size_claim_grace_seconds: seconds },
    }),
  });
  if (r.status !== 200) throw new Error(`settings: ${r.status}`);
}

describe("issue 1724: the server remembers which view holds the size", () => {
  it("a page with no view id (an older page) has no hold to keep: the first leads, another's refit is ignored, a claim moves it", async () => {
    const [info, i] = await session("legacy");
    const a = await attach(info);
    const b = await attach(info);
    resize(a, 120, 40);
    await settle();
    expect(lastResize(i)).toEqual([120, 40]);
    resize(b, 90, 30);
    await settle();
    expect(lastResize(i)).toEqual([120, 40]);
    resize(b, 90, 30, true);
    await settle();
    expect(lastResize(i)).toEqual([90, 30]);
    a.close();
    b.close();
  });

  it("the holder's socket blips: within the grace another view's refit is ignored, and the holder reattaching still holds it", async () => {
    const [info, i] = await session("blip");
    const a = await attach(info, "view-a-000001");
    expect(sessionFrame(a)).toMatchObject({ lead: true });
    resize(a, 120, 40, true);
    const b = await attach(info, "view-b-000001");
    expect(sessionFrame(b)).toMatchObject({ lead: false, held: true });
    resize(b, 80, 30);
    await settle();
    expect(lastResize(i)).toEqual([120, 40]);
    a.destroy();
    await settle();
    resize(b, 81, 31);
    await settle();
    expect(lastResize(i)).toEqual([120, 40]);
    const a2 = await attach(info, "view-a-000001");
    expect(sessionFrame(a2)).toMatchObject({ lead: true });
    resize(a2, 121, 41);
    await settle();
    expect(lastResize(i)).toEqual([121, 41]);
    resize(b, 82, 32, true);
    await settle();
    expect(lastResize(i)).toEqual([82, 32]);
    expect(leadFrames(a2).at(-1)).toMatchObject({ yours: false, held: true });
    expect(leadFrames(b).at(-1)).toMatchObject({ yours: true, held: true });
    a2.close();
    b.close();
  });

  it("the same view id again while the first socket is still open (a reload that beats its old socket's close): the newest one has it", async () => {
    const [info, i] = await session("dupe");
    const a = await attach(info, "view-d-000001");
    resize(a, 120, 40, true);
    const b = await attach(info, "view-d-000002");
    const again = await attach(info, "view-d-000001");
    expect(sessionFrame(again)).toMatchObject({ lead: true, held: true });
    resize(again, 121, 41);
    await settle();
    expect(lastResize(i)).toEqual([121, 41]);
    resize(a, 70, 20);
    await settle();
    expect(lastResize(i)).toEqual([121, 41]);
    resize(b, 71, 21);
    await settle();
    expect(lastResize(i)).toEqual([121, 41]);
    a.close();
    b.close();
    again.close();
  });

  it("gone past the grace (a Setting): the view left is told it holds the size, and its size applies", async () => {
    await setGrace(1);
    try {
      const [info, i] = await session("gone");
      const a = await attach(info, "view-g-000001");
      resize(a, 120, 40, true);
      const b = await attach(info, "view-g-000002");
      a.close();
      await settle(300);
      resize(b, 80, 30);
      await settle();
      expect(lastResize(i)).toEqual([120, 40]);
      await b.until(() => leadFrames(b).some((f) => f.yours), 3000);
      resize(b, 80, 30);
      await settle();
      expect(lastResize(i)).toEqual([80, 30]);
      b.close();
    } finally {
      await setGrace(30);
    }
  });

  it("a bad grace is refused naming its key", async () => {
    const r = await fetch(`${s.base}/api/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: s.base,
        cookie,
        "x-den-csrf": csrf,
      },
      body: JSON.stringify({ sessions: { size_claim_grace_seconds: -1 } }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/sessions\.size_claim_grace_seconds/);
  });
});
