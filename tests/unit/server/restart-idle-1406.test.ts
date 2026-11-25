/**
 * The Agents page's "Restart all idle agents" (and a
 * project's "Restart this project's idle agents"), with the count, busy in
 * the button, and after it what happened: how many restart now, and the
 * agents that wait (for their turn, a job, or the person).
 *
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  restartIdleBarHtml,
  restartIdleSaid,
  restartIdleWsHtml,
} from "../../../src/ui/server/public/restart-result.js";

const t = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;

describe("issue 1406: Restart all idle agents", () => {
  it("offered with the count when two or more are running; not for one", () => {
    expect(restartIdleBarHtml(1, t)).toBe("");
    const h = restartIdleBarHtml(3, t);
    expect(h).toContain('data-act="restart-idle"');
    expect(h).toContain("[ag.ri.all:3]");
  });

  it("a project's own button, with its name, for two or more there", () => {
    expect(restartIdleWsHtml("north", 1, t)).toBe("");
    const h = restartIdleWsHtml('n"orth', 2, t);
    expect(h).toContain('data-act="restart-idle-ws"');
    expect(h).toContain('data-ws="n&quot;orth"');
    expect(h).toContain("[ag.ri.ws:2]");
  });

  it("after it: how many restart now, and which agents wait", () => {
    const plan = [
      { id: "ana", workspace: "north", state: "now" },
      { id: "bo", workspace: "north", state: "turn" },
      { id: "cy", workspace: "south", state: "job" },
      { id: "di", workspace: "south", state: "unknown" },
    ];
    expect(restartIdleSaid(plan, t)).toBe("[ag.ri.said:1|bo, cy, di]");
    expect(restartIdleSaid(plan.slice(0, 1), t)).toBe("[ag.ri.saidAll:1]");
    expect(restartIdleSaid([], t)).toBe("[ag.ri.none]");
  });

  it("every key is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const keys = [
      "ag.ri.all",
      "ag.ri.ws",
      "ag.ri.said",
      "ag.ri.saidAll",
      "ag.ri.none",
    ];
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(root, f), "utf-8");
      for (const k of keys)
        expect({ f, k, has: src.includes(`"${k}"`) }).toEqual({
          f,
          k,
          has: true,
        });
    }
  });
});
