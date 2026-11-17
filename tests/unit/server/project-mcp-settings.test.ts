/**
 * Issue 335: Settings › Project › Agents' extra MCP servers
 * (settings-registry.js projectMcpHtml): one row per server, its name and
 * url only; none, a line that says so. Every word in English (shell.js),
 * Spanish and Japanese, and the Allow dialog's lines for project_mcp_add.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { enCatalog, installEnShell } from "./helpers/en-catalog.js";

type Row = Record<string, unknown>;
let projectMcpHtml: (v: unknown, t: (k: string, v?: Row) => string) => string;
let t: (k: string, v?: Row) => string;

beforeAll(async () => {
  installEnShell();
  t = (
    globalThis as unknown as {
      window: { denShell: { t: (k: string, v?: Row) => string } };
    }
  ).window.denShell.t;
  ({ projectMcpHtml } =
    await import("../../../src/ui/server/public/settings-registry.js"));
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("issue 335: the project's extra MCP servers in Settings", () => {
  it("one row per server, its name and url", () => {
    const html = projectMcpHtml(
      {
        servers: [
          { name: "tracker", url: "https://mcp.tracker.example.test" },
          { name: "wiki", url: "http://localhost:4999/mcp" },
        ],
      },
      t,
    );
    expect(text(html)).toBe(
      "tracker: https://mcp.tracker.example.test wiki: http://localhost:4999/mcp",
    );
    expect(html).toContain('data-pmcp="tracker"');
  });

  it("none: a line that says so", () => {
    expect(text(projectMcpHtml({ servers: [] }, t))).toBe(
      "No extra MCP servers for this project's agents.",
    );
  });

  const KEYS = [
    "set.workspace.mcp_servers",
    "set.workspace.mcp_servers.d",
    "pmcp.none",
    "pmcp.failed",
    "ap.do.project_mcp_add",
    "ap.mcp.warn",
    "ap.mcp.server",
    "ap.mcp.bearer",
    "ap.mcp.noBearer",
    "ap.mcp.next",
  ];
  const catalog = (lang: string): Record<string, string> => {
    const window: Record<string, unknown> = {};
    vm.runInContext(
      fs.readFileSync(
        path.join(process.cwd(), "src/ui/server/public/i18n", `${lang}.js`),
        "utf-8",
      ),
      vm.createContext({ window }),
    );
    return (window.denMessages as Record<string, Record<string, string>>)[lang];
  };

  it.each(["es", "ja"])("%s has each, translated", (lang) => {
    const en = enCatalog();
    const table = catalog(lang);
    for (const k of [...KEYS, "pmcp.row"])
      expect({ k, has: typeof table[k] }).toEqual({ k, has: "string" });
    for (const k of KEYS)
      expect({ k, same: table[k] === en[k] }).toEqual({ k, same: false });
  });
});
