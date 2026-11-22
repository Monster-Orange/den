/**
 * Issue 946: the fixture person's pin saves (fixtureSave). It adds pins
 * and takes off only the ones it added; the person's own pins always
 * stay, in place. A pin is (item, project): the same item in another
 * project is another pin.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixtureSave,
  prunedFixturePins,
  readFixturePins,
  writeFixturePins,
  type Pin,
} from "../../../src/ui/server/shell-prefs.js";

const pin = (item: string, project: string | null = null): Pin => ({
  item,
  project,
});

describe("issue 946: what a fixture save does to the pins", () => {
  it("keeps every pin the person made, whatever the fixture asks", () => {
    const r = fixtureSave([pin("a"), pin("b")], [], []);
    expect(r.pins).toEqual([pin("a"), pin("b")]);
    expect(r.added).toEqual([]);
  });

  it("adds what it asks for, and records it as its own", () => {
    const r = fixtureSave([pin("a")], [pin("a"), pin("c")], []);
    expect(r.pins).toEqual([pin("a"), pin("c")]);
    expect(r.added).toEqual([pin("c")]);
  });

  it("takes off a pin it added", () => {
    const r = fixtureSave([pin("a"), pin("c")], [pin("a")], [pin("c")]);
    expect(r.pins).toEqual([pin("a")]);
    expect(r.added).toEqual([]);
  });

  it("never claims a pin the person made, even when it asks for it", () => {
    const r = fixtureSave([pin("a")], [pin("a")], []);
    expect(r.added).toEqual([]);
  });

  it("the same item in another project is another pin", () => {
    const r = fixtureSave([pin("a", "north")], [pin("a")], []);
    expect(r.pins).toEqual([pin("a", "north"), pin("a")]);
    expect(r.added).toEqual([pin("a")]);
  });

  it("forgets an added pin that is no longer stored", () => {
    const r = fixtureSave([pin("a")], [pin("a")], [pin("gone")]);
    expect(r.added).toEqual([]);
  });
});

describe("issue 957: the record follows the stored pins", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-fxpins-"));
    dirs.push(d);
    return d;
  };

  it("a recorded pin that is no longer stored leaves the record", () => {
    const d = tmp();
    writeFixturePins(d, [pin("a"), pin("b")], [pin("a"), pin("b")]);
    expect(prunedFixturePins(d, [pin("a")])).toEqual([pin("a")]);
    expect(readFixturePins(d)).toEqual([pin("a")]);
  });

  it("none stored: the record goes", () => {
    const d = tmp();
    writeFixturePins(d, [pin("a")], [pin("a")]);
    expect(prunedFixturePins(d, [])).toEqual([]);
    expect(readFixturePins(d)).toEqual([]);
  });
});
