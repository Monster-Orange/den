/**
 * Hardening: a service start runs only on a request that names the
 * command it was asked for. The ask's check adds the command's
 * fingerprint; the check again at the Allow refuses a request with none
 * (one made before Den kept it, or args changed on the way), so an Allow
 * is never for a command the dialog didn't show.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "@jest/globals";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import { createApprovalQueue } from "../../../src/ui/server/approval-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stu-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function fakes() {
  const tried: string[] = [];
  const deps: HeldActionDeps = {
    rules: () => ({ home: "/home/x" }) as never,
    validate: () => ({ ok: true }) as never,
    workspaceCreateRefusal: () => null,
    createWorkspace: (n) => n,
    activateWorkspace: () => undefined,
    workspaceActive: () => true,
    workspaceExists: () => true,
    defaultWorkspace: () => "default",
    serviceTarget: (s) => ({ ok: true, address: s, command: "npm run dev" }),
    tryService: async (address) => {
      tried.push(address);
      return { ok: true, exitCode: null, ready: true, lines: [] };
    },
  };
  return { deps, tried };
}

describe("hardening: service_try at the Allow needs the command's fingerprint", () => {
  it("the ask itself needs none: Den adds it", async () => {
    const c = await heldActions(fakes().deps).service_try.check({
      service: "shop",
    });
    expect(c.ok).toBe(true);
  });

  it("the check again with no fingerprint: refused", async () => {
    const c = await heldActions(fakes().deps).service_try.check(
      { service: "shop" },
      undefined,
      { again: true },
    );
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).toMatch(/ask again/);
  });

  it("a waiting request with none, allowed: nothing runs", async () => {
    const f = fakes();
    const actions = heldActions(f.deps);
    const queue = createApprovalQueue(actions, () => stateDir);
    const a = queue.request({
      actor: "person",
      action: "service_try",
      args: { service: "shop" },
      summary: "start shop",
    });
    const r = await queue.decide(a.id, "allow", "s1");
    expect(JSON.stringify(r)).toMatch(/ask again/);
    expect(f.tried).toEqual([]);
  });

  it("a waiting request with its fingerprint, allowed: it runs", async () => {
    const f = fakes();
    const actions = heldActions(f.deps);
    const c = await actions.service_try.check({ service: "shop" });
    if (!c.ok) throw new Error(c.error);
    const queue = createApprovalQueue(actions, () => stateDir);
    const a = queue.request({
      actor: "person",
      action: "service_try",
      args: c.args,
      summary: c.summary,
    });
    await queue.decide(a.id, "allow", "s1");
    expect(f.tried).toEqual(["shop"]);
  });
});
