/**
 * Issue 482: /terminals is agents.html with the Terminals page id and
 * title; an older /agents?terminal=1 link lands there.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  terminalsPageHtml,
  terminalsRedirect,
} from "../../../src/ui/server/terminals-page.js";

const AGENTS = fs.readFileSync(
  path.join(__dirname, "../../../src/ui/server/public/agents.html"),
  "utf-8",
);

describe("issue 482: the Terminals page", () => {
  it("is agents.html with page id terminal and the title Terminals", () => {
    const html = terminalsPageHtml(AGENTS);
    expect(html).toContain('<div id="den-shell" data-page="terminal"');
    expect(html).toContain("· Terminals</title>");
    expect(html).not.toContain('data-page="agents"');
  });
  it("throws when agents.html's markers are gone", () => {
    expect(() => terminalsPageHtml("<html></html>")).toThrow(/markers/);
  });
  it("an old Terminal link on Agents lands on Terminals, query kept", () => {
    expect(
      terminalsRedirect(new URLSearchParams("terminal=1&project=north")),
    ).toBe("/terminals?terminal=1&project=north");
    expect(terminalsRedirect(new URLSearchParams("open=a,b"))).toBeNull();
  });
});
