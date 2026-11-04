/**
 * planRegistration — decides whether `make register-repos` reports the
 * workspace-driven test sources (Local Dev on, the default) or falls back to
 * the legacy interactive sibling scan (hosted / no-local, or --legacy).
 * Getting this wrong either re-introduces the fresh-clone dead-end (scanning
 * empty sibling dirs) or hides the legacy path hosted setups still need.
 */
import { describe, expect, it } from "@jest/globals";

import { planRegistration } from "../../../src/scripts/register-repos.js";

const DEFAULTS = ["shop-web", "shop", "files-api", "infra-stack"];

describe("planRegistration", () => {
  it("reports the active workspace when Local Dev is enabled", () => {
    const plan = planRegistration({
      localEnabled: true,
      legacyRequested: false,
      workspace: {
        name: "default",
        services: {
          "files-api": { mode: "managed" },
          "shop-web": { mode: "dev-managed" },
        },
      },
      defaultRepos: DEFAULTS,
    });
    expect(plan).toEqual({
      mode: "workspace",
      workspaceName: "default",
      repos: [
        { name: "files-api", managed: true },
        { name: "shop-web", managed: false },
      ],
    });
  });

  it("treats a service without an explicit mode as dev-managed (normalizeMode's default)", () => {
    // readWorkspacesFile() normalizes every entry on read, so this is only
    // reachable with unnormalized input — but the fallback must agree with
    // the system default (workspaces.ts normalizeMode), never invert it.
    const plan = planRegistration({
      localEnabled: true,
      legacyRequested: false,
      workspace: { name: "default", services: { "notes-api": {} } },
      defaultRepos: DEFAULTS,
    });
    expect(plan).toMatchObject({
      mode: "workspace",
      repos: [{ name: "notes-api", managed: false }],
    });
  });

  it("reports the seed defaults when no workspace exists yet (fresh clone)", () => {
    const plan = planRegistration({
      localEnabled: true,
      legacyRequested: false,
      workspace: null,
      defaultRepos: DEFAULTS,
    });
    expect(plan).toEqual({ mode: "defaults", repos: DEFAULTS });
  });

  it("reports the seed defaults for an EMPTY workspace (declined / user-emptied)", () => {
    // A zero-row workspace table says nothing actionable; the defaults
    // message tells the user what the first den command will do.
    const plan = planRegistration({
      localEnabled: true,
      legacyRequested: false,
      workspace: { name: "default", services: {} },
      defaultRepos: DEFAULTS,
    });
    expect(plan).toEqual({ mode: "defaults", repos: DEFAULTS });
  });

  it("falls back to the legacy sibling scan when Local Dev is disabled", () => {
    const plan = planRegistration({
      localEnabled: false,
      legacyRequested: false,
      workspace: null,
      defaultRepos: DEFAULTS,
    });
    expect(plan).toEqual({ mode: "legacy" });
  });

  it("honors an explicit --legacy even with Local Dev and a workspace", () => {
    const plan = planRegistration({
      localEnabled: true,
      legacyRequested: true,
      workspace: { name: "default", services: { shop: {} } },
      defaultRepos: DEFAULTS,
    });
    expect(plan).toEqual({ mode: "legacy" });
  });
});
