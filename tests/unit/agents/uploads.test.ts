/**
 * AG-DROP: the uploads module (shared/agents/uploads.ts): its settings, a
 * safe file name and path, the shell word a path is typed as, and pruning.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  pruneUploads,
  safeUploadName,
  shellQuote,
  uploadPath,
  uploadsBlock,
  uploadsRoot,
  UPLOAD_DEFAULTS,
} from "../../../src/shared/agents/uploads.js";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
} from "../../../src/shared/den-config.js";
import { shellQuote as pageQuote } from "../../../src/ui/server/public/term-drop.js";

const tmps: string[] = [];
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-up-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("agents.uploads", () => {
  it("defaults: 25 MB, 7 days, <state>/uploads", () => {
    expect(uploadsBlock(undefined)).toEqual({
      maxBytes: 25 * 1024 * 1024,
      keepDays: 7,
      dir: null,
    });
    expect(uploadsRoot(UPLOAD_DEFAULTS, "/s")).toBe("/s/uploads");
  });

  it("takes max_bytes, keep_days and an absolute dir", () => {
    expect(
      uploadsBlock({ max_bytes: 1000, keep_days: 0.5, dir: "/x/up/" }),
    ).toEqual({ maxBytes: 1000, keepDays: 0.5, dir: "/x/up/" });
    expect(uploadsRoot(uploadsBlock({ dir: "/x/up" }), "/s")).toBe("/x/up");
  });

  it.each([
    [{ max_bytes: 0 }, "agents.uploads.max_bytes"],
    [{ max_bytes: 1.5 }, "agents.uploads.max_bytes"],
    [{ max_bytes: "25MB" }, "agents.uploads.max_bytes"],
    [{ keep_days: 0 }, "agents.uploads.keep_days"],
    [{ dir: "rel/dir" }, "agents.uploads.dir"],
    [{ maxbytes: 1 }, "agents.uploads.maxbytes: unknown key"],
    [5, "agents.uploads: must be a mapping"],
  ])("refuses %j, naming the key", (v, msg) => {
    expect(() => uploadsBlock(v)).toThrow(msg);
  });

  it("is a reserved agents key, read by readAgentsConfig", () => {
    expect(AGENTS_RESERVED_KEYS).toContain("uploads");
    const c = readAgentsConfig({
      agents: { uploads: { max_bytes: 2048 } },
    } as never);
    expect(c.uploads?.maxBytes).toBe(2048);
    expect(c.agents).toEqual({});
  });
});

describe("a file's name and path", () => {
  it.each([
    ["shot.png", "shot.png"],
    [
      "Screen Shot 2026-11-11 at 9.41.07 AM.png",
      "Screen Shot 2026-11-11 at 9.41.07 AM.png",
    ],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\win.ini", "win.ini"],
    ["..", "file"],
    [".bashrc", "bashrc"],
    ["", "file"],
    ["a\u0000b\nc.txt", "a_b_c.txt"],
    ["$(rm -rf ~).sh", "_(rm -rf _).sh"],
    ["résumé.pdf", "résumé.pdf"],
  ])("%j → %j", (from, to) => {
    expect(safeUploadName(from)).toBe(to);
  });

  it("keeps a long name's extension, at most 100 characters", () => {
    const n = safeUploadName(`${"x".repeat(300)}.png`);
    expect(n.length).toBe(100);
    expect(n.endsWith(".png")).toBe(true);
  });

  it("is <root>/<session>/<time>-<name>, never outside the session's folder", () => {
    const at = new Date(Date.UTC(2026, 10, 11, 9, 41, 7, 5));
    expect(uploadPath("/r", "a1b2c3d4", "../../x.png", at)).toBe(
      "/r/a1b2c3d4/20261111-094107-005-x.png",
    );
    for (const bad of ["..", "a/b", "", "x".repeat(65)])
      expect(() => uploadPath("/r", bad, "x", at)).toThrow("not a session id");
  });
});

describe("the path as typed", () => {
  it.each([
    ["/s/uploads/ab/2026-x.png", "/s/uploads/ab/2026-x.png"],
    ["/s/up/a b.png", "'/s/up/a b.png'"],
    ["/s/up/it's.png", `'/s/up/it'\\''s.png'`],
    ["/s/up/$(x).png", "'/s/up/$(x).png'"],
  ])("%j → %j, the server's and the page's alike", (p, w) => {
    expect(shellQuote(p)).toBe(w);
    expect(pageQuote(p)).toBe(w);
  });
});

describe("pruning", () => {
  it("removes files older than keep_days and emptied session folders; leaves the rest", () => {
    const root = tmp();
    const now = Date.now();
    const old = (f: string) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "x");
      const t = (now - 8 * 86_400_000) / 1000;
      fs.utimesSync(f, t, t);
    };
    old(path.join(root, "aa", "old.png"));
    old(path.join(root, "bb", "old.png"));
    fs.writeFileSync(path.join(root, "bb", "new.png"), "x");
    // Not a session folder, and a link: never touched.
    old(path.join(root, "not a session", "old.png"));
    const outside = path.join(tmp(), "keep.txt");
    old(outside);
    fs.mkdirSync(path.join(root, "cc"));
    fs.symlinkSync(outside, path.join(root, "cc", "link"));
    expect(pruneUploads(root, 7, now)).toBe(2);
    expect(fs.existsSync(path.join(root, "aa"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "bb"))).toEqual(["new.png"]);
    expect(fs.existsSync(path.join(root, "not a session", "old.png"))).toBe(
      true,
    );
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readdirSync(path.join(root, "cc"))).toEqual(["link"]);
  });

  it("is nothing when there is no folder yet", () => {
    expect(pruneUploads(path.join(tmp(), "none"), 7)).toBe(0);
  });
});
