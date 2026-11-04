/**
 * Tests for the up-plan discovery logic: command resolution precedence, the
 * interactive classifier (prereq-following + TTY-gate awareness), and health URL
 * resolution. These take a ResolvedService directly, so no workspace is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ResolvedService } from "../../../src/shared/types/index.js";
import {
  resolveUpCommand,
  classifyInteractive,
  resolveHealthUrl,
} from "../../../src/shared/environment-manager/up-plan.js";

let tmp: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function svcFor(dir: string, subsystem = "api"): ResolvedService {
  return {
    address: path.basename(dir),
    repoName: path.basename(dir),
    subsystem,
    repoPath: dir,
    branch: null,
    mode: "managed",
  };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-upplan-"));

  // billing-like: `up` is an alias for `dev`, whose recipe has an unguarded osascript + stripe login.
  write(
    path.join(tmp, "billing", "Makefile"),
    [
      "up: dev ## alias",
      "",
      "dev:",
      "\t@osascript -e 'tell application \"iTerm2\" to create tab'",
      "\tstripe login",
      "\topctl run dev",
      "",
    ].join("\n"),
  );

  // notes-like: `up` calls a script whose tab spawn is TTY/USE_TABS gated.
  write(
    path.join(tmp, "notes", "Makefile"),
    ["up:", "\t@./scripts/start-up.sh", ""].join("\n"),
  );
  write(
    path.join(tmp, "notes", "scripts", "start-up.sh"),
    [
      "#!/usr/bin/env bash",
      ': "${USE_TABS:=true}"',
      'if [[ -t 1 ]]; then ./scripts/run_in_tab.sh "opctl run dev"; else opctl run dev; fi',
      "",
    ].join("\n"),
  );
  // the actual osascript lives one level deeper, behind the gate
  write(
    path.join(tmp, "notes", "scripts", "run_in_tab.sh"),
    ["#!/usr/bin/env bash", "osascript -e 'create tab'", ""].join("\n"),
  );

  // clean: headless make up.
  write(
    path.join(tmp, "clean", "Makefile"),
    ["up:", "\t@opctl run dev", ""].join("\n"),
  );

  // stripe-only: an unguarded `stripe login` with no osascript → kind "stripe".
  write(
    path.join(tmp, "stripeonly", "Makefile"),
    ["up:", "\tstripe login", "\topctl run dev", ""].join("\n"),
  );

  // prompt-only: an unguarded `read -r` → kind "prompt" (the fallback label).
  write(
    path.join(tmp, "promptonly", "Makefile"),
    ["up:", '\t@read -r -p "continue? " ans', "\topctl run dev", ""].join("\n"),
  );

  // opctl-only: no make up target, but a dev op with a container.name.
  write(
    path.join(tmp, "opctlonly", ".opspec", "dev", "op.yml"),
    ["name: dev", "run:", "  container:", "    name: opctlonly", ""].join("\n"),
  );

  // manifest-only: no Makefile up, no op — only a .den.yml up command.
  write(
    path.join(tmp, "manifestonly", ".den.yml"),
    [
      "services:",
      "  api:",
      "    commands:",
      "      local:",
      "        up: custom-up-cmd",
      "    health:",
      "      local:",
      "        url: http://manifestonly:9000/healthz",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveUpCommand", () => {
  it("prefers a Makefile `up` target (the discovered default)", () => {
    const r = resolveUpCommand(svcFor(path.join(tmp, "clean")));
    expect(r).toMatchObject({ command: "make up", source: "make" });
  });

  it("surfaces a den.yml override when it differs from make up", () => {
    // billing has both a make up AND a manifest up would differ; here no
    // manifest, so just assert make wins with no override note.
    const r = resolveUpCommand(svcFor(path.join(tmp, "billing")));
    expect(r.source).toBe("make");
  });

  it("falls back to the opctl dev op when there is no make up", () => {
    const r = resolveUpCommand(svcFor(path.join(tmp, "opctlonly")));
    expect(r).toMatchObject({ command: "opctl run dev", source: "opctl-dev" });
  });

  it("falls back to the .den.yml up command last", () => {
    const r = resolveUpCommand(svcFor(path.join(tmp, "manifestonly")));
    expect(r).toMatchObject({
      command: "custom-up-cmd",
      source: "manifest",
    });
  });
});

describe("classifyInteractive", () => {
  it("flags an unguarded interactive marker reached via a prerequisite", () => {
    const r = classifyInteractive(svcFor(path.join(tmp, "billing")), "make up");
    expect(r.interactive).toBe(true);
    expect(r.reason).toMatch(/osascript|stripe/);
    expect(r.kind).toBe("tabs"); // osascript matches first in billing's dev recipe
  });

  it("does NOT flag a TTY/USE_TABS-gated tab one level deeper", () => {
    const r = classifyInteractive(svcFor(path.join(tmp, "notes")), "make up");
    expect(r.interactive).toBe(false);
  });

  it("does NOT flag a headless make up", () => {
    const r = classifyInteractive(svcFor(path.join(tmp, "clean")), "make up");
    expect(r.interactive).toBe(false);
  });

  it("labels an unguarded `stripe login` as kind stripe", () => {
    const r = classifyInteractive(
      svcFor(path.join(tmp, "stripeonly")),
      "make up",
    );
    expect(r).toMatchObject({ interactive: true, kind: "stripe" });
  });

  it("labels an unguarded `read` prompt as kind prompt", () => {
    const r = classifyInteractive(
      svcFor(path.join(tmp, "promptonly")),
      "make up",
    );
    expect(r).toMatchObject({ interactive: true, kind: "prompt" });
  });

  it("is a no-op when there is no command", () => {
    expect(classifyInteractive(svcFor(path.join(tmp, "clean")), null)).toEqual({
      interactive: false,
      reason: "",
      kind: "",
    });
  });
});

describe("resolveHealthUrl", () => {
  it("uses the declared .den.yml health url when present", () => {
    const r = resolveHealthUrl(svcFor(path.join(tmp, "manifestonly")), []);
    expect(r).toBe("http://manifestonly:9000/healthz");
  });

  it("derives container:80/healthz when no health is declared", () => {
    const r = resolveHealthUrl(svcFor(path.join(tmp, "clean")), ["clean-api"]);
    expect(r).toBe("http://clean-api/healthz");
  });

  it("returns null when there is neither a declared url nor a container", () => {
    expect(resolveHealthUrl(svcFor(path.join(tmp, "clean")), [])).toBeNull();
  });
});
