/**
 * Issue 526: Settings' Hub GitHub rows and the "can't see" list. An org
 * Hub couldn't check says so, with Check again and never a link (even
 * when Hub sends one); Hub's reason is text, never HTML. Org names match
 * whatever their case. Pure; the browser test shows the real page.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readCoverage } from "../../../src/shared/hub-project-sync.js";

const tt = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;
const mod = () =>
  import("../../../src/ui/server/public/settings-registry.js") as Promise<{
    hubGithubHtml: (b: unknown, t: typeof tt) => string;
    hubUncoveredHtml: (list: unknown, t: typeof tt) => string;
  }>;
const fixture = (f: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "fixtures", "hub-coverage", f),
      "utf-8",
    ),
  ) as Record<string, unknown>;

/** The <p> for one org. */
const rowOf = (html: string, org: string) =>
  html.match(new RegExp(`<p [^>]*data-hubgh-org="${org}"[^]*?</p>`))?.[0] ?? "";

describe("hubGithubHtml (issue 526)", () => {
  it("Hub's sample: the error org shows the couldn't-check line and Check again, no link", async () => {
    const { hubGithubHtml } = await mod();
    const html = hubGithubHtml(
      { connected: true, orgs: readCoverage(fixture("github.json")) },
      tt,
    );
    const row = rowOf(html, "initech");
    expect(row).toContain('data-hubgh-access="error"');
    expect(row).toContain("[hubgh.error:initech|GitHub answered 503]");
    expect(row).toContain("data-hubgh-retry");
    expect(row).toContain("[hubgh.retry]");
    expect(row).not.toMatch(/<a |href=/);
    // The others keep their links.
    expect(rowOf(html, "acme-labs")).toContain("data-hubgh-open");
    expect(rowOf(html, "globex")).toContain("data-hubgh-open");
    expect(rowOf(html, "acme")).not.toContain("data-hubgh-open");
  });

  it("an error org with an install_url still shows no link", async () => {
    const { hubGithubHtml } = await mod();
    const html = hubGithubHtml(
      {
        connected: true,
        orgs: [
          {
            org: "initech",
            access: "error",
            error: "GitHub didn't answer",
            installUrl: "https://github.com/apps/den-hub/installations/new",
            manageUrl:
              "https://github.com/organizations/initech/settings/installations/9",
          },
        ],
      },
      tt,
    );
    expect(html).not.toMatch(/<a |href=|data-hubgh-open/);
    expect(html).toContain("data-hubgh-retry");
  });

  it("no reason: the line without one; a reason is text, never HTML", async () => {
    const { hubGithubHtml } = await mod();
    expect(
      hubGithubHtml(
        { connected: true, orgs: [{ org: "initech", access: "error" }] },
        tt,
      ),
    ).toContain("[hubgh.errorNoReason:initech]");
    const html = hubGithubHtml(
      {
        connected: true,
        orgs: [
          {
            org: "initech",
            access: "error",
            error: '<img src=x onerror="alert(1)">',
          },
        ],
      },
      tt,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("none with only a manage link offers Change repos", async () => {
    const { hubGithubHtml } = await mod();
    const html = hubGithubHtml(
      {
        connected: true,
        orgs: [
          {
            org: "globex",
            access: "none",
            covered: 0,
            total: 2,
            manageUrl:
              "https://github.com/organizations/Globex/settings/installations/7",
          },
        ],
      },
      tt,
    );
    expect(html).toContain(
      'href="https://github.com/organizations/Globex/settings/installations/7"',
    );
    expect(html).toContain("[hubgh.change]");
  });
});

describe("hubUncoveredHtml (issue 526)", () => {
  it("Acme-Labs and acme-labs are one org: one button", async () => {
    const { hubUncoveredHtml } = await mod();
    const html = hubUncoveredHtml(
      [
        {
          workspace: "w",
          repo: "Acme-Labs/Widget-API",
          org: "Acme-Labs",
          installUrl:
            "https://github.com/organizations/Acme-Labs/settings/installations/1",
        },
        {
          workspace: "w",
          repo: "acme-labs/other",
          org: "acme-labs",
          installUrl:
            "https://github.com/organizations/Acme-Labs/settings/installations/1",
        },
      ],
      tt,
    );
    expect(html.match(/data-hubp-give=/g)).toHaveLength(1);
    expect(html).toContain("[hubp.cantSee:Acme-Labs/Widget-API]");
  });
});
