/**
 * Issue 921, box side, slice B: starting a box runner over ssh, keeping
 * its status, and the box check reading the job marks. The process
 * starter is a scripted fake: nothing reaches a real box. Invented repo
 * and box names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  dockerPsArgs,
  listBoxRunners,
  liveRunnerIds,
  marksDirOf,
  startBoxRunner,
  type BoxRunnerSpec,
  type RunnerStatus,
} from "../../../src/shared/gates/box-runners.js";
import { sftpProbe, type GateBox } from "../../../src/shared/gates/boxes.js";

const TOKEN = "AAAQ-secret-token-921";

const spec = (o: Partial<BoxRunnerSpec> = {}): BoxRunnerSpec => ({
  project: "south",
  box: "box1",
  repo: "acme/app",
  labels: ["self-hosted", "linux"],
  cpus: 4,
  cpuset: "0-3",
  memoryMb: 8192,
  slot: { id: "cpu-abc123", kind: "cpu" },
  ...o,
});

const BOX: GateBox = {
  name: "box1",
  ssh: "ci@box1.test",
  browser_slots: 1,
  hold_file: "heavy.hold",
};

/** `mem`: what sftp's `-get /proc/meminfo "<local>"` writes there (issue 1381). */
type Answer = {
  out?: string;
  err?: string;
  code?: number;
  hold?: boolean;
  mem?: string;
};
type Call = { cmd: string; args: string[]; stdin: string; close: () => void };

/** A process starter: each call answers in turn (the last one repeats). */
function scripted(answers: Answer[]) {
  const calls: Call[] = [];
  const start = (cmd: string, args: string[]) => {
    const a = answers[Math.min(calls.length, answers.length - 1)] ?? {};
    const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const close = () => {
      if (a.out) stdout.emit("data", Buffer.from(a.out));
      if (a.err) stderr.emit("data", Buffer.from(a.err));
      k.emit("close", a.code ?? 0);
    };
    const call: Call = { cmd, args, stdin: "", close };
    calls.push(call);
    k.stdout = stdout;
    k.stderr = stderr;
    k.kill = () => true;
    k.stdin = {
      end: (s?: string) => {
        call.stdin = s ?? "";
        const get = /^-get \/proc\/meminfo "([^"]+)"$/m.exec(call.stdin);
        if (get && a.mem !== undefined) fs.writeFileSync(get[1]!, a.mem);
        // hold: the runner keeps going until the test closes it.
        if (!a.hold) setImmediate(close);
      },
    };
    return k;
  };
  return { start, calls };
}

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-921b-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const files = (d: string) =>
  fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf-8"));

const deps = (start: unknown, stateDir: string, n = 0) => ({
  start: start as never,
  stateDir,
  image: "ghcr.io/acme/runner:2.320.0",
  newId: () => `r${++n}`,
  now: () => new Date("2026-11-23T10:00:00Z"),
});

const token = (o: Partial<{ value: string; expiresAt: string }> = {}) => ({
  value: TOKEN,
  expiresAt: "2026-11-23T11:00:00Z",
  ...o,
});

