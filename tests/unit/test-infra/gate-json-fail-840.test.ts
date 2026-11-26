import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function setupWith(n: number, out: string, code = 0) {
  const js = `
    const g = await import("./gate/${n}.mjs");
    const ctx = { cli: () => ({ code: ${code}, out: ${JSON.stringify(out)}, err: "" }) };
    try {
      const s = await g.setup(ctx);
      console.log(JSON.stringify({ state: s ?? null }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e?.message ?? e) }));
    }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    state?: unknown;
    error?: string;
  };
}

const DOCTOR_OK = JSON.stringify({
  ok: true,
  checks: [{ id: "node", status: "ok", detail: "v24" }],
});
const ACCOUNTS_OK = JSON.stringify({
  runtime: { id: "den-claude", name: "Claude Code" },
  accounts: [
    { id: "1", label: "Claude account A", tokenSet: false, first: true },
  ],
});

describe.each([
  [335, "doctor", DOCTOR_OK],
  [339, "agents accounts list", ACCOUNTS_OK],
])("gate/%i reads %s --json or stops", (n, what, good) => {
  it("good JSON: setup goes on", () => {
    expect(setupWith(n, good).error).toBeUndefined();
  });

  it.each([
    ["not JSON", "not json"],
    ["nothing at all", ""],
    ["a line before the JSON", `Warning: something\n${good}`],
  ])("%s: setup throws, naming the command and what it printed", (_k, out) => {
    const r = setupWith(n, out);
    expect(r.state).toBeUndefined();
    expect(r.error).toContain(`${what} --json did not print JSON`);
  });

  it("an exit the check doesn't expect: setup throws with the exit code", () => {
    const r = setupWith(n, good, 3);
    expect(r.error).toContain(`${what} --json exited 3`);
  });
});

describe("doctor --json with no checks", () => {
  it.each([
    ["an empty list", JSON.stringify({ ok: true, checks: [] })],
    ["no list", JSON.stringify({ ok: true })],
  ])("%s: setup throws (doctor always has rows)", (_k, out) => {
    expect(setupWith(335, out).error).toContain(
      "doctor --json printed no checks",
    );
  });

  it("doctor's exit 1 (a failing row) still reads its checks", () => {
    expect(setupWith(335, DOCTOR_OK, 1).error).toBeUndefined();
  });
});

describe("the error note never carries a token (issue 840 review)", () => {
  it.each([
    ["a bare token", "token sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX broken {"],
    ["a key=value secret", 'password=hunter2-hunter2 and {"x":'],
    ["a bearer header", "Authorization: Bearer abc.def.ghi-jkl {"],
    [
      "a long store reference",
      "op://Vault/Item/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 {",
    ],
  ])("%s in output that isn't JSON is masked in the error", (_k, out) => {
    const r = setupWith(339, out);
    expect(r.error).toContain("did not print JSON");
    expect(r.error).toContain("[REDACTED]");
    for (const secret of [
      "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWX",
      "hunter2-hunter2",
      "abc.def.ghi-jkl",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    ])
      expect(r.error).not.toContain(secret);
  });
});
