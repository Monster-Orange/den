import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { repoSecretLines } from "../../../src/ui/cli/doctor-command.js";

let root = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-drs-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const SECRET = "SECRET_VALUE_NEVER_SHOWN";
const put = (rel: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, SECRET + "\n", { mode: 0o600 });
};
const run = (repos: string[]) =>
  repoSecretLines({
    repoDirs: repos.map((r) => path.join(root, r)),
    distRoot: path.join(root, "dist"),
    home: root,
  });
const row = (r: ReturnType<typeof run>) =>
  r.checks.find((c) => c.id === "repo_secret_files")!;

describe("issue 1507: doctor lists repos' secrets files and the cached sign-ins", () => {
  it("names each one present, says agents' rules deny it, and never shows a value", () => {
    put("shop-api/.stack-secrets.yml");
    put("shop-api/.stack-secrets.example.yml");
    put("dist/playwright/.auth/admin-dev.json");
    put("dist/playwright/.auth/api-token-admin-dev.json");
    const r = run(["shop-api", "shop-web"]);
    expect(row(r).status).toBe("ok");
    expect(row(r).detail).toMatch(/shop-api\/\.stack-secrets\.yml/);
    expect(row(r).detail).toMatch(/2 cached sign-ins/);
    expect(row(r).detail).toMatch(/agents' rules deny/);
    expect(row(r).detail).not.toMatch(/example/);
    expect(row(r).detail).not.toMatch(/shop-web/);
    expect(row(r).detail).not.toContain(root);
    expect(r.lines.join("\n")).not.toContain(SECRET);
  });

  it("says plainly when there are none", () => {
    const r = run(["shop-api"]);
    expect(row(r).status).toBe("ok");
    expect(row(r).detail).toMatch(/no stack secrets file in a project repo/);
  });

  it("warns when one is present that agents' rules wouldn't cover", () => {
    put("shop-api/.stack-secrets.yml");
    const r = repoSecretLines({
      repoDirs: [path.join(root, "shop-api")],
      distRoot: path.join(root, "dist"),
      home: root,
      rules: () => [],
    });
    expect(row(r).status).toBe("warn");
    expect(row(r).detail).toMatch(/not covered/);
  });
});
