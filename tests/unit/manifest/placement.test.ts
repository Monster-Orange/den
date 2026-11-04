import { describe, expect, it } from "@jest/globals";
import {
  expectMatches,
  isProtectedRemote,
  placementErrors,
  placementRefusal,
  placementSuffix,
  repoPlacement,
  resolveHealthCheck,
  rollupPlacement,
  servicePlacement,
  targetLabel,
} from "../../../src/shared/manifest/placement.js";
import type { RawManifest } from "../../../src/shared/types/index.js";

// The hybrid case R13 came from: the frontend runs here, the backend is the
// team's dev deployment, which the local frontend calls.
const hybrid: RawManifest = {
  name: "shop",
  services: {
    web: {
      commands: { local: { up: "make up", down: "make down" } },
      health: { local: { url: "https://shop.acme.localhost/healthz" } },
    },
    core: {
      runs: { local: "remote", dev: "remote" },
      target: {
        env: "dev",
        account: "AWS",
        url: "https://api.dev.acme.example/admin/manifest",
        expect: 401,
      },
      commands: { local: { seed: "make seed" } },
      health: { dev: { url: "https://api.dev.acme.example/health" } },
    },
    edge: {
      runs: { local: "remote" },
      target: { env: "dev", url: "https://edge.dev.acme.example/" },
    },
  },
};

// A repo nothing here starts: no local commands and no compose.
const standalone: RawManifest = {
  name: "ops",
  services: {
    worker: {},
    cloud: {
      health: { local: { url: "https://cloud.acme.example/health" } },
    },
    db: { health: { local: { type: "shell", cmd: "pg_isready" } } },
  },
};

const prod = (env: string) => env === "prod" || env === "production";

describe("servicePlacement", () => {
  it("is local for a service with local commands (the default)", () => {
    expect(servicePlacement(hybrid, "web", "local")).toEqual({
      runs: "local",
      target: null,
    });
  });

  it("is local for every service of a repo whose up runs locally", () => {
    // One repo-level up starts the whole stack: the other services declare
    // no commands of their own, some only a health URL on the local edge.
    const repo: RawManifest = {
      name: "shop",
      services: {
        web: {
          commands: { local: { up: "make up", down: "make down" } },
          health: { local: { url: "https://shop.acme.localhost/healthz" } },
        },
        mailpit: { health: { local: { url: "https://mail.acme.localhost/" } } },
        db: { health: { local: { type: "shell", cmd: "true" } } },
      },
    } as RawManifest;
    expect(servicePlacement(repo, "mailpit", "local")).toEqual({
      runs: "local",
      target: null,
    });
    expect(servicePlacement(repo, "db", "local")).toEqual({
      runs: "local",
      target: null,
    });
    // Another env still stands for itself.
    expect(servicePlacement(repo, "mailpit", "dev").runs).toBe("none");
  });

  it("is local for any service of a compose repo", () => {
    const m: RawManifest = {
      name: "stack",
      compose: {},
      services: { api: {}, db: {} },
    };
    expect(servicePlacement(m, "db", "local").runs).toBe("local");
  });

  it("follows an explicit runs value, with the manifest's target", () => {
    expect(servicePlacement(hybrid, "core", "local")).toEqual({
      runs: "remote",
      target: {
        env: "dev",
        account: "AWS",
        url: "https://api.dev.acme.example/admin/manifest",
        expect: 401,
      },
    });
  });

  it("carries expect only with the target's own url (F4)", () => {
    expect(servicePlacement(hybrid, "edge", "local").target).toEqual({
      env: "dev",
      url: "https://edge.dev.acme.example/",
    });
  });

  it("explicit remote wins over local commands", () => {
    expect(servicePlacement(hybrid, "core", "local").runs).toBe("remote");
  });

  it("is remote by default with a health URL and no commands", () => {
    expect(servicePlacement(standalone, "cloud", "local")).toEqual({
      runs: "remote",
      target: { env: "local", url: "https://cloud.acme.example/health" },
    });
  });

  it("is none with no commands, compose or health URL", () => {
    expect(servicePlacement(standalone, "worker", "local")).toEqual({
      runs: "none",
      target: null,
    });
    // A shell check is not a health URL.
    expect(servicePlacement(standalone, "db", "local").runs).toBe("none");
    expect(servicePlacement(standalone, "missing", "local").runs).toBe("none");
    expect(servicePlacement(null, "web", "local").runs).toBe("none");
  });

  it("uses the viewed env: remote in dev, where the target is", () => {
    expect(servicePlacement(hybrid, "core", "dev")).toEqual({
      runs: "remote",
      target: {
        env: "dev",
        account: "AWS",
        url: "https://api.dev.acme.example/admin/manifest",
        expect: 401,
      },
    });
  });

  it("a manifest target for another env is not borrowed", () => {
    const m: RawManifest = {
      name: "shop",
      services: {
        core: {
          runs: { local: "remote", staging: "remote" },
          target: { env: "dev" },
          health: { staging: { url: "https://api.staging.acme.example/" } },
        },
      },
    };
    expect(servicePlacement(m, "core", "staging").target).toEqual({
      env: "staging",
      url: "https://api.staging.acme.example/",
    });
  });
});