describe("startBoxRunner: one runner per job, the token on stdin only", () => {
  it("refuses a bad spec, a box without ssh, or a token that won't do, and starts nothing", () => {
    const f = scripted([{}]);
    const d = tmp();
    const bad: [unknown, unknown, unknown][] = [
      [BOX, spec({ cpus: 0 }), token()],
      [{ ...BOX, ssh: undefined }, spec(), token()],
      [BOX, spec(), token({ value: "" })],
      [BOX, spec(), token({ value: "a\nb" })],
      [BOX, spec(), token({ expiresAt: "2026-11-23T09:59:00Z" })],
      [BOX, spec({ box: "box2" }), token()],
    ];
    for (const [b, s, t] of bad) {
      const r = startBoxRunner(
        b as never,
        s as never,
        t as never,
        deps(f.start, d),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain(TOKEN);
    }
    expect(f.calls).toHaveLength(0);
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it("starts one ssh process: docker run --rm -i on the box, the token only on its stdin", () => {
    const f = scripted([{ hold: true }]);
    const d = tmp();
    const r = startBoxRunner(BOX, spec(), token(), deps(f.start, d));
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.cmd).toBe("ssh");
    expect(c.args).toEqual(
      expect.arrayContaining([
        "-T",
        "-o",
        "BatchMode=yes",
        "--",
        "ci@box1.test",
      ]),
    );
    const line = c.args[c.args.length - 1]!;
    expect(line).toMatch(/docker' 'run' '--rm' '-i'/);
    expect(line).toMatch(/'--cpus' '4' '--cpuset-cpus' '0-3'/);
    expect(line).toContain('"$D:/den-hold"');
    expect(line).toContain("mkdir -p -- 'heavy.hold.jobs'");
    expect(line).not.toMatch(/docker update/);
    expect(c.args.join(" ")).not.toContain(TOKEN);
    expect(c.stdin).toBe(`${TOKEN}\n`);
  });

  it("the line it runs is valid shell", () => {
    const f = scripted([{ hold: true }]);
    startBoxRunner(
      BOX,
      spec({ project: "it's" }),
      token(),
      deps(f.start, tmp()),
    );
    const line = f.calls[0]!.args.at(-1)!;
    expect(() =>
      execFileSync("sh", ["-n", "-c", line], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("records the runner as starting, with no token in its status file", () => {
    const f = scripted([{ hold: true }]);
    const d = tmp();
    const r = startBoxRunner(BOX, spec(), token(), deps(f.start, d));
    if (!r.ok) throw new Error(r.error);
    expect(r.runner).toMatchObject({
      id: "r1",
      project: "south",
      repo: "acme/app",
      box: "box1",
      cpus: 4,
      cpuset: "0-3",
      memoryMb: 8192,
      state: "starting",
      hold: false,
      startedAt: "2026-11-23T10:00:00.000Z",
    });
    expect(listBoxRunners("south", { stateDir: d })).toEqual([r.runner]);
    for (const t of files(d)) expect(t).not.toContain(TOKEN);
  });

  it("when the job's runner exits: done, and its own mark is removed (in case the hook never ran)", async () => {
    const f = scripted([{ hold: true }, {}]);
    const d = tmp();
    const r = startBoxRunner(BOX, spec(), token(), deps(f.start, d));
    if (!r.ok) throw new Error(r.error);
    f.calls[0]!.close();
    const end = await r.done;
    expect(end).toMatchObject({ id: "r1", state: "done", hold: false });
    expect(end.endedAt).toBe("2026-11-23T10:00:00.000Z");
    expect(f.calls).toHaveLength(2);
    const rm = f.calls[1]!;
    expect(rm.cmd).toBe("ssh");
    expect(rm.args.at(-1)).toBe("rm -f -- 'heavy.hold.jobs/r1'");
    expect(rm.stdin).toBe("");
    expect(listBoxRunners("south", { stateDir: d })[0]!.state).toBe("done");
  });

  it("a runner that fails: failed with ssh's last line, never the token", async () => {
    const f = scripted([
      { code: 1, err: `config.sh: bad token ${TOKEN}\nhttp 404 from github\n` },
      {},
    ]);
    const d = tmp();
    const r = startBoxRunner(BOX, spec(), token(), deps(f.start, d));
    if (!r.ok) throw new Error(r.error);
    const end = await r.done;
    expect(end.state).toBe("failed");
    expect(end.error).toContain("http 404 from github");
    expect(f.calls[1]!.args.at(-1)).toBe("rm -f -- 'heavy.hold.jobs/r1'");
    for (const t of files(d)) expect(t).not.toContain(TOKEN);
  });

  it("a token in ssh's last line is blanked", async () => {
    const f = scripted([{ code: 1, err: `denied: ${TOKEN}\n` }, {}]);
    const r = startBoxRunner(BOX, spec(), token(), deps(f.start, tmp()));
    if (!r.ok) throw new Error(r.error);
    const end = await r.done;
    expect(end.error).not.toContain(TOKEN);
    expect(end.error).toContain("denied");
  });

  it("two jobs get two runners, each removing only its own mark", async () => {
    const f = scripted([{ hold: true }, { hold: true }, {}]);
    const d = tmp();
    const dp = deps(f.start, d);
    const a = startBoxRunner(BOX, spec(), token(), dp);
    const b = startBoxRunner(BOX, spec(), token(), dp);
    if (!a.ok || !b.ok) throw new Error("not started");
    expect(a.runner.id).not.toBe(b.runner.id);
    f.calls[1]!.close();
    await b.done;
    expect(
      f.calls.map((c) => c.args.at(-1)).filter((l) => l?.startsWith("rm")),
    ).toEqual(["rm -f -- 'heavy.hold.jobs/r2'"]);
    f.calls[0]!.close();
    await a.done;
    expect(
      listBoxRunners(undefined, { stateDir: d })
        .map((s) => s.state)
        .sort(),
    ).toEqual(["done", "done"]);
  });
});

describe("listBoxRunners", () => {
  const put = (d: string, s: Partial<RunnerStatus>) =>
    fs.writeFileSync(
      path.join(d, `${s.id}.json`),
      JSON.stringify({
        project: "south",
        repo: "acme/app",
        box: "box1",
        cpus: 2,
        memoryMb: 1024,
        startedAt: "2026-11-23T09:00:00.000Z",
        state: "running",
        hold: true,
        ...s,
      }),
    );

  it("lists one project's runners, and nothing for a folder that isn't there", () => {
    const d = tmp();
    put(d, { id: "ra" });
    put(d, { id: "rb", project: "north" });
    fs.writeFileSync(path.join(d, "junk.json"), "{not json");
    expect(listBoxRunners("south", { stateDir: d }).map((s) => s.id)).toEqual([
      "ra",
    ]);
    expect(listBoxRunners(undefined, { stateDir: d })).toHaveLength(2);
    expect(listBoxRunners("south", { stateDir: path.join(d, "none") })).toEqual(
      [],
    );
  });

  it("a running runner whose container is gone is failed; a fresh one is left alone", () => {
    const d = tmp();
    put(d, { id: "ra" });
    put(d, {
      id: "rb",
      startedAt: "2026-11-23T09:59:50.000Z",
      state: "starting",
    });
    put(d, { id: "rc" });
    put(d, { id: "rd", state: "done", hold: false });
    const got = listBoxRunners("south", {
      stateDir: d,
      live: new Set(["rc"]),
      now: () => new Date("2026-11-23T10:00:00Z"),
    });
    const by = Object.fromEntries(got.map((s) => [s.id, s]));
    expect(by.ra).toMatchObject({ state: "failed", hold: false });
    expect(by.ra!.error).toMatch(/container is gone/);
    expect(by.rb!.state).toBe("starting");
    expect(by.rc!.state).toBe("running");
    expect(by.rd!.state).toBe("done");
  });

  it("docker ps: Den's box runners only, by their label", () => {
    expect(dockerPsArgs()).toEqual([
      "docker",
      "ps",
      "--filter",
      "label=den.box-runner",
      "--format",
      '{{.Label "den.box-runner"}}',
    ]);
    expect([...liveRunnerIds("r1\n\nr2\n not an id\n")]).toEqual(["r1", "r2"]);
  });
});

describe("the box check reads the job marks", () => {
  const NO_HOLD = 'Can\'t ls: "/home/ci/heavy.hold" not found\n';
  const NO_MARKS = 'Can\'t ls: "/home/ci/heavy.hold.jobs" not found\n';
  const MEM = "MemAvailable:    8000000 kB\n";
  const probe = (a: Answer) =>
    sftpProbe(scripted([a]).start as never)(BOX, 2000);

  it("the marks folder sits next to the hold file", () => {
    expect(marksDirOf(BOX)).toBe("heavy.hold.jobs");
    expect(marksDirOf({ ...BOX, hold_file: undefined })).toBe("den-hold.jobs");
  });

  it("lists the marks folder in the same sftp session", async () => {
    const f = scripted([{ mem: MEM, err: NO_HOLD + NO_MARKS }]);
    await sftpProbe(f.start as never)(BOX, 2000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.stdin).toContain('-ls -1 "heavy.hold.jobs"');
  });

  it("held while a job's mark is there", async () => {
    for (const out of ["heavy.hold.jobs/r7\n", "r7\n"]) {
      const r = await probe({ out, mem: MEM, err: NO_HOLD });
      expect(r.state).toBe("held");
      expect(r.reason).toMatch(/a CI job is running/);
    }
  });

  it("open with no marks, or no marks folder; the hold file still holds", async () => {
    expect((await probe({ mem: MEM, err: NO_HOLD })).state).toBe("open");
    expect((await probe({ mem: MEM, err: NO_HOLD + NO_MARKS })).state).toBe(
      "open",
    );
    // The marks folder missing must not read as the hold file missing.
    const r = await probe({ mem: MEM, err: NO_MARKS });
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/hold file/);
  });
});
