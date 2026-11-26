/**
 * Issue 1597: a test box's hold file is the box owner's pause switch, so
 * the gate must see it whenever it is there.
 *
 * - sftp never expands "~": asked for "~/den-capacity/hold" it looks for
 *   "<home>/~/den-capacity/hold", which is never there, so a paused box
 *   read as open. A leading "~/" is now the box user's home (where sftp
 *   starts), on every way in and in settings already saved; any other "~"
 *   form is refused.
 * - The check fails closed: when the hold file's folder isn't there (or
 *   can't be read), a hold could never be seen, so the box is held, with
 *   the reason. Doctor shows it (a held box is ⚠).
 *
 * The fake sftp below answers from a small file tree the way sftp does
 * (it reads each batch line and resolves paths against the home folder,
 * with no "~" expansion): nothing reaches a real box.
 */
import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import * as fs from "fs";
import {
  boxesOf,
  checkBox,
  holdReading,
  marksDirOf,
  sftpProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";

const HOME = "/home/ci";
const MEMINFO = `MemTotal:       25639900 kB
MemFree:        23193240 kB
MemAvailable:   24135428 kB
`;

/**
 * sftp over a file tree, in the sftp client's own words (captured on the
 * gate host's sftp against OpenSSH's sftp-server: the client prints them;
 * the server only returns a status). Each batch line is echoed on stdout.
 * - `-ls "f"`, one file: its name; missing, or in a folder it can't read:
 *   `Can't ls: "<abs>" not found` (so a hold can't be read from that).
 * - `-cd "d"`: only a stat, so a folder it can't read passes; missing:
 *   `stat remote: No such file or directory`.
 * - `-ls -1 "d"`, a folder: `d/<name>` lines ("." gives `./<name>`);
 *   a file: its own bare name; missing: `Can't ls: "<abs>" not found`;
 *   a folder it can't read: `remote readdir("<abs>/"): Permission denied`.
 * `files` and `dirs` are absolute; `locked` dirs can't be read.
 */
function fakeSftp(tree: {
  files: string[];
  dirs: string[];
  locked?: string[];
}) {
  const batches: string[] = [];
  const abs = (p: string) =>
    p === "." ? HOME : p.startsWith("/") ? p : `${HOME}/${p}`;
  const start = (cmd: string) => {
    const k = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    k.stdout = stdout;
    k.stderr = stderr;
    k.kill = () => true;
    k.stdin = {
      end: (s?: string) => {
        const batch = s ?? "";
        batches.push(batch);
        let out = "";
        let err = "";
        for (const line of batch.split("\n")) {
          if (!line) continue;
          out += `sftp> ${line}\n`;
          let m: RegExpExecArray | null;
          if ((m = /^-ls -1 "([^"]+)"$/.exec(line))) {
            const d = abs(m[1]);
            if (tree.files.includes(d)) out += `${m[1]}\n`;
            else if (!tree.dirs.includes(d))
              err += `Can't ls: "${d}" not found\n`;
            else if (tree.locked?.includes(d))
              err += `remote readdir("${d}/"): Permission denied\n`;
            else
              for (const f of [...tree.files, ...tree.dirs]) {
                const rest = f.slice(d.length + 1);
                if (f.startsWith(`${d}/`) && rest && !rest.includes("/"))
                  out += `${m[1]}/${rest}\n`;
              }
          } else if ((m = /^-ls "([^"]+)"$/.exec(line))) {
            // One file: sftp says "not found" when it can't read the
            // folder it is in, there or not (what the check used to ask).
            const f = abs(m[1]);
            const inLocked = tree.locked?.some((d) => f.startsWith(`${d}/`));
            if (tree.files.includes(f) && !inLocked) out += `${m[1]}\n`;
            else err += `Can't ls: "${f}" not found\n`;
          } else if ((m = /^-cd "([^"]+)"$/.exec(line))) {
            // cd only stats the folder: one it can't read still passes.
            if (!tree.dirs.includes(abs(m[1])))
              err += "stat remote: No such file or directory\n";
          } else if ((m = /^-get \/proc\/meminfo "([^"]+)"$/.exec(line))) {
            fs.writeFileSync(m[1], MEMINFO);
          } else {
            throw new Error(`the fake doesn't know: ${line}`);
          }
        }
        setImmediate(() => {
          if (out) stdout.emit("data", Buffer.from(out));
          if (err) stderr.emit("data", Buffer.from(err));
          k.emit("close", cmd === "sftp" ? 0 : 127);
        });
      },
    };
    return k;
  };
  return { start, batches };
}

const box = (hold_file: string): GateBox => {
  const c = checkBox({
    name: "box1",
    ssh: "ci@box1.test",
    browser_slots: 1,
    hold_file,
  });
  if (!c.ok) throw new Error(c.error);
  return c.box;
};

