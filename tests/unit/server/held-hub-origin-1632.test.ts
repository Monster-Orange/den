import { describe, expect, it } from "@jest/globals";
import { heldActions } from "../../../src/ui/server/held-actions.js";

const OLD_HUB = "https://old-hub.example.test";
const NEW_HUB = "https://new-hub.example.test";

function rig() {
  let origin: string | null = OLD_HUB;
  const ran: string[] = [];
  const ok = (a: Record<string, unknown>) => ({
    ok: true as const,
    args: { project: a.project, hub: "p1" },
    summary: "s",
    params: {},
    details: [],
  });
  const actions = heldActions({
    hubOrigin: () => origin,
    hubLink: {
      check: async (a: Record<string, unknown>) => ok(a),
      run: async () => void ran.push("hub_link"),
    },
    hubCreate: {
      check: (a: Record<string, unknown>) => ok(a),
      run: async () => void ran.push("hub_project_create"),
    },
  } as unknown as Parameters<typeof heldActions>[0]);
  return {
    actions,
    ran,
    move: (o: string | null) => void (origin = o),
  };
}

describe.each(["hub_link", "hub_project_create"])(
  "issue 1632 part 4: %s is bound to the Hub it was asked on",
  (action) => {
    it("the ask records the connected Hub's origin, whatever the agent sent", async () => {
      const r = rig();
      const c = await r.actions[action].check(
        { project: "web", hubOrigin: NEW_HUB },
        {},
      );
      expect(c.ok && c.args.hubOrigin).toBe(OLD_HUB);
    });

    it("the Allow's check again passes on the same Hub", async () => {
      const r = rig();
      const c = await r.actions[action].check({ project: "web" }, {});
      if (!c.ok) throw new Error(c.error);
      const again = await r.actions[action].check({ ...c.args }, undefined, {
        again: true,
      });
      expect(again.ok).toBe(true);
    });

    it("the Allow's check again refuses once the install is on another Hub", async () => {
      const r = rig();
      const c = await r.actions[action].check({ project: "web" }, {});
      if (!c.ok) throw new Error(c.error);
      r.move(NEW_HUB);
      const again = await r.actions[action].check({ ...c.args }, undefined, {
        again: true,
      });
      expect(again).toEqual({
        ok: false,
        error: expect.stringMatching(/another Hub/),
      });
    });

    it("and refuses once the install is on no Hub", async () => {
      const r = rig();
      const c = await r.actions[action].check({ project: "web" }, {});
      if (!c.ok) throw new Error(c.error);
      r.move(null);
      const again = await r.actions[action].check({ ...c.args }, undefined, {
        again: true,
      });
      expect(again.ok).toBe(false);
    });
  },
);
