/**
 * Issue 592: whether sudo is ready (a password held, or none needed) runs
 * `sudo -n true`. A test server (the test-install launch flag) never runs
 * sudo for it: it answers not ready, so an Allow that needs sudo asks for
 * the password and nothing runs. A recording fake sudo (DEN_SYSTEM_SUDO)
 * shows whether sudo ran; the real one never does.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-sudo-ready-"));
const log = path.join(dir, "ran");
const fake = path.join(dir, "sudo");
fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`, {
  mode: 0o755,
});
const before = process.env.DEN_SYSTEM_SUDO;
process.env.DEN_SYSTEM_SUDO = fake;
afterAll(() => {
  if (before === undefined) delete process.env.DEN_SYSTEM_SUDO;
  else process.env.DEN_SYSTEM_SUDO = before;
  fs.rmSync(dir, { recursive: true, force: true });
});
const ran = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");

describe("sudoReadyNow", () => {
  it("a test server never runs sudo, and says not ready", async () => {
    const { sudoReadyNow } =
      await import("../../../src/ui/server/sudo-store.js");
    expect(sudoReadyNow({ testInstall: true })).toBe(false);
    expect(ran()).toBe("");
  });

  it("any other server asks sudo -n true", async () => {
    const { sudoReadyNow } =
      await import("../../../src/ui/server/sudo-store.js");
    expect(sudoReadyNow({ testInstall: false })).toBe(true);
    expect(ran().trim()).toBe("-n true");
  });
});
