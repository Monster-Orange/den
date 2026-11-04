/**
 * Unit tests for journey credential sourcing + isolation
 * (src/pillars/journeys/sandbox.ts + runner.ts ordering).
 *
 * Contract under test (plan: jrn-runner packet, Approach §Credential
 * isolation — four ordered layers):
 * (a) captureSecrets() sources CURSOR_API_KEY env-first (CI), else via
 *     `op read` from the System Integrations vault "Den API Keys" item (op CLI
 *     mocked through DI); neither source → loud actionable error naming
 *     both sources; nothing written to disk.
 * (b) provisioning-before-sanitization: captureSecrets (JWT mint) AND
 *     provisionBrowserSession (storageState mint) complete BEFORE
 *     sanitizeEnvironment(); only the auth-file PATH flows onward.
 * (c) sanitizeEnvironment() runs BEFORE Agent.create: at create time
 *     process.env lacks CURSOR_API_KEY / E2E_* / SMOKE_*_TOKEN / AUTH0
 *     secrets; restored in finally; apiKey passed explicitly.
 * (d) the staged cwd's generated .cursor/hooks.json contains a
 *     beforeShellExecution hook with a concrete deny command AND
 *     failClosed: true — exact file content asserted.
 * (e) the deny hook script, unit-executed, emits the deny decision.
 * (f) transcript-sentinel: persisting a stream carrying a live secret
 *     value fails loudly and never writes the secret to disk.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import {
  captureSecrets,
  JOURNEYS_AGENT_KEY_DEFAULT,
  prepareSandbox,
  sanitizeEnvironment,
  SecretLeakError,
  TranscriptScrubber,
  TranscriptWriter,
} from "../../../src/pillars/journeys/sandbox.js";
import { runJourney } from "../../../src/pillars/journeys/runner.js";
import type {
  AgentCreateOptionsLike,
  AgentLike,
  AgentRunLike,
} from "../../../src/pillars/journeys/runner.js";
import type { JourneySpec } from "../../../src/pillars/journeys/spec/schema.js";
import type { BrowserToolset } from "../../../src/pillars/journeys/tools/browser-tool.js";

const DENY_SCRIPT_SRC = path.resolve(
  process.cwd(),
  "src/pillars/journeys/hooks/deny-shell.cjs",
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<JourneySpec> = {}): JourneySpec {
  return {
    name: "user-first-item",
    persona: { role: "user", brief: "Create an item and ask a question." },
    surface: "browser",
    environments: ["local"],
    budgets: { max_turns: 20, timeout_s: 300, max_total_tokens: 200_000 },
    success: {
      assertions: [
        {
          kind: "http_status",
          request: { method: "GET", path: "/api/v1/items/{item_id}" },
          equals: 200,
        },
      ],
    },
    ...overrides,
  };
}

function fakeRun(): AgentRunLike {
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stream: async function* () {},
    wait: async () => ({
      status: "finished",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
      },
    }),
    cancel: async () => undefined,
  };
}

function fakeAgent(run: AgentRunLike = fakeRun()): AgentLike {
  return {
    send: async () => run,
    close: () => undefined,
  };
}

function fakeBrowserToolset(): BrowserToolset {
  const tool = {
    description: "stub",
    execute: async () => "ok",
  };
  return {
    tools: {
      browser_navigate: tool,
      browser_snapshot: tool,
      browser_click: tool,
      browser_type: tool,
      browser_select: tool,
      browser_wait: tool,
    },
    start: async () => undefined,
    drain: async () => undefined,
    dispose: jest.fn(async () => undefined) as BrowserToolset["dispose"],
    policyReports: [],
  };
}

const ENV_CONFIG = {
  name: "local",
  baseUrls: {
    web: "http://localhost:3000",
    api: "http://localhost:8000",
    services: { folders: "http://localhost:8084" },
  },
};

const SENSITIVE_SEED: Record<string, string> = {
  CURSOR_API_KEY: "cursor-key-sentinel",
  E2E_USER_EMAIL: "seeded-user@example.com",
  E2E_USER_PASSWORD: "seeded-password-sentinel",
  E2E_AUTH0_CLIENT_SECRET: "seeded-auth0-secret",
  AUTH0_CLIENT_SECRET: "seeded-auth0-secret-2",
  SMOKE_ADMIN_TOKEN: "seeded-smoke-token",
};

function seedSensitiveEnv(): void {
  for (const [key, value] of Object.entries(SENSITIVE_SEED)) {
    process.env[key] = value;
  }
}

function cleanSensitiveEnv(): void {
  for (const key of Object.keys(SENSITIVE_SEED)) {
    delete process.env[key];
  }
}

afterEach(() => {
  cleanSensitiveEnv();
  jest.restoreAllMocks();
});

// ── (a) captureSecrets ───────────────────────────────────────────────────────

describe("captureSecrets", () => {
  it("uses the CURSOR_API_KEY env var when set (CI path) — op never invoked", async () => {
    const opReadField = jest.fn<() => Promise<string>>();

    const secrets = await captureSecrets("user", "local", {
      env: { CURSOR_API_KEY: "env-sourced-key" },
      opReadField: opReadField as never,
    });

    expect(secrets.cursorApiKey).toBe("env-sourced-key");
    expect(opReadField).not.toHaveBeenCalled();
  });

  it("falls back to the secrets backend at the default agent-key ref (local path)", async () => {
    const opReadField = jest.fn(async () => "op-sourced-key");

    const secrets = await captureSecrets("user", "local", {
      env: {},
      opReadField: opReadField as never,
      agentKeyRef: JOURNEYS_AGENT_KEY_DEFAULT,
    });

    expect(secrets.cursorApiKey).toBe("op-sourced-key");
    expect(opReadField).toHaveBeenCalledWith({
      item: JOURNEYS_AGENT_KEY_DEFAULT.item,
      vault: JOURNEYS_AGENT_KEY_DEFAULT.vault,
      field: "CURSOR_API_KEY",
    });
  });

  it("reads the agent key from a configured ref (secrets.refs.journeys_agent_key)", async () => {
    const opReadField = jest.fn(async () => "ci-key");

    await captureSecrets("user", "local", {
      env: {},
      opReadField: opReadField as never,
      agentKeyRef: {
        vault: "Shared",
        item: "CI Keys",
        field: "CURSOR_API_KEY",
      },
    });

    expect(opReadField).toHaveBeenCalledWith({
      item: "CI Keys",
      vault: "Shared",
      field: "CURSOR_API_KEY",
    });
  });

  it("does NOT mint an API/persona JWT (ROPC removed) — only the Cursor key", async () => {
    const secrets = await captureSecrets("admin", "local", {
      env: { CURSOR_API_KEY: "k" },
    });

    expect(secrets.cursorApiKey).toBe("k");
    // The assertion token is derived from the browser session later, so
    // captureSecrets must not expose an apiToken field anymore.
    expect((secrets as { apiToken?: string }).apiToken).toBeUndefined();
  });

  it("fails loudly naming BOTH sources when neither yields a key", async () => {
    const opReadField = jest.fn(async () => {
      throw new Error("op: item not found");
    });

    const attempt = captureSecrets("user", "local", {
      env: {},
      opReadField: opReadField as never,
      agentKeyRef: JOURNEYS_AGENT_KEY_DEFAULT,
    });

    await expect(attempt).rejects.toThrow(/CURSOR_API_KEY/);
    await expect(
      captureSecrets("user", "local", {
        env: {},
        opReadField: opReadField as never,
        agentKeyRef: JOURNEYS_AGENT_KEY_DEFAULT,
      }),
    ).rejects.toThrow(new RegExp(JOURNEYS_AGENT_KEY_DEFAULT.item));
  });

  it("writes nothing to disk (auth/config dirs untouched)", async () => {
    // fs namespace exports can't be spied under ESM, so assert the
    // observable contract: the places a key could plausibly be cached
    // (playwright/.auth, config/local) are byte-identical after capture.
    const watchedDirs = ["playwright/.auth", "config/local"].map((dir) =>
      path.resolve(process.cwd(), dir),
    );
    const listDir = (dir: string): string[] =>
      fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const before = watchedDirs.map(listDir);

    await captureSecrets("user", "local", {
      env: { CURSOR_API_KEY: "k" },
    });

    expect(watchedDirs.map(listDir)).toEqual(before);
  });
});

// ── sanitizeEnvironment: executor allowlist + baseline restore ───────────────

describe("sanitizeEnvironment (executor allowlist)", () => {
  it("removes ambient credentials that are not on the allowlist (review finding 3)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      JOURNEYS_MODEL: "test-model",
      NODE_OPTIONS: "--max-old-space-size=4096",
      AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
      SENTRY_AUTH_TOKEN: "sentry-token-sentinel",
      GH_TOKEN: "gh-token-sentinel",
      OP_SESSION_myaccount: "op-session-sentinel",
    };

    const result = sanitizeEnvironment(env);

    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SENTRY_AUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OP_SESSION_myaccount).toBeUndefined();
    // Allowlisted basics + toolchain + journeys config survive.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/dev");
    expect(env.JOURNEYS_MODEL).toBe("test-model");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");

    result.restore();
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret-sentinel");
    expect(env.GH_TOKEN).toBe("gh-token-sentinel");
  });

  it("keeps removing denylisted keys as belt and braces", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      CURSOR_API_KEY: "cursor-sentinel",
      E2E_USER_PASSWORD: "pw-sentinel",
      SMOKE_ADMIN_TOKEN: "smoke-sentinel",
      AUTH0_CLIENT_SECRET: "auth0-sentinel",
    };

    sanitizeEnvironment(env);

    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.E2E_USER_PASSWORD).toBeUndefined();
    expect(env.SMOKE_ADMIN_TOKEN).toBeUndefined();
    expect(env.AUTH0_CLIENT_SECRET).toBeUndefined();
  });

  it("restore() with a baseline never reintroduces keys absent from it (review finding 2)", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const baseline = { ...env };
    // A secret exported into the env DURING secret capture (the
    // getApiToken E2E_AUTH0_CLIENT_SECRET side effect of the finding).
    env.E2E_AUTH0_CLIENT_SECRET = "minted-mid-capture-sentinel";

    const result = sanitizeEnvironment(env, baseline);
    expect(env.E2E_AUTH0_CLIENT_SECRET).toBeUndefined();

    result.restore();
    expect(env.E2E_AUTH0_CLIENT_SECRET).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

// ── (b) + (c) ordering through runJourney ────────────────────────────────────

describe("runJourney isolation ordering", () => {
  function orderingHarness() {
    const order: string[] = [];
    let envAtCreate: Record<string, string | undefined> = {};
    let createOptions: AgentCreateOptionsLike | undefined;
    let toolsetAuthFile: string | undefined;
    const toolset = fakeBrowserToolset();
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-iso-"));
    const sandboxBase = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-iso-sb-"));

    const deps = {
      loadEnvironment: async () => ENV_CONFIG,
      prepareSandbox: (journeyName: string) =>
        prepareSandbox(journeyName, { baseDir: sandboxBase }),
      captureSecrets: async () => {
        order.push("captureSecrets");
        return { cursorApiKey: "captured-key" };
      },
      provisionBrowserSession: async () => {
        order.push("provisionBrowserSession");
        // Provisioning must still see the E2E_* vars (CI reads them here).
        expect(process.env.E2E_USER_EMAIL).toBe(SENSITIVE_SEED.E2E_USER_EMAIL);
        return "/tmp/playwright/.auth/user-local.json";
      },
      deriveApiToken: async () => {
        order.push("deriveApiToken");
        // Must run AFTER provisioning (needs the auth file) but BEFORE
        // sanitization (reaches the web origin over session cookies).
        return { apiToken: "session-jwt", headers: { "X-Org-ID": "org-abc" } };
      },
      sanitizeEnvironment: () => {
        order.push("sanitizeEnvironment");
        return sanitizeEnvironment();
      },
      createAgent: async (options: AgentCreateOptionsLike) => {
        order.push("createAgent");
        createOptions = options;
        envAtCreate = { ...process.env };
        return fakeAgent();
      },
      buildBrowserToolset: (options: { authFilePath: string }) => {
        toolsetAuthFile = options.authFilePath;
        return toolset;
      },
      reportRoot,
      env: { JOURNEYS_MODEL: "test-model" },
    };

    return {
      order,
      deps,
      toolset,
      getEnvAtCreate: () => envAtCreate,
      getCreateOptions: () => createOptions,
      getToolsetAuthFile: () => toolsetAuthFile,
    };
  }

  it("orders captureSecrets → provisionBrowserSession → sanitizeEnvironment → Agent.create", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    expect(harness.order).toEqual([
      "captureSecrets",
      "provisionBrowserSession",
      "deriveApiToken",
      "sanitizeEnvironment",
      "createAgent",
    ]);
  });

  it("scrubs CURSOR_API_KEY, E2E_*, SMOKE_*_TOKEN, and AUTH0 secrets from env at Agent.create time", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    const envAtCreate = harness.getEnvAtCreate();
    expect(envAtCreate.CURSOR_API_KEY).toBeUndefined();
    expect(envAtCreate.E2E_USER_EMAIL).toBeUndefined();
    expect(envAtCreate.E2E_USER_PASSWORD).toBeUndefined();
    expect(envAtCreate.E2E_AUTH0_CLIENT_SECRET).toBeUndefined();
    expect(envAtCreate.AUTH0_CLIENT_SECRET).toBeUndefined();
    expect(envAtCreate.SMOKE_ADMIN_TOKEN).toBeUndefined();
  });

  it("passes the api key explicitly to Agent.create from the captured value", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    expect(harness.getCreateOptions()?.apiKey).toBe("captured-key");
  });

  it("restores the sanitized env vars in finally", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    for (const [key, value] of Object.entries(SENSITIVE_SEED)) {
      expect(process.env[key]).toBe(value);
    }
  });

  it("restores the env even when Agent.create throws (run becomes an infra_error outcome)", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();
    harness.deps.createAgent = async () => {
      throw new Error("boom");
    };

    // Post-policy failures return an outcome carrying the ledger (review
    // finding 8) instead of throwing, so teardown/reporting always run.
    const outcome = await runJourney(
      makeSpec(),
      "local",
      harness.deps as never,
    );
    expect(outcome.failure_kind).toBe("infra_error");
    expect(outcome.error).toContain("boom");

    for (const [key, value] of Object.entries(SENSITIVE_SEED)) {
      expect(process.env[key]).toBe(value);
    }
  });

  it("flows ONLY the auth-file path (no credential values) into the browser toolset", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    const authFile = harness.getToolsetAuthFile();
    expect(authFile).toBe("/tmp/playwright/.auth/user-local.json");
    for (const value of Object.values(SENSITIVE_SEED)) {
      expect(authFile).not.toContain(value);
    }
  });

  it("never restores a secret that was exported into process.env during capture (review finding 2)", async () => {
    seedSensitiveEnv();
    delete process.env.E2E_AUTH0_CLIENT_SECRET;
    const harness = orderingHarness();
    // Default runner wiring: baseline snapshot flows into sanitize.
    harness.deps.sanitizeEnvironment = ((baseline: NodeJS.ProcessEnv) =>
      sanitizeEnvironment(process.env, baseline)) as never;
    harness.deps.captureSecrets = async () => {
      // Simulate the getApiToken side effect the finding describes.
      process.env.E2E_AUTH0_CLIENT_SECRET = "minted-mid-capture-sentinel";
      return { cursorApiKey: "captured-key" };
    };

    await runJourney(makeSpec(), "local", harness.deps as never);

    expect(process.env.E2E_AUTH0_CLIENT_SECRET).toBeUndefined();
    // Pre-existing seeded vars are still restored from the baseline.
    expect(process.env.E2E_USER_EMAIL).toBe(SENSITIVE_SEED.E2E_USER_EMAIL);
    expect(process.env.CURSOR_API_KEY).toBe(SENSITIVE_SEED.CURSOR_API_KEY);
  });

  it("scrubs ambient non-allowlisted credentials from env at Agent.create time (review finding 3)", async () => {
    seedSensitiveEnv();
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-sentinel";
    process.env.SENTRY_AUTH_TOKEN = "sentry-token-sentinel";
    try {
      const harness = orderingHarness();
      harness.deps.sanitizeEnvironment = ((baseline: NodeJS.ProcessEnv) =>
        sanitizeEnvironment(process.env, baseline)) as never;

      await runJourney(makeSpec(), "local", harness.deps as never);

      const envAtCreate = harness.getEnvAtCreate();
      expect(envAtCreate.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(envAtCreate.SENTRY_AUTH_TOKEN).toBeUndefined();
      expect(envAtCreate.PATH).toBeDefined();
      // Restored after the run (they were in the baseline).
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret-sentinel");
      expect(process.env.SENTRY_AUTH_TOKEN).toBe("sentry-token-sentinel");
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.SENTRY_AUTH_TOKEN;
    }
  });

  it("disposes the browser toolset in finally", async () => {
    seedSensitiveEnv();
    const harness = orderingHarness();

    await runJourney(makeSpec(), "local", harness.deps as never);

    expect(harness.toolset.dispose).toHaveBeenCalled();
  });
});

// ── (d) generated hooks.json ─────────────────────────────────────────────────

describe("prepareSandbox", () => {
  it("generates .cursor/hooks.json with a beforeShellExecution deny hook and failClosed: true — exact content", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-sandbox-"));
    const staged = prepareSandbox("user-first-item", { baseDir });

    const hooksJsonPath = path.join(staged.dir, ".cursor", "hooks.json");
    expect(staged.hooksJsonPath).toBe(hooksJsonPath);
    const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    expect(parsed).toEqual({
      version: 1,
      hooks: {
        beforeShellExecution: [
          {
            command: "node .cursor/hooks/deny-shell.cjs",
            failClosed: true,
          },
        ],
      },
    });
  });

  it("copies the checked-in deny script into the staged dir so the hook path resolves", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-sandbox-"));
    const staged = prepareSandbox("user-first-item", { baseDir });

    const copiedScript = path.join(
      staged.dir,
      ".cursor",
      "hooks",
      "deny-shell.cjs",
    );
    expect(staged.denyScriptPath).toBe(copiedScript);
    expect(fs.existsSync(copiedScript)).toBe(true);
    expect(fs.readFileSync(copiedScript, "utf-8")).toBe(
      fs.readFileSync(DENY_SCRIPT_SRC, "utf-8"),
    );
  });

  it("generates .cursor/permissions.json allowlisting ONLY the custom-user-tools MCP server — shell is not allowlisted", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-sandbox-"));
    const staged = prepareSandbox("user-first-item", { baseDir });

    const permissionsJsonPath = path.join(
      staged.dir,
      ".cursor",
      "permissions.json",
    );
    expect(staged.permissionsJsonPath).toBe(permissionsJsonPath);
    const parsed = JSON.parse(fs.readFileSync(permissionsJsonPath, "utf-8"));
    expect(parsed).toEqual({ mcpAllowlist: ["custom-user-tools:*"] });
    // No terminal/shell allowlist — shell stays denied by the hook.
    expect(parsed.terminalAllowlist).toBeUndefined();
  });

  it("stages a directory containing ONLY the .cursor config tree (nothing else to read/exfiltrate)", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-sandbox-"));
    const staged = prepareSandbox("user-first-item", { baseDir });

    expect(fs.readdirSync(staged.dir)).toEqual([".cursor"]);
    // Inside .cursor: hooks.json + permissions.json + hooks/ (the deny script).
    expect(fs.readdirSync(path.join(staged.dir, ".cursor")).sort()).toEqual([
      "hooks",
      "hooks.json",
      "permissions.json",
    ]);
  });
});

// ── (e) deny hook script ─────────────────────────────────────────────────────

describe("deny-shell.cjs", () => {
  it("emits the deny decision for any shell command", () => {
    const result = spawnSync("node", [DENY_SCRIPT_SRC], {
      input: JSON.stringify({ command: "curl http://evil.example.com" }),
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.permission).toBe("deny");
    expect(typeof decision.agent_message).toBe("string");
  });

  it("emits the deny decision even on empty/garbage input (fail-closed posture)", () => {
    const result = spawnSync("node", [DENY_SCRIPT_SRC], {
      input: "not-json",
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.permission).toBe("deny");
  });
});

// ── (f) transcript sentinel ──────────────────────────────────────────────────

describe("transcript scrubber", () => {
  const SENTINEL = "live-secret-value-sentinel-1234";

  it("fails the persist loudly when a live secret value would be written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const writer = new TranscriptWriter(
      transcriptPath,
      new TranscriptScrubber([SENTINEL]),
    );

    const messages = [
      { type: "assistant", text: "harmless" },
      { type: "assistant", text: `leaking ${SENTINEL} here` },
    ];

    await expect(async () => {
      for (const message of messages) {
        await writer.append(message);
      }
    }).rejects.toThrow(SecretLeakError);

    // Nothing containing the sentinel may have reached disk.
    if (fs.existsSync(transcriptPath)) {
      expect(fs.readFileSync(transcriptPath, "utf-8")).not.toContain(SENTINEL);
    }
  });

  it("persists clean messages as JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-transcript-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const writer = new TranscriptWriter(
      transcriptPath,
      new TranscriptScrubber([SENTINEL]),
    );

    await writer.append({ type: "assistant", text: "hello" });
    await writer.append({ type: "user", text: "world" });

    const lines = fs
      .readFileSync(transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("hello");
  });

  it("never flags secret-free content", () => {
    const scrubber = new TranscriptScrubber([SENTINEL, ""]);
    expect(() => scrubber.assertClean("regular text")).not.toThrow();
  });
});
