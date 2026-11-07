/**
 * Unit tests for the shared health primitives in `environment-manager/health.ts`.
 *
 * Focus: the status-to-ok mapping. 3xx responses must not be treated as healthy
 * since `redirect: "manual"` means we see the redirect but never confirm the
 * destination. The VPN / /etc/hosts case where a hostname resolves to an AWS
 * ALB and returns 301 for unknown routes is the specific regression this
 * guards against.
 */

import { rollupReasonText } from "../../../src/ui/cli/health-display.js";
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  checkServiceHealth,
  pingHttp,
  pingShell,
  rollupRepoHealth,
  sortByRepoOrder,
  __setResolveHostForTests,
} from "../../../src/shared/environment-manager/health.js";
import type { ServiceHealthResult } from "../../../src/shared/environment-manager/health.js";

const originalFetch = global.fetch;
const tmpDirs: string[] = [];

type MockFetch = jest.MockedFunction<typeof fetch>;
let mockFetch: MockFetch;

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-health-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  mockFetch = jest.fn() as unknown as MockFetch;
  global.fetch = mockFetch as unknown as typeof fetch;
  // Identity resolver: pingOnce rewrites the URL's hostname to whatever this
  // returns, so returning the name unchanged leaves the URL exactly as the
  // caller wrote it. Keeps these assertions about fallback semantics rather
  // than about this machine's DNS, and stops the suite touching the network.
  __setResolveHostForTests(async (hostname: string) => hostname);
});

afterEach(() => {
  global.fetch = originalFetch;
  __setResolveHostForTests(null);
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mockResponse(status: number): Response {
  return { status } as Response;
}

describe("pingHttp — ok mapping by status", () => {
  it("returns ok=true for 200", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("returns ok=true for 204", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(204));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(true);
  });

  // A 301 from an AWS ALB (the regression) must never be green; since
  // MCP-2.4 it is a redirect (ok null, its status and target), not down.
  it("never ok for 301 — redirect from an AWS ALB (the regression): a redirect, ok null", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(301));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBeNull();
    expect(r.status).toBe(301);
    expect(r.redirect).toBe("(no Location header)");
  });

  it("a 302 is a redirect, ok null, not down", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(302));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBeNull();
    expect(r.status).toBe(302);
  });

  it("returns ok=true for 401 — service is up, just requires auth", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(true);
  });

  it("returns ok=true for 404 — service responded, route just doesn't exist", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(true);
  });

  it("returns ok=false for the edge's own 404 (no route: a stopped service behind Traefik)", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 404,
      text: async () => "404 page not found\n",
    } as unknown as Response);
    const r = await pingHttp("http://app.example.test/healthz");
    expect(r).toEqual({ ok: false, status: 404, error: "no route (edge 404)" });
  });

  it("returns ok=true for a service's own 404 body", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 404,
      text: async () => '{"error":"not found"}',
    } as unknown as Response);
    const r = await pingHttp("http://app.example.test/healthz");
    expect(r).toEqual({ ok: true, status: 404 });
  });

  it("returns ok=false for 500", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(500));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(false);
  });

  it("returns ok=false for 503", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(503));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(false);
  });
});

describe("pingHttp — localhost fallback for Docker hostnames", () => {
  it("retries on localhost when the first ping fails on a docker-style hostname", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ENOTFOUND tasks-runner"))
      .mockResolvedValueOnce(mockResponse(200));

    const r = await pingHttp("http://tasks-runner:8080/healthz");
    expect(r.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should target localhost with the same port AND the same
    // path/query (the fallback must ping the real endpoint, not the root).
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondUrl).toBe("http://localhost:8080/healthz");
  });

  it("does not retry when the hostname contains a dot (real DNS)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const r = await pingHttp("http://api.example.com/healthz");
    expect(r.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the hostname is already localhost", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await pingHttp("http://localhost:8080/healthz");
    expect(r.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on localhost even when the first ping timed out — VPN/hosts resolving a Docker name to an ALB on the wrong port produces exactly this", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    mockFetch
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(mockResponse(200));
    const r = await pingHttp("http://tasks-runner:8080/healthz");
    expect(r.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry for default-port-80 URLs — localhost:80 is whichever other container publishes 80", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND billing-api"));
    const r = await pingHttp("http://billing-api/healthz");
    expect(r.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no localhost fallback probe
  });

  it("treats a 4xx on the LOCALHOST FALLBACK as down — it may be a different service answering", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ENOTFOUND tokens"))
      .mockResolvedValueOnce(mockResponse(404)); // a stranger's 404 page on localhost
    const r = await pingHttp("http://tokens:8080/healthz");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fallback got non-2xx/);
  });
});

