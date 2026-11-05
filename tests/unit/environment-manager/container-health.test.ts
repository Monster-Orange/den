/**
 * `health: { type: container }`: a container's state, judged from the one
 * docker listing a health cycle shares with Den's compose checks. Verdicts
 * over a fake listing; the web health row and `<cli> status` end to end are
 * in tests/unit/server/health-compose-load.integration.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  containerCheckLabel,
  judgeContainerListing,
  unknownListingVerdict,
  type ComposeRow,
} from "../../../src/shared/stacks/compose-health.js";

const row = (
  project: string,
  service: string,
  state: string,
  status: string,
  name = `${project}-${service}-1`,
): ComposeRow => ({ project, service, state, status, name });

const api = { project: "acme-main", service: "api" };
/** What a compose check says over the same failed listing. */
const composeVerdictFor = unknownListingVerdict;

describe("container verdict over a listing", () => {
  it("running with a healthcheck: its health (healthy up, unhealthy down, starting pending)", () => {
    const healthy = judgeContainerListing(
      { rows: [row("acme-main", "api", "running", "Up 2 hours (healthy)")] },
      api,
    );
    expect(healthy.ok).toBe(true);

    const unhealthy = judgeContainerListing(
      { rows: [row("acme-main", "api", "running", "Up 2 hours (unhealthy)")] },
      api,
    );
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.detail).toContain("unhealthy");

    const starting = judgeContainerListing(
      {
        rows: [
          row("acme-main", "api", "running", "Up 3 seconds (health: starting)"),
        ],
      },
      api,
    );
    // Pending, but not "no answer": a starting container is not a timeout,
    // so it never turns down on a repeat cycle.
    expect(starting.ok).toBeNull();
    expect(starting.pending).toBeUndefined();
    expect(starting.detail).toContain("health: starting");
  });

  it("running without a healthcheck: up", () => {
    expect(
      judgeContainerListing(
        { rows: [row("acme-main", "api", "running", "Up 5 minutes")] },
        api,
      ).ok,
    ).toBe(true);
  });

  it("not running: down", () => {
    const v = judgeContainerListing(
      { rows: [row("acme-main", "api", "exited", "Exited (1) 2 minutes ago")] },
      api,
    );
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("exited");
  });

  it("no matching container: down", () => {
    const v = judgeContainerListing(
      {
        rows: [
          row("acme-main", "web", "running", "Up 2 hours (healthy)"),
          row("other-main", "api", "running", "Up 2 hours (healthy)"),
        ],
      },
      api,
    );
    expect(v.ok).toBe(false);
    expect(v.detail).toBe("acme-main/api: no container");
  });

  it("docker past its budget: pending, as a compose check", () => {
    const late = { error: "docker gave no answer within 5s", pending: true };
    expect(judgeContainerListing(late, api)).toEqual({
      ok: null,
      pending: true,
      detail: "container state unknown: docker gave no answer within 5s",
    });
    expect(judgeContainerListing(late, api)).toEqual(composeVerdictFor(late));
  });

  it("docker ps failed: unknown (ok null), not pending, as a compose check", () => {
    const failed = { error: "Cannot connect to the Docker daemon" };
    expect(judgeContainerListing(failed, api)).toEqual({
      ok: null,
      detail: "container state unknown: Cannot connect to the Docker daemon",
    });
    expect(judgeContainerListing(failed, api)).toEqual(
      composeVerdictFor(failed),
    );
  });

  it("more than one match: the best one, healthy then running", () => {
    const rows = [
      row("acme-main", "api", "exited", "Exited (0) 1 hour ago", "a-1"),
      row("acme-main", "api", "running", "Up 1 minute (unhealthy)", "a-2"),
      row("acme-main", "api", "running", "Up 1 hour (healthy)", "a-3"),
    ];
    expect(judgeContainerListing({ rows }, api).ok).toBe(true);
    // Running beats exited, and a running one without a healthcheck is up.
    expect(
      judgeContainerListing(
        {
          rows: [
            row("acme-main", "api", "exited", "Exited (1) 1 hour ago", "b-1"),
            row("acme-main", "api", "running", "Up 1 minute", "b-2"),
          ],
        },
        api,
      ).ok,
    ).toBe(true);
    // Healthy is preferred over running without a healthcheck.
    expect(
      judgeContainerListing(
        {
          rows: [
            row("acme-main", "api", "running", "Up 1 minute", "c-1"),
            row("acme-main", "api", "running", "Up 1 hour (healthy)", "c-2"),
          ],
        },
        api,
      ).detail,
    ).toContain("c-2");
    // Running (even unhealthy) beats exited: the verdict is that container's.
    expect(
      judgeContainerListing(
        {
          rows: [
            row("acme-main", "api", "exited", "Exited (0) 1 hour ago", "d-1"),
            row(
              "acme-main",
              "api",
              "running",
              "Up 1 minute (unhealthy)",
              "d-2",
            ),
          ],
        },
        api,
      ).detail,
    ).toContain("d-2");
  });

  it("container_name matches a container by name, compose or not", () => {
    const rows = [
      row("", "", "running", "Up 3 days (healthy)", "acme-db"),
      row("acme-main", "api", "running", "Up 3 days", "acme-main-api-1"),
    ];
    expect(
      judgeContainerListing({ rows }, { container_name: "acme-db" }).ok,
    ).toBe(true);
    // A container with several names (docker lists them comma-separated).
    expect(
      judgeContainerListing(
        {
          rows: [row("", "", "running", "Up 1 hour", "acme-cache,link/alias")],
        },
        { container_name: "acme-cache" },
      ).ok,
    ).toBe(true);
    const missing = judgeContainerListing({ rows }, { container_name: "nope" });
    expect(missing).toEqual({ ok: false, detail: "nope: no container" });
  });

  it("labels the check by what it matches", () => {
    expect(containerCheckLabel(api)).toBe("container acme-main/api");
    expect(containerCheckLabel({ container_name: "acme-db" })).toBe(
      "container acme-db",
    );
  });
});