describe("a test box's hold file given as ~/… (issue 1597)", () => {
  it("is the box user's home: the hold file there reads as held", async () => {
    const f = fakeSftp({
      dirs: [HOME, `${HOME}/den-capacity`],
      files: [`${HOME}/den-capacity/hold`],
    });
    const r = await sftpProbe(f.start as never)(
      box("~/den-capacity/hold"),
      2000,
    );
    expect(r.state).toBe("held");
    expect(f.batches.join("")).not.toContain("~");
  });

  it("with no hold file in that folder, the box is open", async () => {
    const f = fakeSftp({ dirs: [HOME, `${HOME}/den-capacity`], files: [] });
    const r = await sftpProbe(f.start as never)(
      box("~/den-capacity/hold"),
      2000,
    );
    expect(r.state).toBe("open");
  });

  it("is saved home-relative, and so is the marks folder next to it", () => {
    const b = box("~/den-capacity/hold");
    expect(b.hold_file).toBe("den-capacity/hold");
    expect(marksDirOf(b)).toBe("den-capacity/hold.jobs");
  });

  it("settings saved before the fix read home-relative too", () => {
    const [b] = boxesOf([
      {
        name: "box1",
        ssh: "ci@box1.test",
        browser_slots: 1,
        hold_file: "~/den-capacity/hold",
      },
    ]);
    expect(b.hold_file).toBe("den-capacity/hold");
  });

  it("any other ~ form is refused with the reason", () => {
    for (const hold_file of ["~", "~/", "~den/den-capacity/hold", "~x"]) {
      const c = checkBox({
        name: "box1",
        ssh: "ci@box1.test",
        browser_slots: 1,
        hold_file,
      });
      expect({ hold_file, ok: c.ok }).toEqual({ hold_file, ok: false });
      if (!c.ok) expect(c.error).toMatch(/hold_file/);
    }
  });
});

describe("the hold check fails closed (issue 1597)", () => {
  const probe = (tree: Parameters<typeof fakeSftp>[0], hold: string) =>
    sftpProbe(fakeSftp(tree).start as never)(box(hold), 2000);

  it("the hold folder isn't there: held, saying the hold can't be checked", async () => {
    const r = await probe({ dirs: [HOME], files: [] }, "den-capacity/hold");
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/can't be checked \(den-capacity: Can't ls/);
  });

  it("a folder sftp can't read, with the hold in it, is held (sftp says the hold file is 'not found')", async () => {
    const r = await probe(
      {
        dirs: [HOME, `${HOME}/den-capacity`],
        locked: [`${HOME}/den-capacity`],
        files: [`${HOME}/den-capacity/hold`],
      },
      "den-capacity/hold",
    );
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/Permission denied/);
  });

  it("a hold 'folder' that is a file: held", async () => {
    const r = await probe(
      { dirs: [HOME], files: [`${HOME}/den-capacity`] },
      "den-capacity/hold",
    );
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/is a file, not a folder/);
  });

  it("an error line the gate doesn't know: held, naming it", async () => {
    const f = fakeSftp({ dirs: [HOME, `${HOME}/den-capacity`], files: [] });
    const start = (cmd: string) => {
      const k = f.start(cmd);
      const stderr = k.stderr as EventEmitter;
      const emit = stderr.emit.bind(stderr);
      setImmediate(() =>
        emit("data", Buffer.from("Couldn't stat remote file: Failure\n")),
      );
      return k;
    };
    const r = await sftpProbe(start as never)(box("den-capacity/hold"), 2000);
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/Couldn't stat remote file/);
  });

  it("a listing cut short at the gate's limit: held", () => {
    expect(
      holdReading(
        "den-capacity/hold",
        "den-capacity",
        "den-capacity/hold.jobs",
        {
          out: "x".repeat(65536),
          err: "",
        },
      ),
    ).toMatchObject({
      gone: false,
      why: expect.stringMatching(/more than the gate reads/),
    });
  });

  it("the marks folder's 'not found' and the memory lines aren't about the hold", () => {
    expect(
      holdReading(
        "den-capacity/hold",
        "den-capacity",
        "den-capacity/hold.jobs",
        {
          out: 'sftp> -ls -1 "den-capacity"\nden-capacity/status\nden-capacity/hold.jobs\n',
          err:
            'Can\'t ls: "/home/ci/den-capacity/hold.jobs" not found\n' +
            'File "/proc/meminfo" not found.\n',
        },
      ),
    ).toEqual({ gone: true });
  });

  it("a hold file in the home folder: its listing is of '.'", async () => {
    const absent = fakeSftp({ dirs: [HOME], files: [`${HOME}/other`] });
    expect(
      (await sftpProbe(absent.start as never)(box("heavy.hold"), 2000)).state,
    ).toBe("open");
    expect(absent.batches[0]).toMatch(/^-ls -1 "\."$/m);
    expect(
      (
        await probe(
          { dirs: [HOME], files: [`${HOME}/heavy.hold`] },
          "heavy.hold",
        )
      ).state,
    ).toBe("held");
  });

  it("an absolute hold path: open without the file, held with it", async () => {
    const dirs = [HOME, "/srv", "/srv/hold"];
    expect((await probe({ dirs, files: [] }, "/srv/hold/den.hold")).state).toBe(
      "open",
    );
    expect(
      (
        await probe(
          { dirs, files: ["/srv/hold/den.hold"] },
          "/srv/hold/den.hold",
        )
      ).state,
    ).toBe("held");
  });

  it("the check never asks sftp for the hold file itself, which reads 'not found' when unreadable", async () => {
    const f = fakeSftp({ dirs: [HOME, `${HOME}/den-capacity`], files: [] });
    await sftpProbe(f.start as never)(box("den-capacity/hold"), 2000);
    expect(f.batches[0]).not.toMatch(/^-ls "den-capacity\/hold"$/m);
  });
});

describe("hold paths checkBox refuses (issue 1597)", () => {
  const refused = (hold_file: string) =>
    !checkBox({
      name: "box1",
      ssh: "ci@box1.test",
      browser_slots: 1,
      hold_file,
    }).ok;
  it("'~/-l' (the dash rule holds after the ~/ comes off), and a file right under /", () => {
    expect(refused("~/-l")).toBe(true);
    expect(refused("/hold")).toBe(true);
    expect(refused("/srv/hold/den.hold")).toBe(false);
  });
});
