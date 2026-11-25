import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentSandboxPolicy,
  bwrapArgs,
  macProfile,
} from "../../../src/shared/agents/sandbox.js";
import { agentSandboxInput } from "../../../src/ui/cli/agent-ops.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rss-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stateDir = path.join(tmp, "state");
const distRoot = path.join(tmp, "dist");
const repo = path.join(tmp, "repos", "shop-api");
const secrets = path.join(repo, ".stack-secrets.yml");
const authDir = path.join(distRoot, "playwright", ".auth");
for (const d of [
  stateDir,
  repo,
  authDir,
  path.join(stateDir, "agent-files", "a1"),
])
  fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(secrets, "DB_PASSWORD: x\n");
fs.writeFileSync(
  path.join(repo, ".stack-secrets.example.yml"),
  "DB_PASSWORD:\n",
);
fs.writeFileSync(path.join(authDir, "admin-dev.json"), "{}\n");

const input = () =>
  agentSandboxInput({
    stateDir,
    distRoot,
    env: { HOME: tmp, PATH: "/usr/bin:/bin" },
    agentId: "a1",
    home: tmp,
    repoSecretFiles: [secrets],
  });

describe("issue 1507: the OS sandbox keeps repos' secrets files and the cached sign-ins unreadable", () => {
  it("macOS: any .stack-secrets.yml* is read-denied by name, and the sign-ins folder is unreadable", () => {
    const prof = macProfile(agentSandboxPolicy(input()));
    const R =
      '#"/\\.[sS][tT][aA][cC][kK]-[sS][eE][cC][rR][eE][tT][sS]\\.[yY][mM][lL][^/]*$"';
    for (const op of ["file-read*", "file-write*", "file-link"])
      expect(prof).toContain(`(deny ${op} (regex ${R}))`);
    expect(prof).toMatch(
      new RegExp(
        `\\(deny file-read\\*[^\\n]*${authDir.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`,
      ),
    );
    const at = (s: string) => prof.indexOf(s);
    expect(at(`(deny file-read* (regex ${R}))`)).toBeGreaterThan(
      at("(allow file-read* "),
    );
  });

  it("Linux: a known repo's secrets file is bound to /dev/null, and the sign-ins folder is a tmpfs", () => {
    const a = bwrapArgs(
      agentSandboxPolicy(input()),
      fs.existsSync,
      (f) => f,
    ).join(" ");
    expect(a).toContain(`--ro-bind /dev/null ${secrets}`);
    expect(a).toContain(`--tmpfs ${authDir}`);
  });

  const onMac =
    process.platform === "darwin" &&
    spawnSync("sandbox-exec", [
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ]).status === 0
      ? it
      : it.skip;

  onMac(
    "a sandboxed cat of ./.stack-secrets.yml is refused, the example file is read",
    () => {
      const prof = macProfile(agentSandboxPolicy(input()));
      const run = (f: string) =>
        spawnSync("sandbox-exec", ["-p", prof, "/bin/cat", f], {
          cwd: repo,
          encoding: "utf8",
        });
      expect(run("./.stack-secrets.yml").status).not.toBe(0);
      expect(run("./.STACK-SECRETS.YML").status).not.toBe(0);
      const sh = (cmd: string) =>
        spawnSync("sandbox-exec", ["-p", prof, "/bin/sh", "-c", cmd], {
          cwd: repo,
          encoding: "utf8",
        });
      expect(
        sh("python3 -c 'print(open(\".stack-secrets.yml\").read())'").stdout,
      ).not.toContain("DB_PASSWORD: x");
      expect(
        sh("mv .stack-secrets.yml moved && cat moved").stdout,
      ).not.toContain("DB_PASSWORD: x");
      expect(fs.existsSync(secrets)).toBe(true);
      expect(
        sh("ln .stack-secrets.yml linked && cat linked").stdout,
      ).not.toContain("DB_PASSWORD: x");
      expect(
        sh("cp .stack-secrets.yml copied && cat copied").stdout,
      ).not.toContain("DB_PASSWORD: x");
      expect(run("./.stack-secrets.example.yml").stdout).toContain(
        "DB_PASSWORD:",
      );
      expect(run(path.join(authDir, "admin-dev.json")).status).not.toBe(0);
    },
  );
});
