/**
 * R16 secret_env through the real CLI: `up` resolves a service's secret_env
 * (here through a fake `doppler` on PATH, so the scoped argv is visible) and
 * sets it only in the command's env; a missing key fails with exit 1 and
 * starts nothing; a dry run never calls the provider and lists names only.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const FAKE = "sk-test-123";

let tmp: string;
let marks: string;
let repos: string;
let fakeBin: string;

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-secret-env-"));
  marks = path.join(tmp, "marks");
  fs.mkdirSync(marks);
  repos = path.join(tmp, "repos");
  fakeBin = path.join(tmp, "bin");
  const distRoot = path.join(tmp, "den");
  const names = ["keyed", "stackrepo"];
  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(path.join(distRoot, "config", "den.yml"), "repos_root: ../repos\n");
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    names.map((n) => `${n}:\n  gh: x/${n}\n`).join(""),
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...names.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "keyed", ".den.yml"),
    [
      "name: keyed",
      "services:",
      "  keyed:",
      "    secret_env:",
      "      SOME_KEY: proj/dev_personal/SOME_KEY",
      "    commands:",
      "      local:",
      "        up:",
      `          cmd: printenv SOME_KEY > ${path.join(marks, "got")}`,
      "          detachable: false",
      `        down: touch ${path.join(marks, "down")}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "stackrepo", ".den.yml"),
    [
      "name: stackrepo",
      "compose:",
      "  secret_env:",
      "    OPENAI_API_KEY: proj/dev_personal/OPENAI_API_KEY",
      "",
    ].join("\n"),
  );
  // A fake doppler: records each call's argv; knows one key.
  write(
    path.join(fakeBin, "doppler"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${path.join(marks, "doppler-calls")}`,
      'case "$3" in',
      `  SOME_KEY) [ -n "$FAKE_DOPPLER_HAS_KEY" ] && { echo ${FAKE}; exit 0; } ;;`,
      "esac",
      "echo 'Doppler Error: Could not find requested secret' >&2",
      "exit 1",
      "",
    ].join("\n"),
    0o755,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
});

const ENGINE = path.resolve(__dirname, "../../..");
const cli = (
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; out: string }> =>
  new Promise((resolve) => {
    const p = spawn(path.join(ENGINE, "bin", "den"), args, {
      cwd: tmp,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DEN_ROOT: path.join(tmp, "den"),
        DEN_HOME: path.join(tmp, "home"),
        DEN_INVOKE_CWD: tmp,
        DEN_SECRETS_PROVIDER: "doppler",
        DEN_FORCE_TABS: "0",
        NO_COLOR: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (status) => resolve({ status, out }));
  });

const read = (f: string): string | null =>
  fs.existsSync(path.join(marks, f))
    ? fs.readFileSync(path.join(marks, f), "utf-8")
    : null;

describe("secret_env through the CLI", () => {
  it("up resolves the scoped ref and sets the value only in the command's env", async () => {
    const r = await cli(["up", "keyed"], { FAKE_DOPPLER_HAS_KEY: "1" });
    expect({ status: r.status, out: r.out }).toMatchObject({ status: 0 });
    expect(read("got")?.trim()).toBe(FAKE);
    // (`up` also checks the backend first: `doppler me --json`.)
    expect(read("doppler-calls")?.split("\n")).toContain(
      "secrets get SOME_KEY --plain --project proj --config dev_personal",
    );
    expect(r.out).not.toContain(FAKE);
  }, 60_000);

  it("a missing key fails with exit 1, naming key, ref and provider; nothing starts", async () => {
    const r = await cli(["up", "keyed"]);
    expect(r.status).toBe(1);
    expect(read("got")).toBeNull();
    expect(r.out).toMatch(
      /SOME_KEY \(ref proj\/dev_personal\/SOME_KEY, provider doppler\): not resolved/,
    );
    expect(r.out).not.toContain(FAKE);
  }, 60_000);

  it.each([["-n"], ["--dry-run"]])(
    "up %s never calls the provider and lists key names only",
    async (flag) => {
      const r = await cli(["up", "keyed", flag], { FAKE_DOPPLER_HAS_KEY: "1" });
      expect({ status: r.status, out: r.out }).toMatchObject({ status: 0 });
      expect(read("doppler-calls")).toBeNull();
      expect(read("got")).toBeNull();
      expect(r.out).toMatch(
        /keyed: would inject secret_env SOME_KEY \(names only; not resolved in a dry run\)/,
      );
      expect(r.out).not.toContain(FAKE);
      expect(r.out).not.toContain("proj/dev_personal");
    },
    60_000,
  );

  it("restart -n of a compose repo lists compose.secret_env names, no provider call", async () => {
    const r = await cli(["restart", "stackrepo", "-n"], {
      FAKE_DOPPLER_HAS_KEY: "1",
    });
    expect({ status: r.status, out: r.out }).toMatchObject({ status: 0 });
    expect(r.out).toMatch(
      /stackrepo: would inject secret_env compose: OPENAI_API_KEY/,
    );
    expect(read("doppler-calls")).toBeNull();
  }, 60_000);

  it("validate rejects a malformed ref", async () => {
    write(
      path.join(tmp, "bad", ".den.yml"),
      "name: bad\ncompose:\n  secret_env:\n    OPENAI_API_KEY: OPENAI_API_KEY\n",
    );
    const r = await cli(["validate", path.join(tmp, "bad", ".den.yml")]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/compose\.secret_env\.OPENAI_API_KEY/);
    expect(r.out).toMatch(/exactly three non-empty parts/);
  }, 60_000);
});
