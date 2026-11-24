/**
 * Issue 1391: agents may read the activity trail, so a setting_change
 * carrying a typed-in secret never puts it in any approval row: the ask,
 * the person's decision, a withdrawal, a refused ask's reason. The real
 * check (checkSettingChange) on a temp user.yml, in an in-process server
 * whose principal is set as request-guard sets it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import {
  checkSettingChange,
  type SettingChangeDeps,
} from "../../../src/ui/cli/setting-change.js";
import type { DenConfig } from "../../../src/shared/den-config.js";
import {
  APPROVE_KEY_HEADER,
  approveKeyHash,
} from "../../../src/shared/web-session.js";

// Not token-shaped: redactSecrets alone would keep it.
const TYPED = "s3cr3t-typed-in";
// The person's approve key and signed-in session (as the browser has them).
const AK = "k".repeat(43);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-apset-"));
const deps: SettingChangeDeps = {
  userFile: path.join(stateDir, "config", "local", "user.yml"),
  backupDir: path.join(stateDir, "settings-backups"),
  denConfig: () => ({}) as DenConfig,
  audit: () => undefined,
  now: () => "2026-11-23T20:00:00.000Z",
};
const actions: HeldActions = {
  setting_change: {
    check: (a: Record<string, unknown>, who: { agent?: string }) =>
      checkSettingChange(deps, a, who),
    run: async () => ({ ok: true }),
  },
} as unknown as HeldActions;
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

function principalFor(req: http.IncomingMessage): Principal {
  if (req.headers["x-test-agent"])
    return {
      kind: "agent",
      actor: "agent:asker",
      workspace: "north",
      grants: [],
      session: { name: "acme-north:asker" },
    } as Principal;
  return { kind: "person-browser", session: "s1" } as Principal;
}

beforeAll(async () => {
  fs.mkdirSync(path.dirname(deps.userFile), { recursive: true });
  fs.writeFileSync(deps.userFile, "editor: code\n");
  mintActorToken(stateDir, {
    agentId: "asker",
    workspace: "north",
    sessionName: "acme-north:asker",
  });
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: { key: "s1", csrf: "c", approveKeyHash: approveKeyHash(AK) },
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(
      req,
      res,
      new URL(req.url!, "http://x").pathname,
      guard,
      { queue, actions, enabled: () => true, changed: () => undefined },
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, agent: boolean) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-test-agent": "1" } : { [APPROVE_KEY_HEADER]: AK }),
    },
    body: JSON.stringify(body),
  });
const trail = () =>
  recentActions()
    .map((e) => `${e.verb} ${e.detail} ${e.reason ?? ""}`)
    .join("\n");

describe("issue 1391: approval rows never carry a setting's free text", () => {
  it("the ask and the person's decision say changed, with lengths", async () => {
    const r = await post(
      "/api/approvals",
      {
        action: "setting_change",
        args: { key: "editor", value: `mytool --pass ${TYPED}`, reason: "r" },
        ask: true,
        note: "a test's own request",
      },
      true,
    );
    if (r.status >= 300) throw new Error(await r.text());
    const { id } = (await r.json()) as { id: string };
    // The card still shows the whole value to the person.
    expect(
      queue
        .pending()
        .find((a) => a.id === id)
        ?.details?.join("\n"),
    ).toContain(TYPED);
    const d = await post(
      `/api/approvals/${id}/decide`,
      { decision: "deny" },
      false,
    );
    if (d.status !== 200) throw new Error(await d.text());
    expect(trail()).toMatch(
      /approval-ask setting_change: editor: changed \(was 4 characters, now 29 characters\)/,
    );
    expect(trail()).toMatch(/approval-decide .*editor: changed/);
    expect(trail()).not.toContain(TYPED);
  });

  it("a refused ask: its reason never quotes the value", async () => {
    const r = await post(
      "/api/approvals",
      {
        action: "setting_change",
        args: {
          key: "web.edge_unattested",
          value: `local ${TYPED}`,
          reason: "r",
        },
        ask: true,
        note: "a test's own request",
      },
      true,
    );
    expect(r.status).toBe(400);
    expect(trail()).toMatch(
      /approval-ask setting_change .*got <\d+ characters>/,
    );
    expect(trail()).not.toContain(TYPED);
  });
});
