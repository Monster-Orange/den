import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
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

async function attach(id: string, view: string): Promise<TestWs> {
  const r = await wsConnect(s.port, `/api/sessions/${id}/io?view=${view}`, {
    origin: s.base,
    "sec-websocket-protocol": `den.io, den.csrf.${csrf}`,
    cookie,
  });
  if (!r.ok) throw new Error(`upgrade refused: ${r.status}`);
  await r.ws.until(() => r.ws.controls().some((m) => m.type === "session"));
  return r.ws;
}

async function setSessions(sessions: Record<string, number>): Promise<void> {
  const r = await fetch(`${s.base}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: s.base,
      cookie,
      "x-den-csrf": csrf,
    },
    body: JSON.stringify({ sessions }),
  });
  if (r.status !== 200)
    throw new Error(`settings: ${r.status} ${await r.text()}`);
}

describe("issue 1913: a view whose tab went away silently", () => {
  it("stops leading the size within twice the terminal socket's ping: the other view then sizes its own terminal", async () => {
    await setSessions({ io_ping_seconds: 1, size_leave_grace_seconds: 0 });
    const info = await host.start({
      name: "acme-north:silent",
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    const i = s.made.length - 1;
    const gone = await attach(info.ref.id, "view-gone-0001");
    gone.sendText(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    const other = await attach(info.ref.id, "view-left-0001");
    gone.silence();
    const t0 = Date.now();
    let at = 0;
    while (Date.now() - t0 < 6_000) {
      other.sendText(JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
      await new Promise((r) => setTimeout(r, 200));
      const last = s.made[i].resizes.at(-1);
      if (last?.[0] === 90 && last[1] === 30) {
        at = Date.now() - t0;
        break;
      }
    }
    expect({ sized: at > 0, within: at <= 2_500 }).toEqual({
      sized: true,
      within: true,
    });
    other.close();
    gone.destroy();
  }, 30_000);
});
