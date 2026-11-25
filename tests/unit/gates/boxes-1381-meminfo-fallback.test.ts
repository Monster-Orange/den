/**
 * Issue 1381: a box's memory check says why it can't read the memory, and
 * reads what it can.
 *
 * - A Linux /proc/meminfo with no MemAvailable (old kernels, some WSL
 *   kernels) is read as MemFree + Buffers + Cached.
 * - When sftp can't write its local copy, it prints `open local …` and
 *   still exits 0. The box is "memory unknown" with sftp's own error,
 *   never "no MemAvailable". That line never counts as "the hold file is
 *   gone": a box whose hold file is there stays held.
 * - An empty copy is "came back empty".
 *
 * The process starter is a scripted fake with captured text: nothing
 * reaches a real box.
 */
import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import * as fs from "fs";
import {
  linuxFreeMb,
  macFreeMb,
  sftpProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";

/** A 2.6-era kernel: no MemAvailable. */
const OLD_KERNEL_MEMINFO = `MemTotal:        8058452 kB
MemFree:          912340 kB
Buffers:          204800 kB
Cached:          3072000 kB
SwapCached:            0 kB
Active:          4123456 kB
Inactive:        2345678 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
`;
const OLD_KERNEL_MB = (912340 + 204800 + 3072000) / 1024;

/** A WSL /proc/meminfo with no MemAvailable. */
const WSL_MEMINFO = `MemTotal:       16651220 kB
MemFree:         9876544 kB
Buffers:           34032 kB
Cached:          1250000 kB
SwapCached:            0 kB
Active:          2468024 kB
Inactive:        1234012 kB
HighTotal:             0 kB
HighFree:              0 kB
LowTotal:       16651220 kB
LowFree:         9876544 kB
SwapTotal:      50331648 kB
SwapFree:       50331648 kB
`;
const WSL_MB = (9876544 + 34032 + 1250000) / 1024;

/** A current kernel: MemAvailable wins over the sum. */
const LINUX_MEMINFO = `MemTotal:       25639900 kB
MemFree:        23193240 kB
MemAvailable:   24135428 kB
Buffers:          121972 kB
Cached:          1080536 kB
`;

/** vm_stat as captured on an Apple silicon Mac, then sysctl hw.pagesize. */
const MAC_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   740825.
Pages active:                                3222551.
Pages inactive:                              3196859.
Pages speculative:                             23821.
Pages throttled:                                   0.
Pages wired down:                             470197.
Pages purgeable:                                4486.
16384
`;

// Issue 1597: the check lists the hold file's folder ("." for the home).
// No hold: that listing works and doesn't name it (sftp prints no error).
const NO_HOLD = "";
/** The hold file there: the listing names it. */
const HOLD_THERE = "./heavy.hold\n";
const NO_MEMINFO = 'File "/proc/meminfo" not found.\n';
const openLocal = (p: string) =>
  `open local "${p}": No such file or directory\n`;

type Answer = {
  /** What sftp writes to the -get file ("" writes an empty file). */
  file?: string;
  /** Text on stdout (ssh). */
  out?: string;
  /** Text on stderr; "{dest}" becomes the -get file's path. */
  err?: string;
  code?: number;
};

function scripted(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const start = (cmd: string) => {
    calls.push(cmd);
    const a = answers[cmd] ?? { code: 127, err: `${cmd}: not here\n` };
    const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    k.stdout = stdout;
    k.stderr = stderr;
    k.kill = () => true;
    k.stdin = {
      end: (s?: string) => {
        const dest =
          /^-get \/proc\/meminfo "([^"]+)"$/m.exec(s ?? "")?.[1] ?? "";
        if (cmd === "sftp" && dest && a.file !== undefined)
          fs.writeFileSync(dest, a.file);
        setImmediate(() => {
          if (a.out) stdout.emit("data", Buffer.from(a.out));
          if (a.err)
            stderr.emit("data", Buffer.from(a.err.replace("{dest}", dest)));
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

describe("reading /proc/meminfo with no MemAvailable", () => {
  it("an old kernel: MemFree + Buffers + Cached", () => {
    expect(linuxFreeMb(OLD_KERNEL_MEMINFO)).toBeCloseTo(OLD_KERNEL_MB);
  });

  it("WSL: MemFree + Buffers + Cached", () => {
    expect(linuxFreeMb(WSL_MEMINFO)).toBeCloseTo(WSL_MB);
  });

  it("MemAvailable is used when it is there", () => {
    expect(linuxFreeMb(LINUX_MEMINFO)).toBeCloseTo(24135428 / 1024);
  });

  it("a part of the sum missing: unknown, never a guess", () => {
    expect(linuxFreeMb("MemFree: 100 kB\n")).toBeUndefined();
    expect(linuxFreeMb("MemFree: 100 kB\nBuffers: 1 kB\n")).toBeUndefined();
    expect(linuxFreeMb("")).toBeUndefined();
  });

  it("macOS vm_stat as captured: free + inactive + speculative pages", () => {
    expect(macFreeMb(MAC_VM_STAT)).toBeCloseTo(
      ((740825 + 3196859 + 23821) * 16384) / 1048576,
    );
  });
});

describe("the box check says why memory is unknown", () => {
  it("a WSL box with no MemAvailable is open with its free memory", async () => {
    const f = scripted({ sftp: { file: WSL_MEMINFO, err: NO_HOLD } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("open");
    expect(r.freeMemMb).toBeCloseTo(WSL_MB);
    expect(f.calls).toEqual(["sftp"]);
  });

  it("sftp can't write its copy: unknown with sftp's error, and no command is run", async () => {
    const f = scripted({ sftp: { err: NO_HOLD + openLocal("{dest}") } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(
      /^memory unknown: the copy of \/proc\/meminfo couldn't be written here: .*No such file or directory/,
    );
    expect(r.reason).not.toMatch(/MemAvailable/);
    expect(f.calls).toEqual(["sftp"]);
  });

  it("sftp can't write its copy, and the hold file is there: held", async () => {
    const f = scripted({
      sftp: { out: HOLD_THERE, err: openLocal("{dest}") },
    });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("held");
  });

  it("fails closed: with its hold file listed, whatever else sftp prints, the box stays held", async () => {
    for (const err of [
      openLocal("{dest}"),
      "stat remote: No such file or directory\n",
      'remote readdir("/home/ci"): No such file or directory\n',
      'Can\'t ls: "/home/ci/heavy.hold": Permission denied\n',
      "Connection to box1.test closed by remote host.\n",
      "",
    ]) {
      for (const file of [LINUX_MEMINFO, undefined]) {
        const f = scripted({ sftp: { file, out: HOLD_THERE, err } });
        const r = await sftpProbe(f.start as never)(BOX, 2000);
        expect({ err, state: r.state }).toEqual({ err, state: "held" });
      }
    }
  });

  // Issue 1597: sftp doesn't expand "~", so the check must never ask for
  // a "~" path: it asks for the home-relative one, and a hold file there is
  // held. (Before, it asked for "~/…", sftp said "not found" for
  // "<home>/~/…", and a paused box read as open.)
  it("a hold file named in an ~ path is asked for home-relative, and held when it is there", async () => {
    const f = scripted({
      sftp: { file: LINUX_MEMINFO, out: "den-capacity/hold\n", err: "" },
    });
    let batch = "";
    const start = (cmd: string) => {
      const k = f.start(cmd);
      const stdin = k.stdin as { end: (s?: string) => void };
      const end = stdin.end;
      stdin.end = (s?: string) => {
        if (cmd === "sftp") batch = s ?? "";
        end(s);
      };
      return k;
    };
    const r = await sftpProbe(start as never)(
      { ...BOX, hold_file: "~/den-capacity/hold" },
      2000,
    );
    expect(batch).toMatch(/^-ls -1 "den-capacity"$/m);
    expect(batch).not.toContain("~");
    expect(r.state).toBe("held");
  });

  it("an empty copy: unknown, came back empty", async () => {
    const f = scripted({ sftp: { file: "", err: NO_HOLD } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("unknown");
    expect(r.reason).toBe("memory unknown: /proc/meminfo came back empty");
  });

  it("text with none of the fields: unknown, naming what is missing", async () => {
    const f = scripted({ sftp: { file: "MemTotal: 100 kB\n", err: NO_HOLD } });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("unknown");
    expect(r.reason).toBe(
      "memory unknown: /proc/meminfo has neither MemAvailable nor MemFree, Buffers and Cached",
    );
  });

  it("macOS (no /proc/meminfo) still takes the vm_stat path", async () => {
    const f = scripted({
      sftp: { err: NO_HOLD + NO_MEMINFO },
      ssh: { out: MAC_VM_STAT },
    });
    const r = await sftpProbe(f.start as never)(BOX, 2000);
    expect(r.state).toBe("open");
    expect(f.calls).toEqual(["sftp", "ssh"]);
  });
});
