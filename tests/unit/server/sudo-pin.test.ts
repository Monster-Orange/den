/**
 * 0.4.8: Den's sudo is pinned to /usr/bin/sudo. A `sudo` earlier on PATH
 * (a directory a user or a tool can write to) never receives the admin
 * password. Only when there is none at the system path does Den look on
 * PATH, skipping its own shims. DEN_SYSTEM_SUDO names another absolute
 * system path (and the tests' fake).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  realSudoPath,
  SYSTEM_SUDO,
  systemSudo,
} from "../../../src/ui/server/sudo-store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function fakeSudo(): { dir: string; file: string } {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sudo-pin-")),
  );
  tmps.push(dir);
  const file = path.join(dir, "sudo");
  fs.writeFileSync(file, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { dir, file };
}

describe("the pinned sudo", () => {
  it("is /usr/bin/sudo when it is there, whatever PATH has first", () => {
    const planted = fakeSudo();
    const system = fakeSudo();
    expect(realSudoPath(`${planted.dir}:/usr/bin:/bin`, system.file)).toBe(
      system.file,
    );
  });

  it("falls back to PATH only when the system path has none", () => {
    const planted = fakeSudo();
    const none = path.join(planted.dir, "no-such-sudo");
    expect(realSudoPath(`${planted.dir}:/bin`, none)).toBe(planted.file);
  });

  it("defaults to /usr/bin/sudo; DEN_SYSTEM_SUDO only as an absolute path", () => {
    expect(SYSTEM_SUDO).toBe("/usr/bin/sudo");
    expect(systemSudo({})).toBe("/usr/bin/sudo");
    expect(systemSudo({ DEN_SYSTEM_SUDO: "/opt/x/sudo" })).toBe("/opt/x/sudo");
    expect(systemSudo({ DEN_SYSTEM_SUDO: "sudo" })).toBe("/usr/bin/sudo");
  });

  it("the server never runs a bare `sudo` from PATH for its own checks", () => {
    const src = ["index.ts", "sudo-store.ts"]
      .map((f) =>
        fs.readFileSync(
          path.join(process.cwd(), "src", "ui", "server", f),
          "utf-8",
        ),
      )
      .join("\n");
    expect(src).not.toMatch(/execSync\(\s*"sudo/);
  });
});
