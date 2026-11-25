/**
 * Issue 1129: a resume starts the agents that were working first. Den
 * keeps each agent's last state (agents/activity.json), written by the
 * attention events only when it changes. A temp state folder only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  noteActivity,
  readActivity,
} from "../../../src/shared/agents/activity.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { Attention } from "../../../src/ui/server/attention.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1129-"));
  tmps.push(d);
  return d;
};

describe("issue 1129: each agent's last state is kept", () => {
  it("is written only when it changes", () => {
    const d = stateDir();
    expect(noteActivity(d, "a1", true)).toBe(true);
    expect(noteActivity(d, "a1", true)).toBe(false);
    expect(noteActivity(d, "a1", false)).toBe(true);
    expect(readActivity(d).a1.working).toBe(false);
  });

  it("the attention events say it: a tool or a prompt is working; a turn's end or a wait is idle; a new session says nothing", async () => {
    const d = stateDir();
    const said: Array<[string, boolean]> = [];
    const att = new Attention({
      store: new NotificationStore(d),
      outputMark: async () => null,
      nameOf: (a) => a,
      hooked: () => true,
      activity: (a, working) => said.push([a, working]),
    });
    await att.event("a1", "north", { event: "resumed", from: "tool" });
    await att.event("a2", "north", { event: "resumed", from: "prompt" });
    await att.event("a3", "north", { event: "resumed", from: "session" });
    await att.event("a1", "north", { event: "finished" });
    await att.event("a2", "north", {
      event: "waiting",
      why: "permission",
      hooked: true,
    });
    expect(said).toEqual([
      ["a1", true],
      ["a2", true],
      ["a1", false],
      ["a2", false],
    ]);
  });
});
