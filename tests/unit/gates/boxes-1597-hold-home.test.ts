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
  marksDirOf,
  sftpProbe,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";

const HOME = "/home/ci";
const MEMINFO = `MemTotal:       25639900 kB
MemFree:        23193240 kB
MemAvailable:   24135428 kB
`;

/** sftp over a file tree: `files` and `dirs` are absolute paths. */
function fakeSftp(tree: { files: string[]; dirs: string[] }) {
  const batches: string[] = [];
  const abs = (p: string) => (p.startsWith("/") ? p : `${HOME}/${p}`);
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
          let m: RegExpExecArray | null;
          if ((m = /^-ls -1 "([^"]+)"$/.exec(line))) {
            const d = abs(m[1]);
            if (!tree.dirs.includes(d)) err += `Can't ls: "${d}" not found\n`;
            else
              for (const f of tree.files)
                if (f.startsWith(`${d}/`))
                  out += `${m[1]}/${f.slice(d.length + 1)}\n`;
          } else if ((m = /^-ls "([^"]+)"$/.exec(line))) {
            const p = abs(m[1]);
            if (tree.files.includes(p)) out += `${m[1]}\n`;
            else if (!tree.dirs.includes(p))
              err += `Can't ls: "${p}" not found\n`;
          } else if ((m = /^-get \/proc\/meminfo "([^"]+)"$/.exec(line))) {
            fs.writeFileSync(m[1], MEMINFO);
          } else if ((m = /^-cd "([^"]+)"$/.exec(line))) {
            if (!tree.dirs.includes(abs(m[1])))
              err += "stat remote: No such file or directory\n";
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
  it("a hold file whose folder isn't there: held, saying a hold can't be seen", async () => {
    const f = fakeSftp({ dirs: [HOME], files: [] });
    const r = await sftpProbe(f.start as never)(box("den-capacity/hold"), 2000);
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/den-capacity/);
    expect(r.reason).toMatch(/can't be seen/);
  });

  it("an absolute hold path whose folder is there: open without the file, held with it", async () => {
    const dirs = [HOME, "/srv/hold"];
    const open = fakeSftp({ dirs, files: [] });
    expect(
      (await sftpProbe(open.start as never)(box("/srv/hold/den.hold"), 2000))
        .state,
    ).toBe("open");
    const held = fakeSftp({ dirs, files: ["/srv/hold/den.hold"] });
    expect(
      (await sftpProbe(held.start as never)(box("/srv/hold/den.hold"), 2000))
        .state,
    ).toBe("held");
  });

  it("a hold file in the home folder itself needs no folder check", async () => {
    const f = fakeSftp({ dirs: [HOME], files: [] });
    const r = await sftpProbe(f.start as never)(box("heavy.hold"), 2000);
    expect(r.state).toBe("open");
    expect(f.batches.join("")).not.toMatch(/^-cd /m);
  });
});
