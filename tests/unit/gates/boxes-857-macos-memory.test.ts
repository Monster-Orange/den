/**
 * Issue 857: a test box's memory check works on macOS. Over ssh, Den
 * reads the hold file and /proc/meminfo in one sftp session (Linux). A
 * macOS box has no /proc/meminfo: Den then reads free memory with one
 * ssh exec of a fixed command (vm_stat and sysctl hw.pagesize) and
 * nothing else. Output it can't read means "memory unknown": the box is
 * skipped with that reason, never counted as free. The process starter
 * is a scripted fake with real Linux and macOS output samples: nothing
 * reaches a real box.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  macFreeMb,
  memAvailableMb,
  sftpProbe,
  withMemory,
  type BoxProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { boxLines } from "../../../src/ui/cli/doctor-boxes.js";
import { boxStatusLines } from "../../../src/ui/cli/gate-command.js";

const LINUX_MEMINFO = `MemTotal:       16314748 kB
MemFree:         1203456 kB
MemAvailable:    8000000 kB
Buffers:          212344 kB
Cached:          6123456 kB
`;

const MAC_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            400000.
Pages inactive:                          200000.
Pages speculative:                        10000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                           5000.
"Translation faults":                 123456789.
Pages copy-on-write:                    1234567.
Pages zero filled:                     98765432.
Pages reactivated:                       123456.
Pages purged:                             12345.
File-backed pages:                       180000.
Anonymous pages:                         430000.
Pages stored in compressor:              200000.
Pages occupied by compressor:             60000.
Decompressions:                          100000.
Compressions:                            200000.
Pageins:                                 300000.
Pageouts:                                  1000.
Swapins:                                      0.
Swapouts:                                     0.
`;
/** (free + inactive + speculative) pages × 16384 bytes, in MB. */
const MAC_FREE_MB = ((3000 + 200000 + 10000) * 16384) / 1048576;

const NO_HOLD = 'Can\'t ls: "/Users/ci/heavy.hold" not found\n';
const NO_MEMINFO = 'File "/proc/meminfo" not found.\n';

type Answer = { out?: string; err?: string; code?: number };

/** A process starter that answers each command from a script. */
function scripted(answers: Record<string, Answer>) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const start = (cmd: string, args: string[]) => {
    const call = { cmd, args, stdin: "" };
    calls.push(call);
    const a = answers[cmd] ?? { code: 127, err: `${cmd}: not here\n` };
    const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    k.stdout = stdout;
    k.stderr = stderr;
    k.kill = () => true;
    k.stdin = {
      end: (s?: string) => {
        call.stdin = s ?? "";
        // Issue 1381: sftp gets /proc/meminfo into a file, as a real sftp.
        const dest = /^-get \/proc\/meminfo "([^"]+)"$/m.exec(call.stdin)?.[1];
        if (cmd === "sftp" && a.out && dest) fs.writeFileSync(dest, a.out);
        setImmediate(() => {
          if (a.out && !(cmd === "sftp" && dest))
            stdout.emit("data", Buffer.from(a.out));
          if (a.err) stderr.emit("data", Buffer.from(a.err));
          k.emit("close", a.code ?? 0);
        });
      },
    };
    return k;
  };
  return { start, calls };
}

const BOX: GateBox = {
  name: "box1",
  ssh: "ci@box1.test",
  browser_slots: 1,
  hold_file: "heavy.hold",
};

describe("reading free memory: Linux and macOS samples", () => {
  it("MemAvailable from /proc/meminfo (Linux)", () => {
    expect(memAvailableMb(LINUX_MEMINFO)).toBeCloseTo(8000000 / 1024);
  });

  it("free + inactive + speculative pages × the page size (macOS vm_stat + sysctl)", () => {
    expect(macFreeMb(MAC_VM_STAT + "16384\n")).toBeCloseTo(MAC_FREE_MB);
    // Without sysctl's line, the page size in vm_stat's header serves.
    expect(macFreeMb(MAC_VM_STAT)).toBeCloseTo(MAC_FREE_MB);
    // An Intel Mac's 4096-byte pages.
    expect(
      macFreeMb(MAC_VM_STAT.replace("16384 bytes", "4096 bytes") + "4096\n"),
    ).toBeCloseTo(MAC_FREE_MB / 4);
  });

  it("output it can't read is unknown, never free", () => {
    expect(macFreeMb("")).toBeUndefined();
    expect(macFreeMb("This account is restricted to sftp.\n")).toBeUndefined();
    expect(macFreeMb("Pages free: 12.\n")).toBeUndefined(); // no page size
    expect(memAvailableMb("MemFree: 100 kB\n")).toBeUndefined();
  });
});

