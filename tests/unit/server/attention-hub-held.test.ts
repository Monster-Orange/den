/**
 * Issue 701: the bell says when a Hub comment waits too long for its agent
 * (and why), and when a typed one has no answer yet. Each row has a key
 * the page says in its own language (en, es, ja). A temp store; invented
 * names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";
import { HELD_CODES } from "../../../src/shared/hub-delivery-loop";

let dir = "";
const clock = Date.parse("2026-01-02T03:04:05.000Z");

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: () => "Designer",
    now: () => clock,
    hooked: () => true,
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-701b-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Held = {
  hubHeld: (
    agent: string,
    workspace: string,
    w: { count: number; reason: string; minutes: number },
  ) => void;
  hubNoAnswer: (
    agent: string,
    workspace: string,
    w: { count: number; minutes: number; artifact?: string; url?: string },
  ) => void;
};

describe("issue 701: held Hub comments in the bell", () => {
  it("a held comment: its count, minutes and reason, with a key per reason", () => {
    const { store, a } = mk();
    (a as unknown as Held).hubHeld("ag-1", "web", {
      count: 2,
      reason: "permission",
      minutes: 6,
    });
    const n = store.list().find((x) => x.subject === "agent:ag-1");
    expect(n?.msg?.key).toBe("bell.m.hubHeld.permission");
    expect(n?.msg?.vars).toMatchObject({ name: "Designer", n: 2, minutes: 6 });
    expect(n?.text).toMatch(/2 Hub comments for Designer have waited 6 min/);
  });

  it("a typed comment with no answer yet", () => {
    const { store, a } = mk();
    (a as unknown as Held).hubNoAnswer("ag-1", "web", {
      count: 1,
      minutes: 30,
      artifact: "Pricing page",
      url: "https://hub.example.test/a/doc#th_1",
    });
    const n = store.list().find((x) => x.subject === "agent:ag-1");
    expect(n?.msg?.key).toBe("bell.m.hubNoAnswer");
    expect(n?.link).toBe("https://hub.example.test/a/doc#th_1");
    expect(n?.text).toMatch(/no answer yet after 30 min/);
  });

  it("every reason's key is said in en, es and ja", async () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const en = fs.readFileSync(path.join(root, "shell.js"), "utf-8");
    const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf-8");
    const ja = fs.readFileSync(path.join(root, "i18n/ja.js"), "utf-8");
    const keys = [
      ...HELD_CODES.map((c) => `bell.m.hubHeld.${c}`),
      "bell.m.hubNoAnswer",
    ];
    for (const k of keys)
      for (const src of [en, es, ja]) expect(src).toContain(`"${k}":`);
  });
});
