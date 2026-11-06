/**
 * The SETTINGS registry covers every setting (R21, 0.3.0-dev.19).
 *
 * The inventory: every key `POST /api/settings` accepts, read from the
 * handler itself (the top-level `body.<key>` it reads, and for the blocks
 * it merges, the keys their prefs modules know), must have a row in Den's
 * registry (settings-registry.js) whose `keys` name it. A key the server
 * accepts with no row fails here, so no setting can be added to the API
 * without the Settings page showing it.
 *
 * The rules: every row has a scope (user, workspace or distribution); a
 * distribution row is read-only (no write); every row's category exists.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { APPEARANCE_DEFAULTS } from "../../../src/ui/server/appearance-prefs.js";
import { GRAPH_DEFAULTS } from "../../../src/ui/server/graph-prefs.js";
import { SHELL_DEFAULTS } from "../../../src/ui/server/shell-prefs.js";
import { switchPrefs } from "../../../src/ui/server/switch-prefs.js";
import {
  DEN_SETTINGS,
  DEN_SETTING_CATEGORIES,
} from "../../../src/ui/server/public/settings-registry.js";

const INDEX = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "index.ts"),
  "utf-8",
);

/** The blocks POST merges as a whole, and the module that knows their keys. */
const BLOCKS: Record<string, Record<string, unknown>> = {
  graph: GRAPH_DEFAULTS as unknown as Record<string, unknown>,
  appearance: APPEARANCE_DEFAULTS as unknown as Record<string, unknown>,
  shell: SHELL_DEFAULTS as unknown as Record<string, unknown>,
  switching: switchPrefs(undefined) as unknown as Record<string, unknown>,
};

/** Every key POST /api/settings accepts, from its handler's source. */
function acceptedKeys(source: string): string[] {
  const start = source.indexOf('if (pathname === "/api/settings") {');
  expect(start).toBeGreaterThan(0);
  const post = source.indexOf('if (req.method === "POST") {', start);
  // The handler ends where the next route begins.
  const end = source.indexOf("// ── API:", post);
  const handler = source.slice(post, end);
  const top = [
    ...new Set([...handler.matchAll(/\bbody\.([a-z_]+)/g)].map((m) => m[1])),
  ];
  expect(top.length).toBeGreaterThan(0);
  return top.flatMap((k) =>
    BLOCKS[k] ? Object.keys(BLOCKS[k]).map((sub) => `${k}.${sub}`) : [k],
  );
}

/** The accepted keys with no registry row naming them. */
function unregistered(
  accepted: string[],
  rows: readonly { keys?: string[] }[],
): string[] {
  const covered = new Set(rows.flatMap((r) => r.keys ?? []));
  return accepted.filter((k) => !covered.has(k));
}

describe("the settings inventory (R21)", () => {
  const accepted = acceptedKeys(INDEX);

  it("reads every key POST /api/settings accepts from the handler", () => {
    expect(accepted.sort()).toEqual(
      [
        "appearance.mode",
        "appearance.theme",
        "editor",
        "editor_overrides",
        "graph.density",
        "graph.direction",
        "graph.group",
        "graph.groupBy",
        "graph.panelWidth",
        "graph.workspaces",
        // The UI's language (R19, 0.3.0-dev.39).
        "language",
        "shell.collapsed",
        "shell.dock",
        "shell.dockHeight",
        "shell.hidden",
        "shell.order",
        "shell.pins",
        // WS-6.10 (0.4.3): what picking a workspace does, and Stop & Switch's ask.
        "switching.confirm_stop_switch",
        "switching.on_pick",
        "terminal",
      ].sort(),
    );
  });

  it("every accepted key has a registry row", () => {
    expect(unregistered(accepted, DEN_SETTINGS)).toEqual([]);
  });

  it("catches a key the server accepts with no row", () => {
    // A deliberately unregistered key: the check names it.
    expect(unregistered([...accepted, "graph.zoom"], DEN_SETTINGS)).toEqual([
      "graph.zoom",
    ]);
    // And dropping a row uncovers its keys.
    expect(
      unregistered(
        accepted,
        DEN_SETTINGS.filter((r) => r.id !== "terminal"),
      ),
    ).toEqual(["terminal"]);
  });

  it("no row claims a key the server does not accept", () => {
    const known = new Set(accepted);
    const claimed = DEN_SETTINGS.flatMap((r) => r.keys ?? []);
    expect(claimed.filter((k) => !known.has(k))).toEqual([]);
  });
});

describe("the registry's rules", () => {
  it("every row has a scope: user, workspace or distribution", () => {
    const bad = DEN_SETTINGS.filter(
      (r) => !["user", "workspace", "distribution"].includes(r.scope),
    ).map((r) => r.id);
    expect(bad).toEqual([]);
  });

  it("a distribution row is read-only: it has no write", () => {
    const dist = DEN_SETTINGS.filter((r) => r.scope === "distribution");
    expect(dist.length).toBeGreaterThan(0);
    expect(
      dist
        .filter((r) => "write" in r && r.write !== undefined)
        .map((r) => r.id),
    ).toEqual([]);
  });

  it("only rows that store an /api/settings key or a workspace's settings write", () => {
    for (const r of DEN_SETTINGS) {
      const writes = "write" in r && typeof r.write === "function";
      const stores = (("keys" in r && r.keys) || []).length > 0;
      expect([r.id, writes]).toEqual([r.id, stores || r.scope === "workspace"]);
    }
  });

  it("every row is complete and in a category that exists", () => {
    const cats = new Set(DEN_SETTING_CATEGORIES.map((c) => c.id));
    const ids = new Set<string>();
    for (const r of DEN_SETTINGS) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      expect(cats.has(r.category)).toBe(true);
      expect(typeof r.label).toBe("string");
      expect(r.description.length).toBeGreaterThan(10);
      expect(Array.isArray(r.keywords)).toBe(true);
      expect(typeof r.read).toBe("function");
      expect(typeof r.control.type).toBe("string");
    }
  });

  it("the shell refuses a distribution row with a write, or an unknown scope", () => {
    const shell = fs.readFileSync(
      path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
      "utf-8",
    );
    expect(shell).toMatch(
      /scope === "distribution" && r\.write\)\s*throw new Error/,
    );
    expect(shell).toMatch(
      /var SCOPES = \["user", "workspace", "distribution"\]/,
    );
  });
});
