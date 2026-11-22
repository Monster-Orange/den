/**
 * Issue 963: on the Settings page, each gate row says what it means (en,
 * es, ja), and setting release priority to 0 asks first.
 */
import { describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const asked: unknown[] = [];
let answer = false;
jest.mock("/dialog-den.js", () => ({
  askConfirm: async (o: unknown) => {
    asked.push(o);
    return answer;
  },
}));

import { DEN_SETTINGS as SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

type Row = {
  id: string;
  keys?: string[];
  write: (v: unknown, ctx: unknown) => unknown;
};
const row = (id: string) =>
  (SETTINGS as unknown as Row[]).find((r) => r.id === id)!;

function ctx(priorityMax = 1) {
  const posts: unknown[] = [];
  return {
    posts,
    c: {
      data: { gate_slots: { priorityMax } },
      shell: { t: (k: string) => k },
      post: async (b: unknown) => (posts.push(b), true),
    },
  };
}

describe("issue 963: release priority off asks first, on the page", () => {
  it("0: asks, saying what it does; cancelled, nothing is saved", async () => {
    asked.length = 0;
    answer = false;
    const t = ctx();
    expect(await row("server.gate_priority_max").write(0, t.c)).toBe(false);
    expect(asked).toEqual([
      expect.objectContaining({
        title: "gate.priorityOffTitle",
        message: "gate.priorityOffAsk",
      }),
    ]);
    expect(t.posts).toEqual([]);
  });

  it("0, gone ahead: saved", async () => {
    asked.length = 0;
    answer = true;
    const t = ctx();
    expect(await row("server.gate_priority_max").write(0, t.c)).toBe(true);
    expect(t.posts).toEqual([{ gate_slots: { priority_max: 0 } }]);
  });

  it("any other value, or 0 when it's already off: no ask", async () => {
    asked.length = 0;
    const t = ctx();
    await row("server.gate_priority_max").write(2, t.c);
    await row("server.gate_priority_max").write(0, ctx(0).c);
    expect(asked).toEqual([]);
    expect(t.posts).toEqual([{ gate_slots: { priority_max: 2 } }]);
  });
});

describe("issue 963: each gate row says what it means, in en, es and ja", () => {
  const pub = path.join(process.cwd(), "src/ui/server/public");
  const files = ["shell.js", "i18n/es.js", "i18n/ja.js"].map((f) =>
    fs.readFileSync(path.join(pub, f), "utf-8"),
  );
  const gateRows = (SETTINGS as unknown as Row[]).filter((r) =>
    (r.keys ?? []).some((k) => k.startsWith("gate_slots.")),
  );

  it("there are gate rows", () => {
    expect(gateRows.length).toBeGreaterThan(10);
  });

  it.each(["shell.js", "i18n/es.js", "i18n/ja.js"])(
    "%s has every gate row's meaning, and the warning's words",
    (f) => {
      const s = files[["shell.js", "i18n/es.js", "i18n/ja.js"].indexOf(f)];
      for (const r of gateRows) expect(s).toContain(`"set.${r.id}.d":`);
      for (const k of [
        "gate.priorityOffTitle",
        "gate.priorityOffAsk",
        "gate.priorityOffOk",
      ])
        expect(s).toContain(`"${k}":`);
    },
  );
});