describe("pingHttp — name resolution happens before fetch", () => {
  it("reports error 'dns' without calling fetch when the name will not resolve", async () => {
    // Resolution failure is reported directly instead of handing a hostname to
    // fetch. fetch would call getaddrinfo, whose requests are uncancellable —
    // aborted lookups pile up on the libuv pool and eventually wedge every
    // lookup in the process (the bug this replaced: 84k pending lookups, every
    // check falsely reporting "timeout").
    __setResolveHostForTests(async () => null);
    const r = await pingHttp("http://gone-away/healthz");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("dns");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("connects to the resolved IP while preserving the Host header", async () => {
    // Connecting by IP is what keeps getaddrinfo out of the path; the Host
    // header keeps name-based routing working at the other end.
    __setResolveHostForTests(async () => "172.18.0.99");
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const r = await pingHttp("http://notes-api/healthz");
    expect(r.ok).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe("http://172.18.0.99/healthz");
    expect(
      (mockFetch.mock.calls[0][1] as RequestInit & { headers: object }).headers,
    ).toEqual({ Host: "notes-api" });
  });

  it("re-resolves per call so a restarted service's new IP is picked up", async () => {
    // Deliberately uncached: opctl containers take dynamic IPs, so a restart
    // can move a service. DNS stays authoritative.
    const ips = ["172.18.0.10", "172.18.0.44"];
    __setResolveHostForTests(async () => ips.shift() ?? null);
    mockFetch.mockResolvedValue(mockResponse(200));
    await pingHttp("http://shop-api/healthz");
    await pingHttp("http://shop-api/healthz");
    expect(mockFetch.mock.calls[0][0]).toBe("http://172.18.0.10/healthz");
    expect(mockFetch.mock.calls[1][0]).toBe("http://172.18.0.44/healthz");
  });

  it("does not resolve localhost or IP literals", async () => {
    __setResolveHostForTests(async () => {
      throw new Error("should not resolve");
    });
    mockFetch.mockResolvedValue(mockResponse(200));
    expect((await pingHttp("http://localhost:8080/healthz")).ok).toBe(true);
    expect((await pingHttp("http://127.0.0.1:9000/healthz")).ok).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8080/healthz");
    expect(mockFetch.mock.calls[1][0]).toBe("http://127.0.0.1:9000/healthz");
  });
});

describe("pingShell — repo-relative commands run in the service's cwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-pingshell-"));
    const scriptDir = path.join(tmpDir, "scripts", "orchestration");
    fs.mkdirSync(scriptDir, { recursive: true });
    const script = path.join(scriptDir, "health.sh");
    fs.writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
    fs.chmodSync(script, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a relative-path health script against the provided cwd (regression: exit 127)", async () => {
    const r = await pingShell(
      "./scripts/orchestration/health.sh ddb",
      {},
      tmpDir,
    );
    expect(r.ok).toBe(true);
  });

  it("fails when no cwd is provided and the relative script is not in process.cwd()", async () => {
    const r = await pingShell("./scripts/orchestration/health.sh ddb");
    expect(r.ok).toBe(false);
  });
});

describe("pingShell", () => {
  it("runs shell health commands from the provided cwd", async () => {
    const repoRoot = createTempRoot();
    fs.writeFileSync(path.join(repoRoot, "repo-relative-marker"), "", "utf-8");

    await expect(
      pingShell("test -f repo-relative-marker", {}, repoRoot),
    ).resolves.toEqual({ ok: true });
  });
});

