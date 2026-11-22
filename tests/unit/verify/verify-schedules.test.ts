/**
 * Issue 214 (T18, pure part): schedules from modules, the plan behind a
 * schedule, its standing Allow and when it may run.
 *   - A schedule on a shared environment runs only with a standing Allow.
 *   - Changing its plan lapses the Allow.
 *   - The Allow expires after verify.schedule.allow_expiry (30 days).
 *   - A local or code-only schedule runs without one.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { VerifyModule } from "../../../src/shared/verify/config.js";
import {
  cmdFiles,
  listSchedules,
  planHash,
  readScheduleSettings,
  readAllows,
  writeAllow,
  removeAllow,
  scheduleState,
  mayRun,
  SCHEDULE_DEFAULTS,
  productionLimit,
  shortestGapMs,
  metadataHost,
} from "../../../src/shared/verify/schedules.js";

// A repo with the script the scheduled commands run (Den follows only a
// command whose files it can find).
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-repo-"));
fs.mkdirSync(path.join(REPO, "scripts"));
fs.writeFileSync(path.join(REPO, "scripts/speed.sh"), "echo ok\n");
const ON = { ...SCHEDULE_DEFAULTS, sharedCommands: true };
const DAY = 86_400_000;

function mod(name: string, over: Partial<VerifyModule> = {}): VerifyModule {
  const layer = name.split("/")[0];
  return {
    id: `shop:${name}`,
    repo: "shop",
    repoPath: REPO,
    name,
    layer,
    kind: "performance",
    adapter: "cmd",
    mark: "declared-read-only",
    environments: ["staging"],
    cmd: "./scripts/speed.sh",
    writes: false,
    healthUrls: {},
    ...over,
  };
}

const speed = mod("web/speed", {
  schedule: {
    cron: "0 2 * * *",
    window: "01:00-05:00",
    name: "Nightly speed",
    env: "staging",
  },
});
const devices = mod("web/devices", {
  schedule: {
    cron: "0 22 * * 2,5",
    window: "20:00-06:00",
    name: "Devices",
    env: "staging",
  },
});
const checkout = mod("web/checkout", {
  schedule: {
    cron: "0 22 * * 2,5",
    window: "20:00-06:00",
    name: "Devices",
    env: "staging",
  },
});
const deps = mod("code/deps", {
  kind: "security",
  adapter: "trivy",
  mark: "reads-code-only",
  environments: "all",
  cmd: undefined,
  schedule: { cron: "0 3 * * 1", env: "local" },
});

describe("listSchedules", () => {
  it("one schedule per environment, cron, window and name, with its modules", () => {
    const s = listSchedules("shop", [
      speed,
      devices,
      checkout,
      deps,
      mod("web/smoke"),
    ]);
    expect(
      s.map((x) => [x.name ?? null, x.env, x.modules.map((m) => m.name)]),
    ).toEqual([
      [null, "local", ["code/deps"]],
      ["Devices", "staging", ["web/checkout", "web/devices"]],
      ["Nightly speed", "staging", ["web/speed"]],
    ]);
    const dev = s[1];
    expect(dev.id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(dev.shared).toBe(true);
    expect(dev.needsAllow).toBe(true);
    // A scan of the code, and anything on local: no Allow.
    expect(s[0].needsAllow).toBe(false);
    expect(s[0].codeOnly).toBe(true);
  });

  it("the id stays the same when the plan changes", () => {
    const a = listSchedules("shop", [devices])[0];
    const b = listSchedules("shop", [devices, checkout])[0];
    expect(a.id).toBe(b.id);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("planHash", () => {
  it("changes with a module, its command, its writes or the window", () => {
    const base = listSchedules("shop", [devices])[0].hash;
    expect(
      planHash({
        env: "staging",
        cron: "0 22 * * 2,5",
        window: "20:00-06:00",
        modules: [devices],
      }),
    ).toBe(base);
    const changed = [
      [mod("web/devices", { ...devices, cmd: "make devices --all" })],
      [mod("web/devices", { ...devices, writes: true })],
      [devices, checkout],
    ];
    for (const modules of changed)
      expect(
        planHash({
          env: "staging",
          cron: "0 22 * * 2,5",
          window: "20:00-06:00",
          modules,
        }),
      ).not.toBe(base);
    expect(
      planHash({
        env: "staging",
        cron: "0 22 * * 2,5",
        window: "21:00-06:00",
        modules: [devices],
      }),
    ).not.toBe(base);
  });
});

describe("schedule Allow scope", () => {
  const sched = {
    cron: "*/5 * * * *",
    name: "Scan",
    env: "staging",
  };
  it("a code-layer module that runs a command is not code-only: on a shared environment it needs the Allow", () => {
    const s = listSchedules("shop", [
      mod("code/scan", {
        layer: "code",
        mark: "reads-code-only",
        environments: "all",
        cmd: "make scan",
        schedule: sched,
      }),
    ])[0];
    expect(s.codeOnly).toBe(false);
    expect(s.needsAllow).toBe(true);
  });

  it("a code-layer module with no command (a built-in scan) stays code-only, with no Allow", () => {
    const s = listSchedules("shop", [
      mod("code/scan", {
        layer: "code",
        mark: "reads-code-only",
        environments: "all",
        cmd: undefined,
        adapter: "semgrep",
        schedule: sched,
      }),
    ])[0];
    expect(s.codeOnly).toBe(true);
    expect(s.needsAllow).toBe(false);
  });

  const smoke = (over: Partial<VerifyModule> = {}) =>
    mod("web/smoke", {
      adapter: "smoke",
      mark: "enforced",
      cmd: undefined,
      environments: ["production"],
      healthUrls: { production: ["https://shop.example/health"] },
      schedule: { cron: "0 * * * *", env: "production" },
      ...over,
    });
  const hashOf = (
    m: VerifyModule,
    inputs?: Parameters<typeof planHash>[0]["inputs"],
  ) =>
    planHash({
      env: "production",
      cron: "0 * * * *",
      modules: [m],
      ...(inputs ? { inputs } : {}),
    });

  it("the fingerprint covers the health URL, the repo, the results file and the layer", () => {
    const base = hashOf(smoke());
    for (const m of [
      smoke({ healthUrls: { production: ["http://169.254.169.254/latest"] } }),
      smoke({ repoPath: "/tmp/other" }),
      smoke({ repo: "other" }),
      smoke({ results: "out/results.json" }),
      smoke({ layer: "api" }),
    ])
      expect(hashOf(m)).not.toBe(base);
  });

  it("the fingerprint covers the environment's method rule", () => {
    const m = smoke();
    const ro = hashOf(m, {
      rules: () => ({ methods: ["GET", "HEAD", "OPTIONS"], writeAllow: [] }),
    });
    const w = hashOf(m, {
      rules: () => ({
        methods: ["GET", "HEAD", "OPTIONS"],
        writeAllow: [{ method: "POST", path: "/login" }],
      }),
    });
    expect(ro).not.toBe(w);
  });

  it("the fingerprint covers the bytes of the files a command names", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-files-"));
    try {
      fs.mkdirSync(path.join(repo, "scripts"));
      fs.writeFileSync(path.join(repo, "scripts/speed.sh"), "echo ok\n");
      fs.writeFileSync(
        path.join(repo, "Makefile"),
        "speed:\n\t./scripts/speed.sh\n",
      );
      const m = mod("web/speed", {
        repoPath: repo,
        cmd: "make speed && ./scripts/speed.sh --quick",
      });
      const inputs = {
        files: (x: VerifyModule) => cmdFiles(x.repoPath, x.cmd!),
      };
      const files = cmdFiles(repo, m.cmd!);
      expect(Object.keys(files).sort()).toEqual([
        "./scripts/speed.sh",
        "GNUmakefile",
        "Makefile",
        "makefile",
      ]);
      expect(files.GNUmakefile).toBeNull();
      const before = planHash({
        env: "staging",
        cron: "0 2 * * *",
        modules: [m],
        inputs,
      });
      fs.writeFileSync(
        path.join(repo, "scripts/speed.sh"),
        "curl -X DELETE https://shop.example/\n",
      );
      const after = planHash({
        env: "staging",
        cron: "0 2 * * *",
        modules: [m],
        inputs,
      });
      expect(after).not.toBe(before);
      fs.writeFileSync(
        path.join(repo, "Makefile"),
        "speed:\n\trm -rf /tmp/x\n",
      );
      expect(
        planHash({ env: "staging", cron: "0 2 * * *", modules: [m], inputs }),
      ).not.toBe(after);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a path a command names outside the repo is kept by name, never read", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-out-"));
    try {
      expect(cmdFiles(repo, "sh ../../etc/x.sh")).toEqual({
        "../../etc/x.sh": "outside",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("settings", () => {
  it("30 and 3 days by default; days as a number or with d or h", () => {
    expect(readScheduleSettings(undefined)).toEqual(SCHEDULE_DEFAULTS);
    expect(SCHEDULE_DEFAULTS).toEqual({
      allowExpiryMs: 30 * DAY,
      expiryWarningMs: 3 * DAY,
      sharedCommands: false,
      production: { enabled: false, minIntervalMs: 15 * 60_000, hosts: null },
    });
    expect(
      readScheduleSettings({
        schedule: {
          production: {
            enabled: true,
            min_interval: "1h",
            hosts: ["Shop.Example.com"],
          },
        },
      }).production,
    ).toEqual({
      enabled: true,
      minIntervalMs: 3_600_000,
      hosts: ["shop.example.com"],
    });
    expect(() =>
      readScheduleSettings({ schedule: { production: { enabled: "yes" } } }),
    ).toThrow(/verify\.schedule\.production\.enabled/);
    expect(() =>
      readScheduleSettings({ schedule: { production: { hosts: "x" } } }),
    ).toThrow(/verify\.schedule\.production\.hosts/);
    expect(() =>
      readScheduleSettings({
        schedule: { production: { min_interval: "soon" } },
      }),
    ).toThrow(/verify\.schedule\.production\.min_interval/);
    expect(
      readScheduleSettings({ schedule: { shared_commands: true } })
        .sharedCommands,
    ).toBe(true);
    expect(() =>
      readScheduleSettings({ schedule: { shared_commands: "yes" } }),
    ).toThrow(/verify\.schedule\.shared_commands/);
    expect(
      readScheduleSettings({
        schedule: { allow_expiry: 7, expiry_warning: "12h" },
      }),
    ).toEqual({
      allowExpiryMs: 7 * DAY,
      expiryWarningMs: 12 * 3_600_000,
      sharedCommands: false,
      production: SCHEDULE_DEFAULTS.production,
    });
    expect(() =>
      readScheduleSettings({ schedule: { allow_expiry: "soon" } }),
    ).toThrow(/verify\.schedule\.allow_expiry/);
    expect(() =>
      readScheduleSettings({ schedule: { allow_expiry: 0 } }),
    ).toThrow(/verify\.schedule\.allow_expiry/);
  });
});

describe("the standing Allow (T18)", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-"));

  it("is stored per project, survives a read, and can be removed", () => {
    const dir = tmp();
    const s = listSchedules("shop", [devices])[0];
    const a = writeAllow(
      dir,
      "shop",
      s,
      { kind: "person", name: "ward" },
      now,
      ON,
    );
    expect(a).toMatchObject({
      schedule: s.id,
      hash: s.hash,
      by: { kind: "person", name: "ward" },
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
      modules: [
        { id: "shop:web/devices", writes: false, cmd: "./scripts/speed.sh" },
      ],
    });
    expect(readAllows(dir, "shop")[s.id]).toEqual(a);
    expect(
      fs.statSync(path.join(dir, "verify", "shop", "schedule-allows.json"))
        .mode & 0o077,
    ).toBe(0);
    removeAllow(dir, "shop", s.id);
    expect(readAllows(dir, "shop")[s.id]).toBeUndefined();
  });

  it("a shared schedule runs only with an Allow; a plan change lapses it; it expires", () => {
    const dir = tmp();
    const s = listSchedules("shop", [devices])[0];
    expect(scheduleState(s, undefined, now, ON)).toBe("needs-allow");
    expect(mayRun(s, undefined, now, ON)).toBe(false);

    const a = writeAllow(
      dir,
      "shop",
      s,
      { kind: "person", name: "ward" },
      now,
      ON,
    );
    expect(scheduleState(s, a, now, ON)).toBe("allowed");
    expect(mayRun(s, a, now, ON)).toBe(true);

    // Three days before it expires, the bell warns; it still runs.
    const late = new Date(now.getTime() + 27 * DAY + 1);
    expect(scheduleState(s, a, late, ON)).toBe("expiring");
    expect(mayRun(s, a, late, ON)).toBe(true);

    const gone = new Date(now.getTime() + 30 * DAY);
    expect(scheduleState(s, a, gone, ON)).toBe("expired");
    expect(mayRun(s, a, gone, ON)).toBe(false);

    // The plan changed: a module joined.
    const next = listSchedules("shop", [devices, checkout])[0];
    expect(scheduleState(next, a, now, ON)).toBe("plan-changed");
    expect(mayRun(next, a, now, ON)).toBe(false);
  });

  it("a local or code-only schedule runs without one", () => {
    const local = listSchedules("shop", [
      mod("web/speed", {
        environments: ["local"],
        schedule: { cron: "0 2 * * *", env: "local" },
      }),
    ])[0];
    const code = listSchedules("shop", [deps])[0];
    for (const s of [local, code]) {
      expect(s.needsAllow).toBe(false);
      expect(scheduleState(s, undefined, now, ON)).toBe("no-allow-needed");
      expect(mayRun(s, undefined, now, ON)).toBe(true);
    }
  });

  it("an unreadable file means no Allows, never a crash", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "verify", "shop"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "verify", "shop", "schedule-allows.json"),
      "{not json",
    );
    expect(readAllows(dir, "shop")).toEqual({});
  });
});

