/**
 * H5: Den Hub's GitHub access (GITHUB-COVERAGE-API.md).
 *
 * Settings › Distribution and Settings › Agents show, per org, what Den Hub
 * can read (all, N of M, none), live from Hub, with GitHub's link: "Give
 * Den Hub access" when none, "Change repos" when some. Coming back to the
 * page with ?hub=installed sends the projects to Hub again and redraws, so
 * the org reads "all repos" with no other step. A link that isn't https
 * github.com is never drawn.
 *
 * Project setup › Hub project: each repo Hub can't see, with one button per
 * org; after the install (the next answer) the line is gone.
 *
 * Hub is faked at Den's own routes (/api/hub/github, /api/hub/sync,
 * /api/workspaces/…/hub-project). Invented org names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;
const INSTALL = "https://github.com/apps/den-hub/installations/new?state=abc";
const MANAGE =
  "https://github.com/organizations/acme-co/settings/installations/9";

const json = (r: Route, b: unknown) =>
  r.fulfill({ contentType: "application/json", body: JSON.stringify(b) });

async function open(
  path: string,
  routes: Record<string, (r: Route) => unknown>,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 375, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  for (const [glob, fn] of Object.entries(routes)) await p.route(glob, fn);
  await p.goto(signInUrl(s!.stateDir, s!.base, path));
  return p;
}

const sel = (id: string) => `[data-setting="${id}"] [data-hubgh]`;

describe("Den Hub's GitHub access (H5)", () => {
  it("Distribution: no access → the install button; back with ?hub=installed → all repos", async () => {
    if (skip()) return;
    let installed = false;
    let syncs = 0;
    const p = await open("/settings#distribution", {
      "**/api/hub/github": (r) =>
        json(r, {
          connected: true,
          orgs: [
            installed
              ? { org: "acme-co", access: "all", covered: 2, total: 2 }
              : {
                  org: "acme-co",
                  access: "none",
                  covered: 0,
                  total: 2,
                  installUrl: INSTALL,
                },
          ],
        }),
      "**/api/hub/sync": (r) => {
        syncs++;
        return json(r, { ok: true, last: null });
      },
    });
    await p.waitForSelector(sel("distribution.hub_github"));
    const row = `[data-setting="distribution.hub_github"]`;
    expect(
      await p.getAttribute(
        `${row} [data-hubgh-org="acme-co"]`,
        "data-hubgh-access",
      ),
    ).toBe("none");
    expect(await p.textContent(`${row} [data-hubgh-open]`)).toBe(
      "Give Den Hub access",
    );
    expect(await p.getAttribute(`${row} [data-hubgh-open]`, "href")).toBe(
      INSTALL,
    );
    expect(syncs).toBe(0);

    installed = true;
    await p.goto(
      signInUrl(s!.stateDir, s!.base, "/settings?hub=installed#distribution"),
    );
    await p.waitForSelector(`${row} [data-hubgh-access="all"]`);
    expect(syncs).toBe(1);
    expect(await p.textContent(`${row} [data-hubgh-org]`)).toContain(
      "all repos",
    );
    expect(await p.$(`${row} [data-hubgh-open]`)).toBeNull();
  }, 60_000);

  it("Agents › Hub's row: some repos → Change repos; a non-GitHub link is never drawn", async () => {
    if (skip()) return;
    const p = await open("/settings#agents", {
      "**/api/hub/github": (r) =>
        json(r, {
          connected: true,
          orgs: [
            {
              org: "acme-co",
              access: "some",
              covered: 1,
              total: 3,
              manageUrl: MANAGE,
            },
            {
              org: "other-co",
              access: "none",
              covered: 0,
              total: 1,
              installUrl: "https://phish.example/x",
            },
          ],
        }),
    });
    await p.waitForSelector(sel("agents.hub_github"));
    const row = `[data-setting="agents.hub_github"]`;
    expect(await p.textContent(`${row} [data-hubgh-org="acme-co"]`)).toContain(
      "1 of 3 repos",
    );
    expect(
      await p.getAttribute(
        `${row} [data-hubgh-org="acme-co"] [data-hubgh-open]`,
        "href",
      ),
    ).toBe(MANAGE);
    expect(
      await p.textContent(
        `${row} [data-hubgh-org="acme-co"] [data-hubgh-open]`,
      ),
    ).toBe("Change repos");
    expect(
      await p.$(`${row} [data-hubgh-org="other-co"] [data-hubgh-open]`),
    ).toBeNull();
  }, 60_000);

  it("Project setup: the repo Hub can't see and its org's button; after the install the line is gone", async () => {
    if (skip()) return;
    let installed = false;
    const p = await open("/settings?ws=north#workspace", {
      "**/api/workspaces/*/hub-project": (r) =>
        json(r, {
          ok: true,
          project: "north",
          hub: null,
          connected: true,
          suggestions: [],
          projects: [],
          uncovered: installed
            ? []
            : [
                {
                  workspace: "north",
                  repo: "acme-co/web",
                  org: "acme-co",
                  installUrl: INSTALL,
                },
              ],
        }),
    });
    await p.waitForSelector('[data-setting="workspace.hub"] [data-hubp]');
    expect(await p.textContent('[data-hubp-unseen="acme-co/web"]')).toContain(
      "Den Hub can't see acme-co/web.",
    );
    expect(await p.textContent('[data-hubp-give="acme-co"]')).toBe(
      "Give Den Hub access to acme-co",
    );
    expect(await p.getAttribute('[data-hubp-give="acme-co"]', "href")).toBe(
      INSTALL,
    );
    installed = true;
    await p.reload();
    await p.waitForSelector('[data-setting="workspace.hub"] [data-hubp]');
    expect(await p.$("[data-hubp-uncovered]")).toBeNull();
  }, 60_000);

  it("in Spanish, the row is Spanish", async () => {
    if (skip()) return;
    const p = await open("/settings#distribution", {
      "**/api/hub/github": (r) =>
        json(r, {
          connected: true,
          orgs: [
            {
              org: "acme-co",
              access: "none",
              covered: 0,
              total: 2,
              installUrl: INSTALL,
            },
          ],
        }),
    });
    await p.evaluate(() =>
      (
        window as unknown as {
          denShell: {
            api: (m: string, u: string, b: unknown) => Promise<unknown>;
          };
        }
      ).denShell.api("POST", "/api/settings", { language: "es" }),
    );
    await p.reload();
    await p.waitForSelector(sel("distribution.hub_github"));
    expect(
      await p.textContent(
        '[data-setting="distribution.hub_github"] [data-hubgh-open]',
      ),
    ).toBe("Dar acceso a Den Hub");
    await p.evaluate(() =>
      (
        window as unknown as {
          denShell: {
            api: (m: string, u: string, b: unknown) => Promise<unknown>;
          };
        }
      ).denShell.api("POST", "/api/settings", { language: null }),
    );
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
