/**
 * `up`, `down`, `restart` and `setup --help` name -w (a dogfood finding on
 * 0.4.1-dev.4: the cross-workspace flag worked but no help said so). The
 * real bin/den in a throwaway distribution (helpers/dist.ts).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import { makeDist, type Dist } from "../sessions/helpers/dist.js";

let dist: Dist | null = null;
const d = () => (dist ??= makeDist("den-wflag-help-"));
afterAll(() => {
  if (dist) fs.rmSync(dist.tmp, { recursive: true, force: true });
});

describe("--help names -w", () => {
  it.each(["up", "down", "restart", "setup"])(
    "%s --help",
    (cmd) => {
      const r = d().den([cmd, "--help"]);
      expect([cmd, r.code]).toEqual([cmd, 0]);
      expect([cmd, /(^|[\s[/])-w(,|\/| )/m.test(r.out)]).toEqual([cmd, true]);
      expect([cmd, /--workspace|-w <workspace>/.test(r.out)]).toEqual([
        cmd,
        true,
      ]);
    },
    60_000,
  );
});
