/**
 * D38: process-group reads ps through the shared lookup. A ps that never
 * answers in time, or isn't there, is "couldn't tell" (null), never "the
 * group is gone": nothing is forgotten or signalled on it. Real processes
 * and a slow ps shim on PATH.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  processGroupState,
  processGroupStateSync,
  recordProcessGroup,
  stopProcessGroup,
} from "../../../src/shared/process/process-group.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-pg-lookup-"));
const slow = path.join(tmp, "slow");
const none = path.join(tmp, "none");
fs.mkdirSync(slow);
fs.mkdirSync(none);
const realPs = execFileSync("sh", ["-c", "command -v ps"], {
  encoding: "utf-8",
}).trim();
fs.writeFileSync(
  path.join(slow, "ps"),
  `#!/bin/sh\nsleep 1\nexec ${realPs} "$@"\n`,
  { mode: 0o755 },
);

const saved = {
  PATH: process.env.PATH,
  T: process.env.DEN_LOOKUP_TIMEOUTS_MS,
};
const groups: number[] = [];

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.T === undefined) delete process.env.DEN_LOOKUP_TIMEOUTS_MS;
  else process.env.DEN_LOOKUP_TIMEOUTS_MS = saved.T;
  for (const g of groups.splice(0))
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      /* gone */
    }
});

function group(): number {
  const p = spawn("/bin/sh", ["-c", "sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  p.unref();
  groups.push(p.pid!);
  return p.pid!;
}

describe("process-group when ps can't answer (D38)", () => {
  it("a slow ps: couldn't tell (null), and a stop signals nothing", async () => {
    const pgid = group();
    const rec = recordProcessGroup(pgid);
    expect(rec).not.toBeNull();
    process.env.PATH = `${slow}${path.delimiter}${saved.PATH ?? ""}`;
    process.env.DEN_LOOKUP_TIMEOUTS_MS = "200,300";
    expect(processGroupStateSync(rec!)).toBeNull();
    expect(await processGroupState(rec!)).toBeNull();
    expect(await stopProcessGroup(rec!)).toEqual({
      outcome: "error",
      detail: "could not run ps",
    });
    process.env.PATH = saved.PATH;
    expect(processGroupStateSync(rec!)?.state).toBe("ours");
  }, 30_000);

  it("no ps at all: null too, never gone", async () => {
    const pgid = group();
    const rec = recordProcessGroup(pgid)!;
    process.env.PATH = none;
    expect(processGroupStateSync(rec)).toBeNull();
    expect(await processGroupState(rec)).toBeNull();
  }, 30_000);
});