describe("checkServiceHealth", () => {
  it("runs manifest shell health commands from the service repo root", async () => {
    const repoRoot = createTempRoot();
    fs.writeFileSync(path.join(repoRoot, "repo-relative-marker"), "", "utf-8");
    fs.writeFileSync(
      path.join(repoRoot, ".den.yml"),
      [
        "name: sample-service",
        "services:",
        "  api:",
        "    health:",
        "      local:",
        "        type: shell",
        "        cmd: test -f repo-relative-marker",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      checkServiceHealth({
        address: "sample-service/api",
        repoName: "sample-service",
        subsystem: "api",
        repoPath: repoRoot,
        mode: "dev-managed",
        branch: null,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        health: "ok",
        healthDetail: undefined,
      }),
    );
  });
});

describe("checkServiceHealth — conventional /healthz discovery", () => {
  const writeManifest = (repoRoot: string, lines: string[]) =>
    fs.writeFileSync(
      path.join(repoRoot, ".den.yml"),
      lines.join("\n"),
      "utf-8",
    );
  const resolved = (repoRoot: string, subsystem: string) => ({
    address: `jobs-runtime/${subsystem}`,
    repoName: "jobs-runtime",
    subsystem,
    repoPath: repoRoot,
    mode: "dev-managed" as const,
    branch: null,
  });

  it("probes http://<repo>/healthz for a no-health entrypoint and reports ok", async () => {
    const repoRoot = createTempRoot();
    writeManifest(repoRoot, [
      "name: jobs-runtime",
      "entrypoint: worker",
      "services:",
      "  worker:",
      "    commands: { local: { up: make up } }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const r = await checkServiceHealth(resolved(repoRoot, "worker"));
    expect(r.health).toBe("ok");
    expect(r.healthDetail).toContain(
      "conventional http://jobs-runtime/healthz",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "http://jobs-runtime/healthz",
      expect.anything(),
    );
  });

  it("stays unknown when the conventional probe returns 404 — a stranger on port 80 must not green-light the service", async () => {
    const repoRoot = createTempRoot();
    writeManifest(repoRoot, [
      "name: jobs-runtime",
      "entrypoint: worker",
      "services:",
      "  worker:",
      "    commands: { local: { up: make up } }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(404));
    const r = await checkServiceHealth(resolved(repoRoot, "worker"));
    expect(r.health).toBe("unknown");
    expect(r.healthDetail).toBe("no health check configured");
  });

  it("stays unknown when the conventional probe returns 401 — 4xx trust is for declared endpoints only", async () => {
    const repoRoot = createTempRoot();
    writeManifest(repoRoot, [
      "name: jobs-runtime",
      "entrypoint: worker",
      "services:",
      "  worker:",
      "    commands: { local: { up: make up } }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const r = await checkServiceHealth(resolved(repoRoot, "worker"));
    expect(r.health).toBe("unknown");
    expect(r.healthDetail).toBe("no health check configured");
  });

  it("stays unknown when the conventional probe fails (down vs no-endpoint is ambiguous)", async () => {
    const repoRoot = createTempRoot();
    writeManifest(repoRoot, [
      "name: jobs-runtime",
      "entrypoint: worker",
      "services:",
      "  worker:",
      "    commands: { local: { up: make up } }",
    ]);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await checkServiceHealth(resolved(repoRoot, "worker"));
    expect(r.health).toBe("unknown");
    expect(r.healthDetail).toBe("no health check configured");
  });

  it("does NOT probe for a non-primary subsystem (sidecars would report the app's health)", async () => {
    const repoRoot = createTempRoot();
    writeManifest(repoRoot, [
      "name: jobs-runtime",
      "entrypoint: worker",
      "services:",
      "  worker:",
      "    commands: { local: { up: make up } }",
      "  sidecar:",
      "    commands: { local: { up: make sidecar-up } }",
    ]);
    const r = await checkServiceHealth(resolved(repoRoot, "sidecar"));
    expect(r.health).toBe("unknown");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("rollupRepoHealth", () => {
  const row = (
    repoName: string,
    subsystem: string,
    health: ServiceHealthResult["health"],
  ): ServiceHealthResult => ({
    address: subsystem === repoName ? repoName : `${repoName}/${subsystem}`,
    repoName,
    subsystem,
    repoPath: `/repos/${repoName}`,
    mode: "managed",
    branch: "main",
    health,
  });

  it("collapses a multi-service repo to its entrypoint's health under the repo name", () => {
    const results = [
      row("files-api", "db", "ok"),
      row("files-api", "pg", "ok"),
      row("files-api", "redis", "ok"),
      row("files-api", "api", "error"), // the real app is down
    ];
    const out = rollupRepoHealth(results, () => "api");
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe("files-api");
    // Entrypoint is down → repo reads down, despite healthy shared-infra sidecars.
    expect(out[0].health).toBe("error");
  });

  it("keeps a hybrid repo's remote service as its own row (R13)", () => {
    const results = [
      row("shop", "web", "ok"),
      {
        ...row("shop", "core", "ok"),
        runs: "remote" as const,
        target: { env: "dev" },
      },
      row("shop", "db", "ok"),
    ];
    const out = rollupRepoHealth(results, () => "web");
    expect(out.map((r) => r.address)).toEqual(["shop", "shop/core"]);
  });

  it("rolls a no-entrypoint repo (infra provider) up to one row too", () => {
    const results = [
      row("infra-stack", "infra-stack", "ok"),
      row("infra-stack", "localstack", "error"),
      row("infra-stack", "postgres", "ok"),
    ];
    const out = rollupRepoHealth(results, () => undefined);
    expect(out.map((r) => r.address)).toEqual(["infra-stack"]);
    // The service named like the repo is its entry: up, so degraded.
    expect(out[0].rollup).toMatchObject({
      state: "degraded",
      down: ["localstack"],
    });
  });

  it("a sidecar that is down makes the repo degraded, not ok (0.3.0-dev.10)", () => {
    const results = [
      row("arbor", "web", "ok"),
      row("arbor", "mailpit", "error"),
    ];
    const [r] = rollupRepoHealth(results, () => "web");
    expect(r.health).toBe("error");
    expect(r.rollup).toMatchObject({ state: "degraded", down: ["mailpit"] });
    expect(rollupReasonText(r.rollup!)).toBe("mailpit down");
  });

  it("unchecked services never count; status can say how many", () => {
    const results = [
      row("platform", "gateway", "ok"),
      ...Array.from({ length: 25 }, (_, i) =>
        row("platform", `svc-${i}`, "unknown"),
      ),
    ];
    const [r] = rollupRepoHealth(results, () => undefined);
    expect(r.health).toBe("ok");
    expect(r.rollup).toMatchObject({ state: "ok", unchecked: 25 });
    expect(rollupReasonText(r.rollup!)).toBe("25 not checked");
    const [none] = rollupRepoHealth(
      [row("quiet", "a", "unknown"), row("quiet", "b", "unknown")],
      () => undefined,
    );
    expect(none.health).toBe("unknown");
    expect(none.rollup!.state).toBe("unknown");
  });

  it("a service that answered with a redirect is a redirect in the reason, not “not checked”", () => {
    const redirected = (sub: string): ServiceHealthResult => ({
      ...row("shop", sub, "unknown"),
      healthDetail: "redirect 302 → /login",
    });
    const [r] = rollupRepoHealth(
      [
        row("shop", "web", "ok"),
        redirected("admin"),
        row("shop", "jobs", "unknown"),
      ],
      () => "web",
    );
    expect(r.rollup).toMatchObject({
      state: "ok",
      unchecked: 1,
      redirected: 1,
    });
    expect(rollupReasonText(r.rollup!)).toBe("1 redirect; 1 not checked");
    const [only] = rollupRepoHealth([redirected("admin")], () => undefined);
    expect(rollupReasonText(only.rollup!)).toBe("1 redirect");
  });

  it("keeps a single-row repo's row, with its rollup", () => {
    const results = [row("control-plane", "api", "error")];
    const out = rollupRepoHealth(results, () => "api");
    expect(out).toEqual([
      { ...results[0], rollup: expect.objectContaining({ state: "down" }) },
    ]);
  });

  it("one row even when the declared entrypoint is not among them", () => {
    const results = [row("weird", "pg", "ok"), row("weird", "redis", "ok")];
    const out = rollupRepoHealth(results, () => "api"); // entrypoint absent
    expect(out).toHaveLength(1);
    expect(out[0].rollup!.state).toBe("ok");
  });

  it("rolls up multiple repos independently and preserves first-seen order", () => {
    const results = [
      row("shop", "db", "ok"),
      row("shop", "api", "error"),
      row("notes-api", "sqs", "ok"),
      row("notes-api", "api", "error"),
    ];
    const out = rollupRepoHealth(results, () => "api");
    expect(out.map((r) => r.address)).toEqual(["shop", "notes-api"]);
    expect(out.map((r) => r.health)).toEqual(["error", "error"]);
  });
});

describe("sortByRepoOrder", () => {
  const row = (
    repoName: string,
    subsystem: string = repoName,
  ): ServiceHealthResult => ({
    address: subsystem === repoName ? repoName : `${repoName}/${subsystem}`,
    repoName,
    subsystem,
    repoPath: `/repos/${repoName}`,
    mode: "managed",
    branch: "main",
    health: "ok",
  });

  it("orders rows to match the given top-down repo order", () => {
    const results = [row("infra-stack"), row("shop"), row("shop-web")];
    const order = ["shop-web", "shop", "infra-stack"];
    const out = sortByRepoOrder(results, order);
    expect(out.map((r) => r.repoName)).toEqual([
      "shop-web",
      "shop",
      "infra-stack",
    ]);
  });

  it("keeps a repo's subsystems grouped and in original sub-order", () => {
    const results = [
      row("infra-stack", "postgres"),
      row("infra-stack", "localstack"),
      row("shop-web"),
    ];
    const order = ["shop-web", "infra-stack"];
    const out = sortByRepoOrder(results, order);
    expect(out.map((r) => r.address)).toEqual([
      "shop-web",
      "infra-stack/postgres",
      "infra-stack/localstack",
    ]);
  });

  it("sorts repos not present in the graph order to the end, preserving their order", () => {
    const results = [row("mystery-b"), row("shop"), row("mystery-a")];
    const order = ["shop"];
    const out = sortByRepoOrder(results, order);
    expect(out.map((r) => r.repoName)).toEqual([
      "shop",
      "mystery-b",
      "mystery-a",
    ]);
  });
});

describe("pingHttp — expected status codes (target.expect)", () => {
  it("counts only the expected codes as up", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    expect(
      (await pingHttp("http://api.dev.acme.example/", 1000, [401])).ok,
    ).toBe(true);
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    expect(
      (await pingHttp("http://api.dev.acme.example/", 1000, [401])).ok,
    ).toBe(false);
  });

  it("2xx only, never a 4xx, under the default", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(404));
    const r = await pingHttp("http://api.dev.acme.example/", 1000, "2xx");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});

describe("checkServiceHealth — remote services (R13)", () => {
  const remoteRepo = (svc: string[]): string => {
    const repoRoot = createTempRoot();
    fs.writeFileSync(
      path.join(repoRoot, ".den.yml"),
      ["name: core", "services:", "  api:", ...svc].join("\n"),
      "utf-8",
    );
    return repoRoot;
  };
  const resolvedAt = (repoPath: string) => ({
    address: "core/api",
    repoName: "core",
    subsystem: "api",
    repoPath,
    mode: "managed" as const,
    branch: "main",
  });

  it("uses the health declared for target.env, and carries placement", async () => {
    const repo = remoteRepo([
      "    runs: { local: remote }",
      "    target: { env: dev, account: AWS, url: http://api.dev.acme.example/admin, expect: 401 }",
      "    health:",
      "      dev: { url: http://api.dev.acme.example/health }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const r = await checkServiceHealth(resolvedAt(repo));
    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://api.dev.acme.example/health",
    );
    expect(r).toEqual(
      expect.objectContaining({
        health: "ok",
        runs: "remote",
        target: {
          env: "dev",
          account: "AWS",
          url: "http://api.dev.acme.example/admin",
          expect: 401,
        },
      }),
    );
  });

  it("probes target.url with target.expect when target.env has no check", async () => {
    const repo = remoteRepo([
      "    runs: { local: remote }",
      "    target: { env: dev, url: http://api.dev.acme.example/admin, expect: 401 }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const r = await checkServiceHealth(resolvedAt(repo));
    expect(mockFetch.mock.calls[0][0]).toBe(
      "http://api.dev.acme.example/admin",
    );
    expect(r.health).toBe("ok");
  });

  it("target.url without expect wants a 2xx", async () => {
    const repo = remoteRepo([
      "    runs: { local: remote }",
      "    target: { env: dev, url: http://api.dev.acme.example/admin }",
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse(401));
    const r = await checkServiceHealth(resolvedAt(repo));
    expect(r.health).toBe("error");
    expect(r.healthDetail).toBe("http 401");
  });

  it("a local service reports runs local and no target", async () => {
    const repo = remoteRepo([
      "    commands: { local: { up: make up } }",
      "    health:",
      "      local: { type: shell, cmd: 'true' }",
    ]);
    const r = await checkServiceHealth(resolvedAt(repo));
    expect(r).toEqual(
      expect.objectContaining({ runs: "local", target: null, health: "ok" }),
    );
  });
});
