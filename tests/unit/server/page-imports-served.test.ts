/**
 * Issue 750's red CI: agents-page.js imported a new module (/agent-groups.js)
 * the server didn't serve, so the import failed and the whole agents page
 * died. Every module a page's script imports by URL ("/x.js", "/kit/x.js")
 * must be one Den serves (UI_MODULES, KIT_FILES).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { KIT_FILES, UI_MODULES } from "../../../src/ui/server/ui-assets.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/** A file served by a route of its own (index.ts: /workspace-picker.js). */
const ownRoute = (u: string) =>
  ROUTES.some((r) => r.path === u && r.methods.includes("GET"));

function importsIn(src: string): string[] {
  return [
    ...src.matchAll(
      /^\s*(?:import|export)\b[^;]*?\bfrom\s+"((?:\/|\.\/)[^"]+)"/gm,
    ),
    ...src.matchAll(/^\s*import\s+"((?:\/|\.\/)[^"]+)"/gm),
  ].map((m) => (m[1]!.startsWith("./") ? m[1]!.slice(1) : m[1]!));
}

function importsOf(file: string): string[] {
  return importsIn(fs.readFileSync(path.join(PUBLIC, file), "utf-8"));
}

describe("every page module's URL imports are served", () => {
  const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".js"));

  it("finds the agents page's imports, the By group view's among them", () => {
    expect(importsOf("agents-page.js")).toEqual(
      expect.arrayContaining(["/agent-groups.js", "/kit/busy.js"]),
    );
  });

  it("reads a relative ./x.js import as the served /x.js", () => {
    expect(
      importsIn(
        'import { a } from "./settings-common.js";\nimport "./settings-ui-hub.js";\nexport { b } from "/kit/busy.js";\n',
      ),
    ).toEqual(["/settings-common.js", "/kit/busy.js", "/settings-ui-hub.js"]);
  });

  it("each /x.js is in UI_MODULES; each /kit/x in KIT_FILES", () => {
    const missing: string[] = [];
    for (const f of files)
      for (const u of importsOf(f)) {
        if (u.startsWith("/kit/")) {
          if (!KIT_FILES.includes(u.slice("/kit/".length)))
            missing.push(`${f}: ${u}`);
        } else if (!UI_MODULES.includes(u) && !ownRoute(u))
          missing.push(`${f}: ${u}`);
      }
    expect(missing).toEqual([]);
  });
});
