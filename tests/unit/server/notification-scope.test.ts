import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { handleNotificationRoutes as Routes } from "../../../src/ui/server/notification-routes.js";

type Bell = {
  unread: number;
  waiting: { agent?: string }[];
  groups: { scope: string }[];
  mutes: { target: string }[];
};

let tmp = "";
let port = 0;
let server: http.Server;
const saved = process.env.DEN_ROOT;

function setMode(mode: "strict" | "personal"): void {
  fs.writeFileSync(
    path.join(tmp, "config", "local", "user.yml"),
    `install_mode: ${mode}\n`,
  );
}

async function bell(asAgent: boolean): Promise<Bell> {
  const r = await fetch(`http://127.0.0.1:${port}/api/notifications`, {
    headers: asAgent ? { "x-test-agent": "1" } : {},
  });
  return (await r.json()) as Bell;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ntsc-")));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  process.env.DEN_ROOT = tmp;
  const { NotificationStore } =
    await import("../../../src/shared/notifications.js");
  const { handleNotificationRoutes } =
    await import("../../../src/ui/server/notification-routes.js");
  const { setPrincipal } =
    await import("../../../src/ui/server/request-guard.js");
  const store = new NotificationStore(path.join(tmp, "state"));
  for (const ws of ["north", "south"])
    store.add({
      kind: "waiting",
      subject: `agent:${ws}-a`,
      scope: `workspace/${ws}`,
      text: `${ws} waits`,
    });
  store.add({
    source: "hub",
    kind: "mention",
    subject: "thread:t1",
    scope: "hub/elsewhere",
    text: "a Hub mention",
  });
  const attention = {
    waitingNow: () =>
      new Map([
        ["den-north:north-a", "ask"],
        ["den-south:south-a", "ask"],
      ]),
    waitingDetail: () => null,
  } as unknown as Parameters<typeof Routes>[3]["attention"];
  server = http.createServer((req, res) => {
    if (req.headers["x-test-agent"])
      setPrincipal(req, {
        kind: "agent",
        actor: "agent:north-a",
        workspace: "north",
        grants: [],
        session: { name: "den-north:north-a" },
      });
    void handleNotificationRoutes(req, res, "/api/notifications", {
      store,
      attention,
      agentProjects: () =>
        new Map([
          ["den-north:north-a", "north"],
          ["den-south:south-a", "south"],
        ]),
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  if (saved === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the bell an agent's token reads", () => {
  it("on a strict install: its own project's items and waiting agents only", async () => {
    setMode("strict");
    const b = await bell(true);
    expect(b.groups.map((g) => g.scope)).toEqual(["workspace/north"]);
    expect(b.waiting.map((w) => w.agent)).toEqual(["den-north:north-a"]);
    expect(b.unread).toBe(1);
  });

  it("on a personal install, and for the person: the whole bell", async () => {
    setMode("personal");
    expect((await bell(true)).groups).toHaveLength(3);
    setMode("strict");
    const p = await bell(false);
    expect(p.groups).toHaveLength(3);
    expect(p.waiting).toHaveLength(2);
  });
});