describe("resolveHealthCheck", () => {
  it("a local service keeps its own env's check", () => {
    const h = resolveHealthCheck(hybrid, "web", "local", null);
    // The declaration itself, unchanged.
    expect(h.check).toEqual({ url: "https://shop.acme.localhost/healthz" });
    expect(h.expect).toBeUndefined();
    expect(h.label).toBeUndefined();
  });

  it("falls back to the compose shell check locally", () => {
    const h = resolveHealthCheck(
      { name: "stack", compose: {}, services: { api: {} } },
      "api",
      "local",
      "acme stack health stack",
    );
    expect(h.check).toEqual({ type: "shell", cmd: "acme stack health stack" });
  });

  it("a remote service uses its health declaration for target.env", () => {
    const h = resolveHealthCheck(hybrid, "core", "local", "unused");
    expect(h.check).toEqual({ url: "https://api.dev.acme.example/health" });
    // The declared check keeps its own status rules; expect is for target.url.
    expect(h.expect).toBeUndefined();
    expect(h.label).toBe("dev · AWS");
  });

  it("probes target.url when target.env has no health declaration", () => {
    const h = resolveHealthCheck(hybrid, "edge", "local", "unused");
    expect(h.check).toEqual({
      type: "http",
      url: "https://edge.dev.acme.example/",
    });
    expect(h.expect).toBe("2xx");
    expect(h.label).toBe("dev");
  });

  it("target.expect is passed on as a list of codes", () => {
    const m: RawManifest = {
      name: "shop",
      services: {
        core: {
          runs: { local: "remote" },
          target: {
            env: "dev",
            url: "https://api.dev.acme.example/",
            expect: [200, 401],
          },
        },
      },
    };
    expect(resolveHealthCheck(m, "core", "local", null).expect).toEqual([
      200, 401,
    ]);
    const one = resolveHealthCheck(hybrid, "core", "dev", null);
    // In dev the declaration for dev still wins over target.url.
    expect(one.check).toEqual({ url: "https://api.dev.acme.example/health" });
  });

  it("a remote service with no check and no url has none", () => {
    const m: RawManifest = {
      name: "shop",
      services: { core: { runs: { local: "remote" }, target: { env: "dev" } } },
    };
    expect(resolveHealthCheck(m, "core", "local", null).check).toBeUndefined();
  });
});

describe("expectMatches", () => {
  it("2xx by default", () => {
    expect(expectMatches(200, "2xx")).toBe(true);
    expect(expectMatches(204, "2xx")).toBe(true);
    expect(expectMatches(301, "2xx")).toBe(false);
    expect(expectMatches(401, "2xx")).toBe(false);
    expect(expectMatches(undefined, "2xx")).toBe(false);
  });
  it("only the listed codes otherwise", () => {
    expect(expectMatches(401, [401])).toBe(true);
    expect(expectMatches(200, [401])).toBe(false);
  });
});

describe("labels", () => {
  it("names the target", () => {
    expect(targetLabel({ env: "dev", account: "AWS" })).toBe("dev · AWS");
    expect(targetLabel({ env: "dev" })).toBe("dev");
  });
  it("suffix marks remote only", () => {
    expect(placementSuffix({ runs: "remote", target: { env: "dev" } })).toBe(
      "☁ remote (dev)",
    );
    expect(placementSuffix({ runs: "local", target: null })).toBe("");
    expect(placementSuffix({ runs: "none", target: null })).toBe("");
  });
});

describe("placementRefusal", () => {
  it("refuses a remote service, naming where it runs", () => {
    expect(
      placementRefusal(
        "shop/core",
        servicePlacement(hybrid, "core", "local"),
        prod,
      ),
    ).toBe("shop/core runs in dev (AWS); nothing to start here");
    expect(
      placementRefusal(
        "shop/core",
        servicePlacement(hybrid, "core", "local"),
        prod,
        "stop",
      ),
    ).toBe("shop/core runs in dev (AWS); nothing to stop here");
  });

  it("names the command that was refused (B4)", () => {
    const at = servicePlacement(hybrid, "core", "local");
    const say = (c: string) => placementRefusal("shop/core", at, prod, c);
    expect(say("up")).toBe(
      "shop/core runs in dev (AWS); nothing to start here",
    );
    expect(say("down")).toBe(
      "shop/core runs in dev (AWS); nothing to stop here",
    );
    expect(say("restart")).toBe(
      "shop/core runs in dev (AWS); nothing to restart here",
    );
    expect(say("exec")).toBe(
      'shop/core runs in dev (AWS); nothing to run "exec" on here',
    );
    expect(say("seed")).toBe(
      'shop/core runs in dev (AWS); nothing to run "seed" on here',
    );
  });

  it("says so when the target counts as production", () => {
    const msg = placementRefusal(
      "shop/core",
      { runs: "remote", target: { env: "prod" } },
      prod,
    );
    expect(msg).toMatch(/runs in prod; nothing to start here/);
    expect(msg).toMatch(/production/);
  });

  it("lets local and none through", () => {
    expect(
      placementRefusal("shop/web", { runs: "local", target: null }, prod),
    ).toBeNull();
    expect(
      placementRefusal("shop/x", { runs: "none", target: null }, prod),
    ).toBeNull();
  });
});

