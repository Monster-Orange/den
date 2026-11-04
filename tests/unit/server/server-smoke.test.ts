/**
 * Server smoke test — verifies the HTTP server starts and key endpoints respond.
 *
 * This catches wiring errors (undefined references, missing imports) that
 * unit tests miss because they mock at the module level.
 *
 * NOT a full integration test — just verifies the server boots and routes
 * don't throw ReferenceError on first request.
 */

import { describe, it, expect, afterAll } from "@jest/globals";
import * as http from "http";

// Import the server module to start it on a random port
const TEST_PORT = 19876 + Math.floor(Math.random() * 1000);

let serverProcess: ReturnType<typeof import("child_process").spawn> | null =
  null;

function fetch(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://localhost:${TEST_PORT}${path}`,
      { timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

describe("server smoke", () => {
  // Start the actual server before tests
  beforeAll(async () => {
    const { spawn } = await import("child_process");
    serverProcess = spawn("npx", ["tsx", "src/ui/server/index.ts"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        // Suppress the browser auto-open
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the server to be ready (poll until we get a response)
    const maxWait = 10000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        await fetch("/api/environments");
        return; // server is ready
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("Server did not start within 10s");
  }, 15000);

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      serverProcess = null;
    }
  });

  it("GET /api/environments returns JSON array", async () => {
    const res = await fetch("/api/environments");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/changelog returns JSON array", async () => {
    const res = await fetch("/api/changelog");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/settings returns editor/terminal config", async () => {
    const res = await fetch("/api/settings");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("editors");
    expect(data).toHaveProperty("terminals");
  });

  it("GET /api/workspaces returns workspace data", async () => {
    const res = await fetch("/api/workspaces");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("workspaces");
  });

  it("GET /api/health returns JSON array", async () => {
    const res = await fetch("/api/health");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/workspaces/deps-check returns JSON", async () => {
    const res = await fetch("/api/workspaces/deps-check");
    expect(res.status).toBe(200);
  });

  it("GET / returns HTML", async () => {
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<!doctype html>/i);
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await fetch("/api/nonexistent");
    expect(res.status).toBe(404);
  });
});
