/**
 * The generic "seen" mark (src/shared/seen-mark.ts). A mark is
 * subject + version + person: this person has seen this version of this
 * subject. An agent's subject is "agent:<id>" and its version its last
 * finished turn; a Hub doc's would be "doc:<id>" and its version number.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SeenMarks, seen, seenMarks } from "../../../src/shared/seen-mark.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seen-mark-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("issue 773: the seen mark", () => {
  it("marks and reads seen for a non-agent subject (a doc version)", () => {
    const m = new SeenMarks(dir);
    m.noteVersion("doc:roadmap", "3");
    expect(m.isSeen({ subject: "doc:roadmap", person: "person:a" })).toBe(
      false,
    );
    expect(m.markSeen({ subject: "doc:roadmap", person: "person:a" })).toBe(
      true,
    );
    expect(m.isSeen({ subject: "doc:roadmap", person: "person:a" })).toBe(true);
    expect(m.seenVersion("doc:roadmap", "person:a")).toBe("3");
    // A newer version is not seen yet.
    m.noteVersion("doc:roadmap", "4");
    expect(m.isSeen({ subject: "doc:roadmap", person: "person:a" })).toBe(
      false,
    );
    // An older one asked by name still counts as seen (numbers order).
    expect(
      m.isSeen({ subject: "doc:roadmap", person: "person:a", version: "2" }),
    ).toBe(true);
  });

  it("a mark names its version: an explicit one, else the subject's latest", () => {
    const m = new SeenMarks(dir);
    m.noteVersion("agent:builder", "100", "2026-11-20T10:00:00.000Z");
    expect(m.latest("agent:builder")).toEqual({
      version: "100",
      at: "2026-11-20T10:00:00.000Z",
    });
    m.markSeen({ subject: "agent:builder", person: "p", version: "100" });
    expect(m.isSeen({ subject: "agent:builder", person: "p" })).toBe(true);
  });

  it("nothing finished yet: nothing to see, so seen; a mark has nothing to name", () => {
    const m = new SeenMarks(dir);
    expect(m.latest("agent:new")).toBeNull();
    expect(m.isSeen({ subject: "agent:new", person: "p" })).toBe(true);
    expect(m.markSeen({ subject: "agent:new", person: "p" })).toBe(false);
  });

  it("seen is per person: one person's mark leaves another's unseen", () => {
    const m = new SeenMarks(dir);
    m.noteVersion("agent:builder", "7");
    m.markSeen({ subject: "agent:builder", person: "person:one" });
    expect(m.isSeen({ subject: "agent:builder", person: "person:one" })).toBe(
      true,
    );
    expect(m.isSeen({ subject: "agent:builder", person: "person:two" })).toBe(
      false,
    );
  });

  it("survives a restart: a new store on the same folder reads the marks", () => {
    const a = new SeenMarks(dir);
    a.noteVersion("agent:builder", "7");
    a.noteVersion("agent:tester", "9");
    a.markSeen({ subject: "agent:builder", person: "p" });
    const b = new SeenMarks(dir);
    expect(b.isSeen({ subject: "agent:builder", person: "p" })).toBe(true);
    expect(b.isSeen({ subject: "agent:tester", person: "p" })).toBe(false);
    expect(b.latest("agent:tester")?.version).toBe("9");
  });

  it("forget drops a subject's latest version and every person's mark", () => {
    const m = new SeenMarks(dir);
    m.noteVersion("agent:gone", "1");
    m.markSeen({ subject: "agent:gone", person: "p" });
    m.forget("agent:gone");
    expect(m.latest("agent:gone")).toBeNull();
    expect(m.seenVersion("agent:gone", "p")).toBeNull();
  });

  it("an unreadable file reads as no marks (never throws)", () => {
    fs.mkdirSync(path.join(dir, "seen"), { recursive: true });
    fs.writeFileSync(path.join(dir, "seen", "marks.json"), "{not json");
    const m = new SeenMarks(dir);
    expect(m.latest("agent:x")).toBeNull();
    m.noteVersion("agent:x", "1");
    expect(m.latest("agent:x")?.version).toBe("1");
  });

  it("seen.mark / seen.isSeen: the same marks through the shared store", () => {
    const store = seenMarks(dir);
    expect(seenMarks(dir)).toBe(store);
    store.noteVersion("doc:spec", "2");
    seen.mark({ subject: "doc:spec", person: "p" }, dir);
    expect(seen.isSeen({ subject: "doc:spec", person: "p" }, dir)).toBe(true);
    expect(seen.latest("doc:spec", dir)?.version).toBe("2");
  });
});
