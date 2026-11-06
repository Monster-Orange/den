/**
 * `up --plan -w <ws>` with no repo and no `-a`: `-w` picks the workspace
 * but not what in it to start, so the plan came back "No services
 * specified and no invocation target resolvable" (0.2.8-dev.0). It is
 * now a one-line usage error, exit 2, naming the forms that work.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { upNeedsTarget } from "../../../src/ui/cli/up-args.js";

const ENGINE = path.resolve(__dirname, "../../..");

describe("upNeedsTarget", () => {
  it("names -a and a repo, keeping --plan", () => {
    expect(upNeedsTarget("acme", "shop", false)).toBe(
      "up -w shop needs what to start: `acme up -a -w shop` for the whole " +
        "workspace, or `acme up <repo> -w shop` for one repo and its dependencies.",
    );
    expect(upNeedsTarget("acme", "shop", true)).toContain(
      "`acme up -a --plan -w shop`",
    );
  });

  it("never echoes an unprintable workspace", () => {
    expect(upNeedsTarget("den", "a\u001b[31m", true)).toContain(
      "up -w <workspace> needs",
    );
  });
});

describe("den up --plan -w <ws>", () => {
  let tmp = "";
  const den = (...args: string[]) =>
    spawnSync(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
      {
        cwd: tmp,
        env: {
          ...process.env,
          DEN_ROOT: tmp,
          DEN_HOME: path.join(tmp, "home"),
          DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
          CI: "1",
        },
        encoding: "utf-8",
        timeout: 60_000,
      },
    );

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-up-w-")));
    const w = (f: string, c: string) => {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.writeFileSync(path.join(tmp, f), c);
    };
    w("den.yml", "product:\n  name: den\n");
    w("config/den.yml", "environments: [local]\ngithub_org: acme\n");
    w(
      "config/local/workspaces.yml",
      [
        "active: [main, shop]",
        "focus: main",
        "workspaces:",
        "  main: { services: {} }",
        "  shop: { services: {} }",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("is a one-line usage error, exit 2, pointing at the forms that work", () => {
    const r = den("up", "--plan", "-w", "shop");
    expect(r.status).toBe(2);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(/no invocation target resolvable/);
    expect(out.split("\n").filter((l) => l.trim())).toEqual([
      "  up -w shop needs what to start: `den up -a --plan -w shop` for the " +
        "whole workspace, or `den up <repo> --plan -w shop` for one repo and its dependencies.",
    ]);
  }, 60_000);
});
