/**
 * D28: rotation settings, each key from the most specific scope that sets
 * it: agent › persona in a workspace › persona › workspace › service ›
 * install › org › default.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkRotateValue,
  parseRotateValue,
  readRotateFile,
  resolveRotate,
  rotateFilePath,
  setRotateValue,
  sourceText,
  type RotateFile,
  type RotateSubject,
} from "../../../src/shared/agents/rotate-settings.js";

const who: RotateSubject = {
  agent: "art",
  persona: "planner",
  workspace: "personal",
  service: "shop",
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-rotate-"));

describe("resolveRotate", () => {
  it("nothing set: Den's defaults", () => {
    const r = resolveRotate(who, {}, undefined);
    expect(r).toMatchObject({
      afterCompactions: 3,
      onDue: "auto",
      onPrMerged: true,
    });
    expect(r.source.after_compactions).toEqual({ scope: "default" });
  });

  it("each scope beats the ones below it, key by key", () => {
    const file: RotateFile = {
      install: { after_compactions: 9, on_due: "off" },
      overrides: {
        agent: { art: { on_due: "ask" } },
        "persona-workspace": { "planner@personal": { after_compactions: 5 } },
        persona: { planner: { after_compactions: 6, on_pr_merged: false } },
        workspace: { personal: { after_compactions: 7 } },
        service: { shop: { after_compactions: 8 } },
      },
    };
    const r = resolveRotate(who, file, { after_compactions: 10 });
    expect(r.afterCompactions).toBe(5);
    expect(r.source.after_compactions).toEqual({
      scope: "persona-workspace",
      target: "planner@personal",
    });
    expect(r.onDue).toBe("ask");
    expect(r.source.on_due).toEqual({ scope: "agent", target: "art" });
    expect(r.onPrMerged).toBe(false);
    expect(sourceText(r.source.on_pr_merged)).toBe("persona planner");

    const order: [string, number][] = [];
    const ov = file.overrides!;
    delete ov["persona-workspace"];
    order.push([
      "persona",
      resolveRotate(who, file, undefined).afterCompactions,
    ]);
    delete ov.persona;
    order.push([
      "workspace",
      resolveRotate(who, file, undefined).afterCompactions,
    ]);
    delete ov.workspace;
    order.push([
      "service",
      resolveRotate(who, file, undefined).afterCompactions,
    ]);
    delete ov.service;
    order.push([
      "install",
      resolveRotate(who, file, undefined).afterCompactions,
    ]);
    delete file.install;
    order.push([
      "org",
      resolveRotate(who, file, { after_compactions: 10 }).afterCompactions,
    ]);
    expect(order).toEqual([
      ["persona", 6],
      ["workspace", 7],
      ["service", 8],
      ["install", 9],
      ["org", 10],
    ]);
  });

  it("never is 0; another workspace's or persona's override does not apply", () => {
    const file: RotateFile = {
      overrides: {
        agent: { other: { after_compactions: 1 } },
        "persona-workspace": { "planner@work": { after_compactions: 1 } },
        workspace: { personal: { after_compactions: "never" } },
      },
    };
    const r = resolveRotate(who, file, undefined);
    expect(r.afterCompactions).toBe(0);
    expect(sourceText(r.source.after_compactions)).toBe("workspace personal");
  });

  it("an agent outside any service skips the service scope", () => {
    const file: RotateFile = {
      overrides: { service: { shop: { on_due: "off" } } },
    };
    expect(
      resolveRotate({ ...who, service: undefined }, file, undefined).onDue,
    ).toBe("auto");
  });

  it("den#4's standing: false still keeps standing personas from rotating", () => {
    expect(
      resolveRotate({ ...who, standing: true }, {}, { standing: false })
        .afterCompactions,
    ).toBe(0);
    expect(
      resolveRotate({ ...who, standing: false }, {}, { standing: false })
        .afterCompactions,
    ).toBe(3);
    // A persona override still wins over it.
    expect(
      resolveRotate(
        { ...who, standing: true },
        { overrides: { persona: { planner: { after_compactions: 2 } } } },
        { standing: false },
      ).afterCompactions,
    ).toBe(2);
  });
});

describe("agent-rotation.json", () => {
  it("set and unset at each scope; the file is 0600", () => {
    const dir = tmp();
    setRotateValue(dir, "install", undefined, "on_due", "ask");
    setRotateValue(dir, "persona", "planner", "after_compactions", 5);
    setRotateValue(dir, "agent", "art", "after_compactions", "never");
    expect(readRotateFile(dir)).toEqual({
      install: { on_due: "ask" },
      overrides: {
        persona: { planner: { after_compactions: 5 } },
        agent: { art: { after_compactions: "never" } },
      },
    });
    expect((fs.statSync(rotateFilePath(dir)).mode & 0o777).toString(8)).toBe(
      "600",
    );
    setRotateValue(dir, "agent", "art", "after_compactions", undefined);
    setRotateValue(dir, "install", undefined, "on_due", undefined);
    expect(readRotateFile(dir)).toEqual({
      overrides: { persona: { planner: { after_compactions: 5 } } },
    });
  });

  it("refuses a bad key or value, and an override with no target", () => {
    const dir = tmp();
    expect(() =>
      setRotateValue(dir, "persona", "p", "after_compactions", 0),
    ).toThrow(/1 to 100, or never/);
    expect(() =>
      setRotateValue(dir, "persona", "p", "on_due", "later"),
    ).toThrow(/auto, ask or off/);
    expect(() => setRotateValue(dir, "persona", "p", "standing", true)).toThrow(
      /unknown key/,
    );
    expect(() =>
      setRotateValue(dir, "workspace", undefined, "on_due", "ask"),
    ).toThrow(/needs the workspace/);
    expect(fs.existsSync(rotateFilePath(dir))).toBe(false);
  });

  it("a hand-edited bad value is dropped, never an error", () => {
    const dir = tmp();
    fs.writeFileSync(
      rotateFilePath(dir),
      JSON.stringify({
        install: { on_due: "sometimes", after_compactions: 4 },
        overrides: { persona: { p: { on_pr_merged: "yes" } }, bogus: {} },
      }),
    );
    expect(readRotateFile(dir)).toEqual({ install: { after_compactions: 4 } });
    fs.writeFileSync(rotateFilePath(dir), "{not json");
    expect(readRotateFile(dir)).toEqual({});
  });
});

describe("values from the command line", () => {
  it("parses numbers, never and booleans", () => {
    expect(parseRotateValue("after_compactions", "4")).toBe(4);
    expect(parseRotateValue("after_compactions", "never")).toBe("never");
    expect(parseRotateValue("after_compactions", "0")).toBe("never");
    expect(parseRotateValue("on_pr_merged", "false")).toBe(false);
    expect(parseRotateValue("on_due", "ask")).toBe("ask");
    expect(
      checkRotateValue(
        "after_compactions",
        parseRotateValue("after_compactions", "x"),
      ),
    ).toMatch(/got "x"/);
  });
});
