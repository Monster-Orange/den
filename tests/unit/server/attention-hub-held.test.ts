/**
 * Issue 701: the bell says when a Hub comment waits too long for its agent
 * and why (issue 664's held item, now for every reason), and when a typed
 * one has no answer yet. Each row has a key the page says in its own
 * language (en, es, ja). A temp store or a fake one; invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";
import { HELD_CODES } from "../../../src/shared/hub-delivery-loop";
import { heldBell } from "../../../src/ui/server/hub-delivery-service";
import type { AgentRecord } from "../../../src/shared/agents/records";

let dir = "";
const clock = Date.parse("2026-01-02T03:04:05.000Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-701b-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type NoAnswer = {
  hubNoAnswer: (
    agent: string,
    workspace: string,
    w: { count: number; minutes: number; artifact?: string; url?: string },
  ) => void;
};

describe("issue 701: held Hub comments in the bell", () => {
  it("a held comment's item says its reason, with a key per reason", () => {
    const added: { subject: string; text: string; msg?: unknown }[] = [];
    const store = {
      add: (n: { subject: string; text: string; msg?: unknown }) => {
        added.push(n);
        return null;
      },
      withdraw: () => true,
    };
    const recOf = () =>
      ({
        id: "designer-1",
        persona: "designer",
        workspace: "north",
      }) as unknown as AgentRecord;
    heldBell("designer-1", 2, 4 * 60_000, 300, {
      store,
      recOf,
      now: 0,
      why: "permission",
    });
    expect(added).toEqual([]);
    heldBell("designer-1", 2, 6 * 60_000, 300, {
      store,
      recOf,
      now: 120_000,
      why: "permission",
    });
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe(
      "designer: 2 messages wait for 6 min. Waiting: a permission question is on its screen",
    );
    expect(added[0].msg).toEqual({
      key: "bell.m.held.permission",
      vars: { name: "designer", n: 2, m: 6 },
    });
  });

  it("a typed comment with no answer yet", () => {
    const store = new NotificationStore(dir, () => new Date(clock));
    const a = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: () => "Designer",
      now: () => clock,
      hooked: () => true,
    });
    (a as unknown as NoAnswer).hubNoAnswer("ag-1", "web", {
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

  it("every reason's key is said in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const en = fs.readFileSync(path.join(root, "shell.js"), "utf-8");
    const es = fs.readFileSync(path.join(root, "i18n/es.js"), "utf-8");
    const ja = fs.readFileSync(path.join(root, "i18n/ja.js"), "utf-8");
    const keys = [
      ...HELD_CODES.filter((c) => c !== "not_at_prompt").map(
        (c) => `bell.m.held.${c}`,
      ),
      "bell.m.hubNoAnswer",
    ];
    for (const k of keys)
      for (const src of [en, es, ja]) expect(src).toContain(`"${k}":`);
  });
});
