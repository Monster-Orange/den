/**
 * Issue 1381: a Linux test box's memory is read from a macOS gate host.
 * macOS sftp can't write a `-get` to a pipe given as /dev/stdout
 * ("local ftruncate … Invalid argument", "Illegal seek"), so reading
 * /proc/meminfo that way gave no text and every Linux box read "memory
 * unknown". Den now gets the file into a new private folder (0700),
 * reads it, and removes the folder: the box still runs nothing.
 * The process starter is a fake sftp that, like macOS sftp, refuses a
 * pipe and writes only to a real file: nothing reaches a real box.
 */
import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sftpProbe, type GateBox } from "../../../src/shared/gates/boxes.js";

const LINUX_MEMINFO = `MemTotal:       16314748 kB
MemFree:         1203456 kB
MemAvailable:    8000000 kB
`;
const NO_HOLD = 'Can\'t ls: "/home/ci/heavy.hold" not found\n';

/** Where each `-get` of the batch went, and the folder's mode then. */
interface Seen {
  dest?: string;
  dirMode?: number;
  stdin: string;
  cmds: string[];
}

/**
 * A fake macOS sftp: `-get <remote> /dev/stdout` fails as macOS's does
 * and writes nothing; `-get <remote> <file>` writes the remote's text to
 * that file. `files` is the box's files; a missing one is "not found".
 */
function macSftp(files: Record<string, string>, seen: Seen) {
  return (cmd: string) => {
    seen.cmds.push(cmd);
    const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    k.stdout = stdout;
    k.stderr = stderr;
    k.kill = () => true;
    k.stdin = {
      end: (s?: string) => {
        seen.stdin = s ?? "";
        let err = "";
        for (const line of seen.stdin.split("\n")) {
          const m = /^-get (\S+) "?([^"]+)"?$/.exec(line);
          if (!m) {
            if (line.startsWith("-ls ")) err += NO_HOLD;
            continue;
          }
          const [, remote, local] = m as unknown as [string, string, string];
          if (!(remote in files)) {
            err += `File "${remote}" not found.\n`;
            continue;
          }
          if (local === "/dev/stdout") {
            err += `local ftruncate "/dev/stdout": Invalid argument\n`;
            err += `write local "/dev/stdout": Illegal seek\n`;
            continue;
          }
          seen.dest = local;
          seen.dirMode = fs.statSync(path.dirname(local)).mode & 0o777;
          fs.writeFileSync(local, files[remote]!);
        }
        setImmediate(() => {
          if (err) stderr.emit("data", Buffer.from(err));
          k.emit("close", 0);
        });
      },
    };
    return k;
  };
}

const BOX: GateBox = {
  name: "linux1",
  ssh: "ci@linux1.test",
  browser_slots: 1,
  hold_file: "heavy.hold",
};

describe("issue 1381: a Linux box's memory from a macOS gate host", () => {
  it("MemAvailable is read and the box is open, with no command run", async () => {
    const seen: Seen = { stdin: "", cmds: [] };
    const start = macSftp({ "/proc/meminfo": LINUX_MEMINFO }, seen);
    const r = await sftpProbe(start as never)(BOX, 2000);
    expect(r.state).toBe("open");
    expect(r.freeMemMb).toBeCloseTo(8000000 / 1024);
    expect(seen.cmds).toEqual(["sftp"]);
    // The hold file is still looked for, in the same session.
    expect(seen.stdin).toContain('-ls "heavy.hold"');
  });

  it("the file goes to a new private folder, which is gone afterwards", async () => {
    const seen: Seen = { stdin: "", cmds: [] };
    const start = macSftp({ "/proc/meminfo": LINUX_MEMINFO }, seen);
    await sftpProbe(start as never)(BOX, 2000);
    expect(seen.dest).toBeDefined();
    expect(seen.dest).not.toBe("/dev/stdout");
    expect(seen.dirMode).toBe(0o700);
    expect(fs.existsSync(path.dirname(seen.dest!))).toBe(false);
  });

  it("the folder is gone when the box can't be reached too", async () => {
    const dirs: string[] = [];
    const start = () => {
      const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
      k.stdout = new EventEmitter();
      k.stderr = new EventEmitter();
      k.kill = () => true;
      k.stdin = {
        end: (s?: string) => {
          const m = /^-get \S+ "?([^"\n]+)"?$/m.exec(s ?? "");
          if (m) dirs.push(path.dirname(m[1]!));
          setImmediate(() => {
            (k.stderr as EventEmitter).emit(
              "data",
              Buffer.from("ssh: connect to host linux1.test: refused\n"),
            );
            k.emit("close", 255);
          });
        },
      };
      return k;
    };
    const r = await sftpProbe(start as never)(BOX, 2000);
    expect(r.state).toBe("unreachable");
    expect(dirs.length).toBe(1);
    expect(fs.existsSync(dirs[0]!)).toBe(false);
  });

  it("a box with no /proc/meminfo still takes issue 857's path (one ssh exec)", async () => {
    const seen: Seen = { stdin: "", cmds: [] };
    const start = macSftp({}, seen);
    const r = await sftpProbe(start as never)(BOX, 2000);
    // The fake answers no ssh: the macOS path ran, and its answer is unknown.
    expect(seen.cmds).toEqual(["sftp", "ssh"]);
    expect(r.state).toBe("unknown");
  });

  it.each([
    ["a quote", 'a"b'],
    ["a backslash", "a\\b"],
  ])(
    "a temp folder whose path holds %s: unknown, and sftp never starts",
    async (_what, name) => {
      const base = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "den-1381-")),
      );
      const odd = path.join(base, name);
      fs.mkdirSync(odd);
      try {
        const seen: Seen = { stdin: "", cmds: [] };
        // As a TMPDIR naming that folder would make os.tmpdir() say.
        const r = await sftpProbe(
          macSftp({ "/proc/meminfo": LINUX_MEMINFO }, seen) as never,
          () => odd,
        )(BOX, 2000);
        expect(r.state).toBe("unknown");
        expect(r.reason).toMatch(/memory unknown/);
        expect(seen.cmds).toEqual([]);
        // Nothing is left in the odd folder.
        expect(fs.readdirSync(odd)).toEqual([]);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("a huge meminfo is read only to 64 KB: MemAvailable within it still counts", async () => {
    const seen: Seen = { stdin: "", cmds: [] };
    const big = LINUX_MEMINFO + "x".repeat(70_000) + "\nMemAvailable: 1 kB\n";
    const r = await sftpProbe(macSftp({ "/proc/meminfo": big }, seen) as never)(
      BOX,
      2000,
    );
    expect(r.state).toBe("open");
    expect(r.freeMemMb).toBeCloseTo(8000000 / 1024);
  });
});
