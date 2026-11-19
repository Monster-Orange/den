/**
 * Issue 172's live check, run as the bed runs it (runLikeBed: setup, run,
 * expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate172-fake-den.mjs, real loopback HTTP for the push).
 * "They are told on a phone": the check is a device of its own, a
 * loopback push endpoint with its own keys. It must receive Den's Web Push
 * for the alert, VAPID-signed with the served key, readable with its keys,
 * in the alert's words, with no tool line. Each broken part fails the
 * clause; the device is unsubscribed after.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const PHONE = "they are told on a phone";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function runGate(push: string) {
  const js = `
    const g = await import("./gate/172.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate172-fake-den.mjs");
    const bed = fakeBed({ push: ${JSON.stringify(push)} });
    const out = await runLikeBed("172.mjs", g, bed.ctx);
    console.log(JSON.stringify({ left: bed.subsLeft(), removed: bed.removed, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    left: number;
    removed: string[];
    rows?: Row[];
    error?: string;
  };
}

const phone = (r: ReturnType<typeof runGate>) =>
  (r.rows ?? []).find((x) => x.clause === PHONE);

describe("gate/172.mjs as the bed runs it: the phone", () => {
  it("Den's signed, encrypted push reaches the check's own device: passes; unsubscribed after", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(phone(r)?.ok).toBe(true);
    expect(phone(r)?.detail).toContain("needs your permission");
    expect(r.left).toBe(0);
    expect(r.removed).toEqual(["gate-172-wait"]);
  });

  it("no push sent: fails", () => {
    const r = runGate("none");
    expect(r.error).toBeUndefined();
    expect(phone(r)?.ok).toBe(false);
    expect(r.left).toBe(0);
  });

  it("a push not signed by the served key: fails", () => {
    expect(phone(runGate("unsigned"))?.ok).toBe(false);
  });

  it("a push the device can't read: fails", () => {
    expect(phone(runGate("garbled"))?.ok).toBe(false);
  });

  it("a push that carries the tool line: fails", () => {
    expect(phone(runGate("leak"))?.ok).toBe(false);
  });
});