describe("the box check over ssh", () => {
  it("Linux: one sftp session, no command run; open with its free memory", async () => {
    const f = scripted({ sftp: { out: LINUX_MEMINFO, err: NO_HOLD } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("open");
    expect(r.freeMemMb).toBeCloseTo(8000000 / 1024);
    expect(f.calls.map((c) => c.cmd)).toEqual(["sftp"]);
  });

  it("macOS: no /proc/meminfo, so one ssh exec of vm_stat and sysctl only; open with its free memory", async () => {
    const f = scripted({
      sftp: { err: NO_HOLD + NO_MEMINFO },
      ssh: { out: MAC_VM_STAT + "16384\n" },
    });
    const r = await sftpProbe(f.start as never)(
      { ...BOX, ssh_port: 2222, ssh_identity: "/k/id" },
      2000,
    );
    expect(r.state).toBe("open");
    expect(r.freeMemMb).toBeCloseTo(MAC_FREE_MB);
    expect(f.calls.map((c) => c.cmd)).toEqual(["sftp", "ssh"]);
    const ssh = f.calls[1]!.args;
    expect(ssh).toEqual(
      expect.arrayContaining([
        "-o",
        "BatchMode=yes",
        "-p",
        "2222",
        "-i",
        "/k/id",
      ]),
    );
    // The command is fixed, the last argument, after the destination.
    expect(ssh.slice(-3)).toEqual([
      "--",
      "ci@box1.test",
      "/usr/bin/vm_stat && /usr/sbin/sysctl -n hw.pagesize",
    ]);
  });

  it("macOS: a box with less free memory than its floor is low, like a Linux box", async () => {
    const f = scripted({
      sftp: { err: NO_HOLD + NO_MEMINFO },
      ssh: { out: MAC_VM_STAT + "16384\n" },
    });
    const box = { ...BOX, min_free_mem_mb: 4096 };
    const r = withMemory(box, await sftpProbe(f.start as never)(box, 2000));
    expect(r.state).toBe("low");
    expect(r.reason).toMatch(/3328 MB free, needs 4096 MB/);
  });

  it("macOS: its hold file there is held, even though /proc/meminfo is missing; nothing more is run", async () => {
    const f = scripted({ sftp: { err: NO_MEMINFO } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("held");
    expect(f.calls.map((c) => c.cmd)).toEqual(["sftp"]);
  });

  it("output it can't read: memory unknown, skipped with the reason, never open", async () => {
    for (const ssh of [
      { out: "This account is restricted to sftp.\n" },
      { code: 1, err: "command not allowed\n" },
    ]) {
      const f = scripted({ sftp: { err: NO_HOLD + NO_MEMINFO }, ssh });
      const r = await sftpProbe(f.start as never)(BOX, 2000);
      expect(r.state).toBe("unknown");
      expect(r.reason).toMatch(/memory unknown/);
      expect(r.freeMemMb).toBeUndefined();
    }
    // Linux text without MemAvailable is unknown too.
    const f = scripted({ sftp: { out: "MemFree: 100 kB\n", err: NO_HOLD } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("unknown");
  });

  it("a box that keeps no free memory (min_free_mem_mb 0) needs no reading", async () => {
    const f = scripted({ sftp: { err: NO_HOLD + NO_MEMINFO } });
    const r = await sftpProbe(f.start as never)(
      { ...BOX, min_free_mem_mb: 0 },
      2000,
    );
    expect(r.state).toBe("open");
    expect(f.calls.map((c) => c.cmd)).toEqual(["sftp"]);
  });
});

describe("a box whose memory is unknown, in the queue", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it("gets no slot; gate status, the queue and doctor say memory unknown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-857-"));
    tmps.push(dir);
    const probe: BoxProbe = () =>
      Promise.resolve({
        state: "unknown",
        reason: "memory unknown: vm_stat gave nothing Den can read",
      });
    const store = new GateStore({ dir, alive: () => true, probe });
    store.setBox(BOX);
    const a = store.ask({
      kind: "browser",
      who: "t",
      label: "e2e",
      pid: 1,
      estimateMin: 5,
      where: "box1",
    });
    await store.checkBoxes();
    expect(store.get(a.id)?.grantedAt).toBeUndefined();
    expect(gateView(store).boxes[0]).toMatchObject({ state: "unknown" });
    expect(boxStatusLines(store, store.list()).join("\n")).toMatch(
      /box box1: skipped, unknown: memory unknown/,
    );
    const d = boxLines(store);
    expect(d.check.status).toBe("warn");
    expect(d.lines.join("\n")).toMatch(/⚠ {2}box1 .*memory unknown/);
  });
});
