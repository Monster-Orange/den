/**
 * Issue 867: `waiter_return_minutes` says what it means in `gate settings`
 * (en, es, ja), and has its own row on the Settings page.
 */
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("/dialog-den.js", () => ({ askConfirm: async () => true }));

import { GATE_MEANINGS } from "../../../src/shared/gates/meanings.js";
import { DEN_SETTINGS as SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

type Row = {
  id: string;
  keys?: string[];
  read: (ctx: unknown) => unknown;
  write: (v: unknown, ctx: unknown) => unknown;
};

describe("issue 867: the waiter_return_minutes setting", () => {
  it("has its plain meaning in en, es and ja", () => {
    const m = GATE_MEANINGS as unknown as Record<
      string,
      Record<string, string>
    >;
    for (const l of ["en", "es", "ja"])
      expect(m[l]!.waiter_return_minutes).toMatch(/\S/);
  });

  it("has a Settings row that reads and writes it (default 10)", async () => {
    const r = (SETTINGS as unknown as Row[]).find((x) =>
      (x.keys ?? []).includes("gate_slots.waiter_return_minutes"),
    )!;
    expect(r).toBeDefined();
    expect(r.read({ data: { gate_slots: {} } })).toBe(10);
    const posts: unknown[] = [];
    await r.write(30, {
      data: { gate_slots: {} },
      shell: { t: (k: string) => k },
      post: async (b: unknown) => (posts.push(b), true),
    });
    expect(posts).toEqual([{ gate_slots: { waiter_return_minutes: 30 } }]);
  });
});
