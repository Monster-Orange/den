/**
 * CLI tables carry no ANSI when colour is off (piped `status`), and keep
 * cli-table3's colours when it is on.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { newTable } from "../../../src/ui/cli/table.js";

const ESC = "\u001b[";

function draw(colour: boolean): string {
  const t = newTable(
    { head: ["Service", "Health"], style: { head: ["cyan"] } },
    colour,
  );
  t.push(["shop", "ok"]);
  return t.toString();
}

describe("newTable", () => {
  it("colour off: borders and head cells carry no escape codes", () => {
    const out = draw(false);
    expect(out).toContain("Service");
    expect(out).toContain("┌");
    expect(out).not.toContain(ESC);
  });

  it("colour on: keeps cli-table3's colours", () => {
    expect(draw(true)).toContain(ESC);
  });
});

describe("piped `services`: no ANSI from the table (real bin/den)", () => {
  it("prints the table with no escape codes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-table-"));
    const root = path.join(tmp, "den");
    const put = (f: string, c: string) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, c);
    };
    put(path.join(root, "den.yml"), "product:\n  name: den\n");
    put(path.join(root, "config", "den.yml"), "environments: [local]\n");
    put(
      path.join(root, "config", "local", "service-catalog.yml"),
      "shop:\n  gh: acme/shop\n",
    );
    put(
      path.join(root, "config", "local", "workspaces.yml"),
      "active: [ws]\nfocus: ws\nworkspaces:\n  ws:\n    services:\n      shop:\n        mode: managed\n",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    };
    for (const k of ["FORCE_COLOR", "NO_COLOR", "CLICOLOR_FORCE", "CI"])
      delete env[k];
    env.TERM = "xterm-256color";
    try {
      const r = spawnSync(path.resolve("bin/den"), ["services"], {
        cwd: root,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      expect(r.stdout).toContain("Service");
      expect(r.stdout).toContain("shop");
      expect(r.stdout).not.toContain(ESC);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