describe("issue 964: production schedules", () => {
  const prod = (cron: string, urls: string[]) =>
    listSchedules("shop", [
      mod("web/smoke", {
        environments: ["production"],
        kind: "smoke",
        adapter: "smoke",
        cmd: undefined,
        healthUrls: { production: urls },
        schedule: { cron, env: "production" },
      } as any),
    ])[0];
  const on = (p: object = {}) => ({
    ...SCHEDULE_DEFAULTS,
    production: { ...SCHEDULE_DEFAULTS.production, enabled: true, ...p },
  });
  const ok = ["https://shop.example.com/health"];

  it("off until the org opts in", () => {
    expect(productionLimit(prod("0 * * * *", ok), SCHEDULE_DEFAULTS)).toEqual({
      reason: "production-off",
    });
    expect(
      mayRun(prod("0 * * * *", ok), undefined, new Date(), SCHEDULE_DEFAULTS),
    ).toBe(false);
    expect(productionLimit(prod("0 * * * *", ok), on())).toBeNull();
  });

  it("no more often than min_interval (15 minutes by default)", () => {
    expect(shortestGapMs("*/5 * * * *")).toBe(5 * 60_000);
    expect(shortestGapMs("0 2 * * 1,2")).toBe(DAY);
    expect(productionLimit(prod("* * * * *", ok), on())).toEqual({
      reason: "too-often",
    });
    expect(productionLimit(prod("*/15 * * * *", ok), on())).toBeNull();
    expect(
      productionLimit(
        prod("0 * * * *", ok),
        on({ minIntervalMs: 2 * 3_600_000 }),
      ),
    ).toEqual({
      reason: "too-often",
    });
  });

  it("never a metadata address; only listed hosts when there is a list", () => {
    expect(metadataHost("169.254.169.254")).toBe(true);
    expect(metadataHost("[fe80::1]")).toBe(true);
    expect(metadataHost("metadata.google.internal")).toBe(true);
    expect(metadataHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(metadataHost("metadata.google.internal.")).toBe(true);
    expect(metadataHost("shop.example.com")).toBe(false);
    expect(
      productionLimit(
        prod("0 * * * *", ["http://169.254.169.254/latest/"]),
        on(),
      ),
    ).toEqual({
      reason: "host",
      hosts: ["169.254.169.254"],
    });
    const listed = on({ hosts: ["shop.example.com"] });
    expect(productionLimit(prod("0 * * * *", ok), listed)).toBeNull();
    expect(
      productionLimit(prod("0 * * * *", ["https://other.example/x"]), listed),
    ).toEqual({
      reason: "host",
      hosts: ["other.example"],
    });
  });

  it("other environments: no production limit", () => {
    const st = listSchedules("shop", [speed])[0];
    expect(productionLimit(st, SCHEDULE_DEFAULTS)).toBeNull();
  });
});
