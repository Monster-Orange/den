/**
 * 1Password for a Den running as a service: where the service-account token
 * comes from (secrets.onepassword.token), op's failure reasons in plain
 * words, and the token never leaving the op child's env.
 *
 * Fake `security` and `op` scripts sit first on PATH; the real ones are
 * never run.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { ROOT } from "./helpers/op-root.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OnePasswordProvider,
  mapOpFailure,
  opTokenSourceError,
  parseOpTokenSource,
  readOpToken,
  readSecretsConfig,
  createSecretsProvider,
  opTokenSourceSetting,
  resolveSecretEnv,
} from "../../../src/shared/secrets/index.js";
import {
  doctorRows,
  formatDoctor,
} from "../../../src/ui/cli/doctor-command.js";

const TOKEN = "ops_FAKE-token-9f3c1d7e-not-real";
const USER_YML = path.join(ROOT, "config", "local", "user.yml");
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "op-bin-"));
const savedEnv = { ...process.env };

function script(name: string, body: string): void {
  const f = path.join(BIN, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
}

// Fake security: the item "op-service-account" holds TOKEN; -w prints it.
script(
  "security",
  `svc=""; w=0
while [ $# -gt 0 ]; do case "$1" in -s) svc="$2"; shift;; -w) w=1;; esac; shift; done
if [ "$svc" != "op-service-account" ]; then exit 44; fi
if [ $w = 1 ]; then echo "${TOKEN}"; fi`,
);
// Fake op: says whether it got the token (never prints it); FAKE_OP_STDERR
// makes it fail with that text.
script(
  "op",
  `if [ -n "$FAKE_OP_STDERR" ]; then echo "$FAKE_OP_STDERR" >&2; exit 1; fi
if [ "$OP_SERVICE_ACCOUNT_TOKEN" = "${TOKEN}" ]; then echo "got-token"; else echo "no-token"; fi`,
);

const REF = "vault/item/field";
const mac = { platform: "darwin" as NodeJS.Platform };

function userYml(text: string): void {
  fs.writeFileSync(USER_YML, text);
}

beforeEach(() => {
  process.env.PATH = `${BIN}:/usr/bin:/bin`;
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  delete process.env.FAKE_OP_STDERR;
  fs.rmSync(USER_YML, { force: true });
});
afterEach(() => {
  // Keep process.env the real object: a child's PATH lookup needs it.
  for (const k of Object.keys(process.env))
    if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
});

async function resolveWith(p: OnePasswordProvider) {
  return resolveSecretEnv({ K: REF }, p, "svc");
}

describe("keychain source", () => {
  it("resolves a ref with OP_SERVICE_ACCOUNT_TOKEN absent from the env", async () => {
    const p = new OnePasswordProvider({
      tokenSource: parseOpTokenSource("keychain:op-service-account"),
      tokenDeps: mac,
    });
    const r = await resolveWith(p);
    expect(r).toEqual({ ok: true, env: { K: "got-token" } });
    // Not left behind in this process.
    expect(process.env.OP_SERVICE_ACCOUNT_TOKEN).toBeUndefined();
  });

  it("without a source, op gets no token (the old behaviour)", async () => {
    const r = await resolveWith(new OnePasswordProvider());
    expect(r).toEqual({ ok: true, env: { K: "no-token" } });
  });

  it("a missing item is a token-source failure naming the source", async () => {
    const p = new OnePasswordProvider({
      tokenSource: parseOpTokenSource("keychain:nope"),
      tokenDeps: mac,
    });
    const r = await resolveWith(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/keychain: nope.*not found/);
  });

  it("is refused off macOS, with a plain reason", async () => {
    const r = await readOpToken(
      parseOpTokenSource("keychain:op-service-account"),
      {
        platform: "linux",
      },
    );
    expect(r).toEqual({
      ok: false,
      reason: expect.stringMatching(/macOS keychain is not available/),
    });
  });

  it("passes the service name as an argument, not through a shell", async () => {
    const r = await readOpToken(
      parseOpTokenSource("keychain:x; touch /nonexistent-marker"),
      mac,
    );
    expect(r.ok).toBe(false);
  });
});

describe("file source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-file-"));
  const f = path.join(dir, "token");
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("refuses mode 644 and works at 600", async () => {
    fs.writeFileSync(f, `${TOKEN}\n`);
    fs.chmodSync(f, 0o644);
    const src = parseOpTokenSource(`file:${f}`);
    const bad = await readOpToken(src);
    expect(bad).toEqual({
      ok: false,
      reason: expect.stringMatching(/file mode is 644; it must be 600/),
    });
    fs.chmodSync(f, 0o600);
    expect(await readOpToken(src)).toEqual({ ok: true, token: TOKEN });
    const r = await resolveWith(new OnePasswordProvider({ tokenSource: src }));
    expect(r).toEqual({ ok: true, env: { K: "got-token" } });
  });

  it("refuses 640 and 700 too, and expands ~", async () => {
    fs.chmodSync(f, 0o640);
    expect((await readOpToken(parseOpTokenSource(`file:${f}`))).ok).toBe(false);
    fs.chmodSync(f, 0o700);
    expect((await readOpToken(parseOpTokenSource(`file:${f}`))).ok).toBe(false);
    fs.chmodSync(f, 0o600);
    const r = await readOpToken(parseOpTokenSource("file:~/token"), {
      home: dir,
    });
    expect(r).toEqual({ ok: true, token: TOKEN });
  });
});

describe("env source", () => {
  it("reads the named var and passes it as OP_SERVICE_ACCOUNT_TOKEN", async () => {
    const p = new OnePasswordProvider({
      tokenSource: parseOpTokenSource("env:MY_OP_TOKEN"),
      tokenDeps: { env: { MY_OP_TOKEN: TOKEN } },
    });
    expect(await resolveWith(p)).toEqual({ ok: true, env: { K: "got-token" } });
  });

  it("a configured var that is unset says so, naming it", async () => {
    const p = new OnePasswordProvider({
      tokenSource: parseOpTokenSource("env:MY_OP_TOKEN"),
      tokenDeps: { env: {} },
    });
    const r = await resolveWith(p);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.message).toMatch(/env: MY_OP_TOKEN: env var is not set/);
  });

  it("the default is today's behaviour: the process env's own token", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = TOKEN;
    expect(await resolveWith(new OnePasswordProvider())).toEqual({
      ok: true,
      env: { K: "got-token" },
    });
  });
});

describe("the key's shape is checked at config load", () => {
  it.each([
    "keychain:",
    "file:",
    "env:",
    "env:1BAD",
    "keychain:-x",
    "vault",
    "plain",
    5,
  ])("refuses %p", (v) => {
    expect(opTokenSourceError(v)).not.toBeNull();
  });

  it("readSecretsConfig refuses a bad value, naming the key and not echoing it", () => {
    userYml(`secrets:\n  onepassword:\n    token: ${TOKEN}\n`);
    let msg = "";
    try {
      readSecretsConfig();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/secrets\.onepassword\.token/);
    expect(msg).not.toContain(TOKEN);
  });

  it("reads a good value from user.yml, and ignores one in the distribution's config", () => {
    fs.writeFileSync(
      path.join(ROOT, "config", "den.yml"),
      "secrets:\n  onepassword:\n    token: env:FROM_TEAM\n",
    );
    expect(readSecretsConfig().onepassword?.token).toBeUndefined();
    userYml("secrets:\n  onepassword:\n    token: env:MINE\n");
    expect(readSecretsConfig().onepassword?.token).toBe("env:MINE");
    fs.writeFileSync(path.join(ROOT, "config", "den.yml"), "{}\n");
  });
});

describe("op's failure maps to a plain reason", () => {
  it.each([
    [
      "[ERROR] 2026/01/01 10:00:00 You are not signed in. Run `op signin`.",
      "no_token",
    ],
    ["[ERROR] no active session found for account", "no_token"],
    ["[ERROR] invalid service account token", "no_token"],
    [
      '[ERROR] 2026/01/01 10:00:00 "Ops" isn\'t a vault in this account. Specify the vault with its ID or name.',
      "no_access",
    ],
    ["[ERROR] You do not have access to this vault", "no_access"],
    [
      '[ERROR] 2026/01/01 10:00:00 "thing" isn\'t an item in the "Ops" vault.',
      "not_found",
    ],
    [
      '[ERROR] the item has no field with the label "nope": not found',
      "not_found",
    ],
    [
      "[ERROR] Too many requests. Rate limit exceeded; try again later",
      "rate_limited",
    ],
    ["[ERROR] something odd happened", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (stderr, code) => {
    expect(mapOpFailure(stderr).code).toBe(code);
  });

  it("gives words, and a short safe summary for the unknown case", () => {
    expect(mapOpFailure("not signed in").text).toMatch(
      /no service-account token or session/,
    );
    expect(mapOpFailure("isn't a vault in this account").text).toBe(
      "no access to the vault",
    );
    expect(mapOpFailure("isn't an item").text).toBe("item or field not found");
    expect(mapOpFailure("rate limit").text).toMatch(/rate limited/);
    const u = mapOpFailure(
      `[ERROR] 2026/01/01 10:00:00 weird ${TOKEN} op://v/i/f ${"x".repeat(300)}`,
      [TOKEN],
    );
    expect(u.text).toMatch(/^1Password failed: weird \[hidden\] \[ref\]/);
    expect(u.text).not.toContain(TOKEN);
    expect(u.text.length).toBeLessThan(140);
  });

  it("a failed resolve carries the reason", async () => {
    process.env.FAKE_OP_STDERR = '[ERROR] "x" isn\'t a vault in this account.';
    const r = await resolveWith(new OnePasswordProvider());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(
        "K (ref vault/item/field, provider 1password): not resolved: no access to the vault",
      );
      expect(r.missing[0].reason).toBe("no access to the vault");
    }
  });
});

describe("the token never leaks", () => {
  function scan(dir: string): string[] {
    const hits: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) hits.push(...scan(p));
      else if (fs.readFileSync(p, "utf-8").includes(TOKEN)) hits.push(p);
    }
    return hits;
  }

  it("is in no log, error, audit record, API response or doctor output", async () => {
    const out: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        out.push(a.map(String).join(" "));
      }),
    );
    userYml(
      "secrets:\n  provider: 1password\n  onepassword:\n    token: keychain:op-service-account\n",
    );
    const texts: string[] = [];
    try {
      const p = createSecretsProvider("1password", readSecretsConfig());
      // The config-built provider reads the real platform; on macOS this
      // resolves, elsewhere it fails with a reason. Both must be clean.
      const ok = await resolveSecretEnv({ K: REF }, p, "svc");
      texts.push(JSON.stringify(ok));
      // A hostile op that echoes the token on stderr.
      process.env.FAKE_OP_STDERR = `boom ${TOKEN}`;
      const bad = await resolveSecretEnv(
        { K: REF },
        new OnePasswordProvider({
          tokenSource: parseOpTokenSource("keychain:op-service-account"),
          tokenDeps: mac,
        }),
        "svc",
      );
      expect(bad.ok).toBe(false);
      texts.push(JSON.stringify(bad));
      delete process.env.FAKE_OP_STDERR;
      const good = await resolveWith(
        new OnePasswordProvider({
          tokenSource: parseOpTokenSource("keychain:op-service-account"),
          tokenDeps: mac,
        }),
      );
      expect(good.ok).toBe(true);
      texts.push(JSON.stringify(good));
      // The Settings API's value and doctor, with the keychain source set.
      texts.push(opTokenSourceSetting());
      const rows = doctorRows();
      texts.push(JSON.stringify(rows), formatDoctor(rows, "Den").join("\n"));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = [...texts, ...out].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(scan(ROOT)).toEqual([]);
  });
});

describe("doctor", () => {
  const row = () => doctorRows().find((r) => r.kind === "1password");

  it("shows the row when the source yields no token", () => {
    userYml("secrets:\n  provider: 1password\n");
    const r = row();
    expect(r).toMatchObject({
      available: false,
      problem: false,
      reason:
        "this process has no service-account token. Set secrets.onepassword.token.",
    });
    expect(formatDoctor(doctorRows(), "Den").join("\n")).toMatch(
      /1password .*this process has no service-account token\. Set secrets\.onepassword\.token\./,
    );
  });

  it("does not show it when the source yields one", () => {
    process.env.MY_OP_TOKEN = TOKEN;
    userYml(
      "secrets:\n  provider: 1password\n  onepassword:\n    token: env:MY_OP_TOKEN\n",
    );
    expect(row()).toBeUndefined();
    process.env.OP_SERVICE_ACCOUNT_TOKEN = TOKEN;
    userYml("secrets:\n  provider: 1password\n");
    expect(row()).toBeUndefined();
  });

  it("does not show it when 1Password is not the provider", () => {
    userYml("secrets:\n  provider: none\n");
    expect(row()).toBeUndefined();
  });

  it("a bad token key is a problem naming the key", () => {
    userYml(
      "secrets:\n  provider: 1password\n  onepassword:\n    token: nonsense\n",
    );
    const s = doctorRows().find((r) => r.kind === "secrets");
    expect(s?.problem).toBe(true);
    expect(s?.reason).toMatch(/secrets\.onepassword\.token/);
  });
});

describe("Settings", () => {
  it("shows the source, never the token", () => {
    expect(opTokenSourceSetting({})).toBe("not set");
    const of = (token: string) =>
      opTokenSourceSetting({ onepassword: { token } });
    expect(of("keychain:op-service-account")).toBe(
      "keychain: op-service-account",
    );
    expect(of("file:~/.config/op/token")).toBe("file: ~/.config/op/token");
    expect(of("env:OP_SERVICE_ACCOUNT_TOKEN")).toBe(
      "env: OP_SERVICE_ACCOUNT_TOKEN",
    );
    // A pasted token is not echoed.
    expect(of(TOKEN)).not.toContain(TOKEN);
  });
});
