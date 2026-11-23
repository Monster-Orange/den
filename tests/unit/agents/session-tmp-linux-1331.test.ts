/**
 * Issue 1331: on Linux, a sandboxed session's own temp folder (issue 1325)
 * keeps every other session out, as on macOS. Through Den's own defaults:
 * agents start makes the folder, and the real bwrap wrap is built from
 * Den's own sandbox input.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  makeSessionTmp,
  removeSessionTmp,
  sandboxFor,
} from "../../../src/shared/agents/sandbox.js";
import { agentSandboxInput } from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle } from "./helpers/rig.js";

afterAll(cleanupRigs);

/** bwrap, when this process can start it (Linux CI). */
function bwrapWorks(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("bwrap", ["--dev-bind", "/", "/", "true"]).status === 0;
}
const itLinux = bwrapWorks() ? it : it.skip;

describe("issue 1331: on Linux, a session's temp folder keeps other sessions out", () => {
  itLinux(
    "agents start makes one; in the real wrap its own socket connects, and another session's folder can't be written",
    async () => {
      const seen = new Map<string, string | undefined>();
      const r = await rig({
        // Den's own defaults: its maker and its base.
        sessionTmp: undefined,
        sessionTmpBase: undefined,
        agentSandbox: (argv, id, tmp) => {
          seen.set(id, tmp);
          return { applied: true, argv, env: {} };
        },
      });
      expect(
        await cmdAgents(
          ["start", "-w", "north", "--persona", "planner"],
          r.deps,
        ),
      ).toBe(0);
      await settle();
      const mine = seen.get("planner");
      // Red before issue 1331: on Linux, agents start made none.
      expect(mine).toEqual(expect.stringMatching(/\/den-[A-Za-z0-9]{6}$/));
      // Another session's folder, made where Den makes them.
      const theirs = makeSessionTmp(path.dirname(mine!));
      try {
        const script =
          `const net=require("net"),fs=require("fs"),p=require("path");` +
          `const out={};` +
          `try{fs.writeFileSync(p.join(${JSON.stringify(theirs)},"planted"),"x");out.theirs="wrote"}catch(e){out.theirs="refused "+e.code}` +
          `const s=p.join(process.env.TMPDIR,"own.sock");` +
          `const sv=net.createServer(c=>c.end()).listen(s,()=>{net.connect(s).on("connect",()=>{out.own="connected";console.log(JSON.stringify(out));sv.close();process.exit(0)}).on("error",e=>{out.own="refused "+e.code;console.log(JSON.stringify(out));process.exit(0)})}).on("error",e=>{out.own="listen "+e.code;console.log(JSON.stringify(out));process.exit(0)})`;
        const w = sandboxFor(
          [process.execPath, "-e", script],
          agentSandboxInput({
            stateDir: r.stateDir,
            distRoot: r.deps.distRoot!(),
            env: process.env,
            agentId: "planner",
            sessionTmp: mine,
          }),
          { platform: "linux", on: true },
        );
        expect(w.applied).toBe(true);
        const res = spawnSync(w.argv[0]!, w.argv.slice(1), {
          encoding: "utf-8",
          env: { ...process.env, ...w.env },
        });
        const out = JSON.parse(res.stdout.trim().split("\n").pop() || "{}");
        expect(out).toEqual({
          theirs: expect.stringMatching(/^refused /),
          own: "connected",
        });
        expect(fs.existsSync(path.join(theirs, "planted"))).toBe(false);
      } finally {
        removeSessionTmp(theirs, path.dirname(theirs));
        expect(await cmdAgents(["stop", "planner"], r.deps)).toBe(0);
      }
    },
    60_000,
  );
});
