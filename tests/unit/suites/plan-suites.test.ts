import { describe, expect, it } from "@jest/globals";
import { planSuites, suiteRefusal } from "../../../src/pillars/suites/run.js";

const repo = (name: string, tests: object, extra: object = {}) => ({
  address: `${name}/web`,
  repo: name,
  service: "web",
  repoPath: `/src/${name}`,
  org: "Acme",
  isEntrypoint: true,
  config: undefined,
  manifest: {
    name,
    entrypoint: "web",
    services: {
      web: { health: { local: { url: `https://local.${name}.test/readyz` } } },
    },
    tests,
    ...extra,
  },
});

describe("suiteRefusal", () => {
  it("runs on local by default and never on prod", () => {
    expect(suiteRefusal({ cmd: "x" }, "local")).toBeNull();
    expect(suiteRefusal({ cmd: "x" }, "beta")).toMatch(/local only/);
    expect(
      suiteRefusal({ cmd: "x", environments: ["beta"] }, "beta"),
    ).toBeNull();
    expect(
      suiteRefusal({ cmd: "x", environments: ["prod"] as never }, "prod"),
    ).toMatch(/never/);
  });
});

describe("planSuites", () => {
  const services = [
    repo("shop", {
      test: { cmd: "make test" },
      smoke: { cmd: "make smoke", environments: ["local", "beta"] },
      escape: { cmd: "make x", cwd: "../../etc" },
    }),
    // A second service of the same repo must not repeat its suites.
    { ...repo("shop", { test: { cmd: "make test" } }), service: "api" },
    repo("blog", { lint: { cmd: "npm run lint", cwd: "web" } }),
  ];

  it("plans every suite once, from the checkout, with the entrypoint URL", () => {
    const { run, skipped } = planSuites(services, "local");
    expect(run.map((s) => [s.id, s.cwd, s.baseUrl])).toEqual([
      ["shop/test", "/src/shop", "https://local.shop.test/"],
      ["shop/smoke", "/src/shop", "https://local.shop.test/"],
      ["blog/lint", "/src/blog/web", "https://local.blog.test/"],
    ]);
    expect(skipped).toEqual([
      { id: "shop/escape", why: "cwd leaves the checkout" },
    ]);
  });

  it("skips suites not declared for the env, and narrows by id or repo", () => {
    const beta = planSuites(services, "beta");
    expect(beta.run.map((s) => s.id)).toEqual(["shop/smoke"]);
    expect(
      planSuites(services, "local", ["blog"]).run.map((s) => s.id),
    ).toEqual(["blog/lint"]);
  });
});
