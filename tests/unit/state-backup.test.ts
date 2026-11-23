/**
 * Issue 786 clause 3: a state file Den can't read is kept, not lost. It
 * moves to <state>/backup/ (the newest 3 per file), doctor shows a row and
 * the bell an item, never a silent reset. A temp state folder only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  KEEP_PER_FILE,
  keepUnreadable,
  readKept,
  readStateJson,
} from "../../src/shared/state-backup.js";
import { NotificationStore } from "../../src/shared/notifications.js";
import { agentIdTaken, readRecord } from "../../src/shared/agents/records.js";
import { defaultId } from "../../src/ui/cli/agent-ops.js";
import { stateKeptLines } from "../../src/ui/cli/doctor-command.js";
import { startStateKeptBell } from "../../src/ui/server/state-kept-bell.js";

const tmps: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-"));
  tmps.push(d);
  return d;
};
const backup = (d: string) =>
  fs.readdirSync(path.join(d, "backup")).filter((n) => n.endsWith(".bad"));

describe("a state file that can't be read", () => {
  it("lands in backup with its body, and the read says so", () => {
    const d = stateDir();
    const f = path.join(d, "agents", "a1.json");
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, '{"id":"a1", "na');
    const r = readStateJson(d, f);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
    const [saved] = backup(d);
    expect(saved).toMatch(/^agents__a1\.json\..+\.bad$/);
    expect(fs.readFileSync(path.join(d, "backup", saved), "utf8")).toBe(
      '{"id":"a1", "na',
    );
    expect(readKept(d)).toEqual([
      expect.objectContaining({ file: "agents/a1.json", saved }),
    ]);
  });

  it("a missing file is only missing: nothing is kept", () => {
    const d = stateDir();
    expect(readStateJson(d, path.join(d, "none.json"))).toEqual({
      ok: false,
      missing: true,
    });
    expect(fs.existsSync(path.join(d, "backup"))).toBe(false);
  });

  it(`keeps the newest ${KEEP_PER_FILE} copies per file`, () => {
    const d = stateDir();
    const f = path.join(d, "notifications.json");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(f, `broken ${i}`);
      keepUnreadable(d, f, "bad", new Date(Date.UTC(2026, 10, 22, 10, i)));
    }
    const left = backup(d).sort();
    expect(left).toHaveLength(KEEP_PER_FILE);
    expect(
      left.map((n) => fs.readFileSync(path.join(d, "backup", n), "utf8")),
    ).toEqual(["broken 2", "broken 3", "broken 4"]);
  });

  it("a file outside the state folder stays where it is", () => {
    const d = stateDir();
    const other = stateDir();
    const f = path.join(other, "x.json");
    fs.writeFileSync(f, "{");
    expect(keepUnreadable(d, f, "bad")).toBeNull();
    expect(fs.readFileSync(f, "utf8")).toBe("{");
  });

  it("the bell's store keeps its broken file instead of resetting it", () => {
    const d = stateDir();
    fs.writeFileSync(path.join(d, "notifications.json"), '{"items":[{');
    const store = new NotificationStore(d);
    expect(store.list()).toEqual([]);
    expect(readKept(d).map((k) => k.file)).toEqual(["notifications.json"]);
  });

  it("a broken agent record is kept and read as none", () => {
    const d = stateDir();
    fs.mkdirSync(path.join(d, "agents"), { recursive: true });
    const f = path.join(d, "agents", "a1.json");
    fs.writeFileSync(f, '{"id":"a1",');
    expect(readRecord(d, "a1")).toBeNull();
    expect(readKept(d).map((k) => k.file)).toEqual(["agents/a1.json"]);
  });
});

describe("a kept record's id stays taken", () => {
  it("a new agent never takes the id of a broken record kept in backup", () => {
    const d = stateDir();
    fs.mkdirSync(path.join(d, "agents"), { recursive: true });
    fs.writeFileSync(path.join(d, "agents", "planner.json"), '{"id":');
    expect(readRecord(d, "planner")).toBeNull();
    expect(agentIdTaken(d, "planner")).toBe(true);
    expect(defaultId(d, "planner", "north")).not.toBe("planner");
    expect(agentIdTaken(d, "reviewer")).toBe(false);
    expect(defaultId(d, "reviewer", "north")).toBe("reviewer");
  });
});

describe("it is never silent", () => {
  it("doctor shows a warn row naming the file; none when nothing was kept", () => {
    const d = stateDir();
    expect(stateKeptLines("Den", () => d).check).toBeUndefined();
    fs.writeFileSync(path.join(d, "approvals.json"), "{");
    keepUnreadable(d, path.join(d, "approvals.json"), "bad");
    const r = stateKeptLines("Den", () => d);
    expect(r.check).toEqual(
      expect.objectContaining({ id: "state_kept", status: "warn" }),
    );
    expect(r.check?.detail).toContain("approvals.json");
  });

  it("the bell gets one item per file: those kept before the start, then new ones, each once", () => {
    const d = stateDir();
    fs.writeFileSync(path.join(d, "a.json"), "{");
    keepUnreadable(d, path.join(d, "a.json"), "bad");
    const added: Array<{ subject: string; msg?: { key: string } }> = [];
    const store = {
      add: (n: { subject: string; msg?: { key: string } }) => {
        added.push(n);
        return null;
      },
    };
    stops.push(startStateKeptBell(d, () => store));
    expect(added.map((n) => n.subject)).toEqual(["record:state-kept:a.json"]);
    expect(added[0].msg?.key).toBe("bell.m.stateKept");

    fs.writeFileSync(path.join(d, "b.json"), "{");
    readStateJson(d, path.join(d, "b.json"));
    expect(added.map((n) => n.subject)).toEqual([
      "record:state-kept:a.json",
      "record:state-kept:b.json",
    ]);

    // A second start tells nothing again.
    stops.splice(0).forEach((s) => s());
    added.length = 0;
    stops.push(startStateKeptBell(d, () => store));
    expect(added).toEqual([]);
  });
});

describe("issue 786: a broken file's text never reaches backup's notes (security review)", () => {
  const SECRET = "den_at_SECRETTOKENxyz0123456789";

  it.each([
    ["a bare token", SECRET],
    ["a token in a cut-off object", `{"tokens":{"${SECRET}":`],
    ["a short broken file", `{"k":"${SECRET.slice(0, 9)}"`],
  ])("%s: the note says not valid JSON, with none of the text", (_n, text) => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-why-"));
    try {
      const file = path.join(s, "actor-tokens.json");
      fs.writeFileSync(file, text, { mode: 0o600 });
      const r = readStateJson(s, file);
      expect(r.ok).toBe(false);
      const notes = fs.readFileSync(
        path.join(s, "backup", "kept.json"),
        "utf8",
      );
      for (const part of [SECRET, SECRET.slice(0, 9), "den_at", '"k"'])
        expect(notes).not.toContain(part);
      expect(readKept(s)[0]!.why).toMatch(
        /^not valid JSON( \(at position \d+\))?$/,
      );
    } finally {
      fs.rmSync(s, { recursive: true, force: true });
    }
  });

  it("whatever a caller passes, only a fixed reason is kept", () => {
    const s = fs.mkdtempSync(path.join(os.tmpdir(), "den-786-why-"));
    try {
      const file = path.join(s, "a.json");
      fs.writeFileSync(file, "x");
      const k = keepUnreadable(
        s,
        file,
        `Unexpected token 'd', "${SECRET}" is not valid JSON`,
      );
      expect(k!.why).toBe("not valid JSON");
      fs.writeFileSync(file, "x");
      expect(
        keepUnreadable(
          s,
          file,
          "EACCES: permission denied, open '/x/den_at_y'",
        )!.why,
      ).toBe("can't be read (EACCES)");
      fs.writeFileSync(file, "x");
      expect(keepUnreadable(s, file, `odd "${SECRET}"`)!.why).toBe(
        "can't be read",
      );
      // Only an errno code at the start, never an upper-case word inside.
      fs.writeFileSync(file, "x");
      expect(
        keepUnreadable(s, file, "token EVILSECRETTOKEN refused")!.why,
      ).toBe("can't be read");
    } finally {
      fs.rmSync(s, { recursive: true, force: true });
    }
  });
});
