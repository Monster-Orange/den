import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { shellEnvNames } from "../../../src/ui/cli/doctor-env-hold.js";

let tmp: string;
let shell: string;
let ran: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-shell-env-"));
  ran = path.join(tmp, "ran");
  shell = path.join(tmp, "fake-shell");
  fs.writeFileSync(shell, `#!/bin/sh\n: > "${ran}"\necho FROM_THE_SHELL=1\n`, {
    mode: 0o755,
  });
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("shellEnvNames: the person's shell is asked only when the login shell is on", () => {
  it('never runs the shell when DEN_LOGIN_SHELL is "off", as in every test', () => {
    fs.rmSync(ran, { force: true });
    const names = shellEnvNames({
      SHELL: shell,
      PATH: "/usr/bin:/bin",
      DEN_LOGIN_SHELL: "off",
    });
    expect(fs.existsSync(ran)).toBe(false);
    expect(names).not.toContain("FROM_THE_SHELL");
    expect(names).toContain("SHELL");
  });

  it("runs it, and adds the names it prints, when the login shell is on", () => {
    fs.rmSync(ran, { force: true });
    const names = shellEnvNames({
      SHELL: shell,
      PATH: "/usr/bin:/bin",
      DEN_LOGIN_SHELL: "",
    });
    expect(fs.existsSync(ran)).toBe(true);
    expect(names).toContain("FROM_THE_SHELL");
  });
});