describe("isProtectedRemote", () => {
  it("is a remote service whose target env counts as production", () => {
    expect(
      isProtectedRemote({ runs: "remote", target: { env: "prod" } }, prod),
    ).toBe(true);
    expect(
      isProtectedRemote({ runs: "remote", target: { env: "dev" } }, prod),
    ).toBe(false);
    expect(isProtectedRemote({ runs: "local", target: null }, prod)).toBe(
      false,
    );
  });
});

describe("rollupPlacement", () => {
  const row = (
    repo: string,
    service: string,
    runs: "local" | "remote" | "none",
    env?: string,
  ) => ({ repo, service, runs, target: env ? { env } : null });

  it("hybrid, with a summary per repo", () => {
    expect(
      rollupPlacement([
        row("shop-frontend", "web", "local"),
        row("shop-core", "api", "remote", "dev"),
      ]),
    ).toEqual({
      placement: "hybrid",
      summary: "shop-frontend local · shop-core remote (dev)",
    });
  });

  it("all local, all remote, or none", () => {
    expect(rollupPlacement([row("a", "a", "local")]).placement).toBe("local");
    expect(
      rollupPlacement([
        row("a", "x", "remote", "dev"),
        row("a", "y", "remote", "staging"),
      ]),
    ).toEqual({ placement: "remote", summary: "a remote (dev, staging)" });
    expect(rollupPlacement([row("a", "a", "none")])).toEqual({
      placement: "none",
      summary: "",
    });
    expect(rollupPlacement([])).toEqual({ placement: "none", summary: "" });
  });

  it("none services do not make an app hybrid; a mixed repo is hybrid", () => {
    expect(
      rollupPlacement([row("a", "x", "local"), row("a", "y", "none")]),
    ).toEqual({ placement: "local", summary: "a local" });
    expect(
      rollupPlacement([row("a", "x", "local"), row("a", "y", "remote", "dev")]),
    ).toEqual({ placement: "hybrid", summary: "a hybrid (y remote (dev))" });
  });
});

describe("repoPlacement", () => {
  it("rolls a repo's services up", () => {
    expect(repoPlacement(hybrid, "local")).toEqual({
      placement: "hybrid",
      envs: ["dev"],
    });
    expect(
      repoPlacement(
        {
          name: "core",
          services: {
            api: { runs: { local: "remote" }, target: { env: "dev" } },
          },
        },
        "local",
      ),
    ).toEqual({ placement: "remote", envs: ["dev"] });
    expect(repoPlacement({ name: "lib" }, "local")).toEqual({
      placement: "none",
      envs: [],
    });
  });
});

describe("placementErrors", () => {
  const envs = ["local", "dev", "prod"];
  const m = (svc: Record<string, unknown>) => ({
    name: "shop",
    services: { core: svc },
  });

  it("accepts known envs", () => {
    expect(
      placementErrors(
        m({ runs: { local: "remote", dev: "remote" }, target: { env: "dev" } }),
        envs,
      ),
    ).toEqual([]);
  });

  it("an unknown env name in runs is an error", () => {
    expect(
      placementErrors(
        m({ runs: { local: "remote", qa: "remote" }, target: { env: "dev" } }),
        envs,
      ),
    ).toEqual([
      expect.objectContaining({
        path: "services.core.runs.qa",
        message: expect.stringMatching(/unknown environment "qa"/),
      }),
    ]);
  });

  it("target.env must be one of the org's environments", () => {
    expect(
      placementErrors(
        m({ runs: { local: "remote" }, target: { env: "staging" } }),
        envs,
      ),
    ).toEqual([
      expect.objectContaining({
        path: "services.core.target.env",
        message: expect.stringMatching(/unknown environment "staging"/),
      }),
    ]);
  });

  it("runs.local remote needs a target", () => {
    expect(placementErrors(m({ runs: { local: "remote" } }), envs)).toEqual([
      expect.objectContaining({ path: "services.core.target" }),
    ]);
  });

  it("ignores manifests without services", () => {
    expect(placementErrors({ name: "x" }, envs)).toEqual([]);
    expect(placementErrors(null, envs)).toEqual([]);
  });
});
