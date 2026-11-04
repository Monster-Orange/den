import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { assertStorageAdminProbe } from "../../../src/pillars/smoke/admin-probe.js";

const originalFetch = global.fetch;

describe("assertStorageAdminProbe", () => {
  beforeEach(() => {
    global.fetch = jest.fn() as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("strips trailing slash from baseUrl and joins the probe path", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    await assertStorageAdminProbe({
      baseUrl: "http://localhost:8080/",
      adminProbePath: "/api/v1/admin/ingest-queue/status",
      label: "test",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/admin/ingest-queue/status",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("resolves when GET returns 2xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/ingest-queue/status",
        label: "test",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws with body excerpt on 403 without hintOn403 callback", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"some generic error"}',
    });
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/ingest-queue/status",
        label: "svc",
      }),
    ).rejects.toThrow(/returned 403/);
  });

  it("includes the hintOn403 return value in the error when provided", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"ENABLE_ADMIN_ENDPOINTS=true required"}',
    });
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/ingest-queue/status",
        label: "svc",
        hintOn403: (body) =>
          body.includes("ENABLE_ADMIN_ENDPOINTS")
            ? "  Set ENABLE_ADMIN_ENDPOINTS in stack.yml and redeploy."
            : "",
      }),
    ).rejects.toThrow(/Set ENABLE_ADMIN_ENDPOINTS/);
  });

  it("falls back to body excerpt when hintOn403 returns empty string", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"some unrecognised reason"}',
    });
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/ingest-queue/status",
        label: "svc",
        hintOn403: () => "",
      }),
    ).rejects.toThrow(/Response body/);
  });

  it("throws a network error message when fetch throws", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/status",
        label: "svc",
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws on non-403 error status", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    await expect(
      assertStorageAdminProbe({
        baseUrl: "http://localhost:8080",
        adminProbePath: "/api/v1/admin/status",
        label: "svc",
      }),
    ).rejects.toThrow(/returned 500/);
  });
});
