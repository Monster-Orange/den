import { describe, expect, it, jest } from "@jest/globals";
import { autoSecurityTargets } from "../../../src/pillars/security/discover.js";
import {
  EXIT_CLEAN,
  EXIT_INFRA_ERROR,
  runSecurityCli,
  type EntrypointDeps,
} from "../../../src/pillars/security/run.js";
import { readSecurityAutoTargets } from "../../../src/shared/den-config.js";
import type { WorkspaceService } from "../../../src/shared/manifest/workspace-manifests.js";
import type { DenConfig } from "../../../src/shared/den-config.js";

const svc = (
  repo: string,
  service: string,
  config: WorkspaceService["config"],
): WorkspaceService => ({
  address: `${repo}/${service}`,
  repo,
  service,
  repoPath: `/x/${repo}`,
  org: "Acme",
  manifest: { name: repo, services: { [service]: config ?? {} } },
  config,
  isEntrypoint: true,
});
const up = { commands: { local: { up: "make up" } } };

describe("readSecurityAutoTargets", () => {
  it("is off unless the org config says true", () => {
    expect(readSecurityAutoTargets({} as DenConfig)).toBe(false);
    expect(
      readSecurityAutoTargets({
        security: { auto_targets: "yes" },
      } as unknown as DenConfig),
    ).toBe(false);
    expect(
      readSecurityAutoTargets({
        security: { auto_targets: true },
      } as DenConfig),
    ).toBe(true);
  });
});

describe("autoSecurityTargets", () => {
  const services = [
    svc("shop", "web", {
      ...up,
      health: {
        local: { url: "https://local.shop.example.test/readyz" },
        beta: { url: "https://beta.shop.example.test/readyz" },
      },
    }),
    // No local runtime: deployed elsewhere, never an automatic target.
    svc("core", "api", {
      health: { local: { url: "https://api.dev.example.test/health" } },
    }),
    svc("shop", "db", {
      ...up,
      health: { local: { type: "shell", cmd: "true" } },
    }),
    svc("blog", "web", {
      ...up,
      health: { local: { url: "https://local.blog.example.test/" } },
      security: { skip: true },
    }),
    svc("docs", "web", {
      ...up,
      health: { local: { url: "https://local.docs.example.test/" } },
    }),
  ];
  const declared = [
    {
      repoName: "docs",
      repoPath: "/x/docs",
      serviceName: "web",
      config: { baseUrlKey: "web" as const },
    },
  ];

  it("adds only locally run, HTTP-checked, unlisted services, at the health origin", () => {
    const got = autoSecurityTargets(services, declared);
    expect(got).toEqual([
      {
        repoName: "shop",
        repoPath: "/x/shop",
        serviceName: "web",
        config: {
          hosts: {
            local: ["https://local.shop.example.test/"],
            beta: ["https://beta.shop.example.test/"],
          },
        },
        auto: true,
      },
    ]);
  });
});

describe("runSecurityCli with auto targets", () => {
  const deps = (
    targets: ReturnType<typeof autoSecurityTargets>,
  ): { deps: EntrypointDeps; logs: string[]; errors: string[] } => {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
      logs,
      errors,
      deps: {
        discoverTargets: () => targets,
        ownedHosts: () => ["shop.example.test"],
        loadEnvironment: async () => ({ baseUrls: {} }) as never,
        getToken: jest.fn<EntrypointDeps["getToken"]>(),
        runZap: jest.fn<EntrypointDeps["runZap"]>(),
        mkdirp: () => {},
        readFileIfExists: () => undefined,
        writeFile: () => {},
        writeResult: async () => {},
        reportsRoot: "/reports/security",
        now: () => new Date("2026-11-03T00:00:00.000Z"),
        log: (m) => logs.push(m),
        logError: (m) => errors.push(m),
      },
    };
  };
  const auto = (url: string) => ({
    repoName: "shop",
    repoPath: "/x/shop",
    serviceName: "web",
    config: { hosts: { local: [url] } },
    auto: true as const,
  });

  it("lists auto-derived targets in a dry run before anything runs", async () => {
    const h = deps([auto("https://local.shop.example.test/")]);
    expect(await runSecurityCli(["--env=local", "--dry-run"], h.deps)).toBe(
      EXIT_CLEAN,
    );
    expect(h.logs.join("\n")).toMatch(
      /\[dry-run\] shop\/web .*\(auto: health URL\)/,
    );
    expect(h.deps.runZap).not.toHaveBeenCalled();
  });

  it("still refuses an auto target outside the owned hosts", async () => {
    const h = deps([auto("https://elsewhere.example.org/")]);
    expect(await runSecurityCli(["--env=local", "--dry-run"], h.deps)).toBe(
      EXIT_INFRA_ERROR,
    );
    expect(h.errors.join()).toMatch(/not an owned host/);
  });
});
