/**
 * Issue 597: the terminal host restarts only when its own code or its
 * terminal module changed. The host's code is its module graph: the files
 * reached from src/shared/sessions/host.ts by relative imports. Two
 * installs with the same files have the same code id, whatever their Den
 * version says.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  hostCodeFiles,
  hostCodeId,
} from "../../../src/shared/sessions/host-code.js";
import {
  hostCheck,
  hostStale,
} from "../../../src/shared/sessions/host-refresh.js";
import { fileIdentity, type PtyModuleInfo } from "../../../src/shared/sessions/pty.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

/** A copy of this checkout's host graph under a temp root. */
function copyGraph(root: string): string[] {
  const files = hostCodeFiles(ENGINE);
  for (const rel of files) {
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ENGINE, rel), to);
  }
  return files;
}

describe("hostCodeFiles and hostCodeId (issue 597)", () => {
  it("the graph starts at the host and holds what it imports, nothing from the web server", () => {
    const files = hostCodeFiles(ENGINE);
    expect(files[0]).toBe("src/shared/sessions/host.ts");
    expect(files).toEqual(
      expect.arrayContaining([
        "src/shared/sessions/host-code.ts",
        "src/shared/sessions/protocol.ts",
        "src/shared/sessions/pty.ts",
      ]),
    );
    expect(files.some((f) => f.startsWith("src/ui/"))).toBe(false);
  });

  it("two installs with the same host files have the same id; a changed or missing file changes it", () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hc-")));
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    copyGraph(a);
    copyGraph(b);
    // Another version's package.json, and a web server file that differs:
    // neither is the host's code.
    fs.writeFileSync(path.join(a, "package.json"), '{"version":"1.0.0"}');
    fs.writeFileSync(path.join(b, "package.json"), '{"version":"1.0.1"}');
    fs.mkdirSync(path.join(b, "src/ui"), { recursive: true });
    fs.writeFileSync(path.join(b, "src/ui/x.ts"), "export {};\n");
    const id = hostCodeId(a);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hostCodeId(b)).toBe(id);
    fs.appendFileSync(path.join(b, "src/shared/sessions/protocol.ts"), "\n// changed\n");
    expect(hostCodeId(b)).not.toBe(id);
    fs.rmSync(path.join(a, "src/shared/sessions/ring-buffer.ts"));
    expect(hostCodeId(a)).not.toBe(id);
  });

  it("no host entry: null", () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hc-")));
    expect(hostCodeId(tmp)).toBeNull();
  });
});

describe("hostCheck: restart only on a code or module difference (issue 597)", () => {
  const mod = (p: string): PtyModuleInfo => ({ path: p, version: "1", id: fileIdentity(p) });

  it("another Den version with the same code and module is current", () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hc-")));
    const file = path.join(tmp, "pty.node");
    fs.writeFileSync(file, "x");
    const inst = { den: "2", code: "sha256:aa", pty: mod(file) };
    expect(hostCheck({ den: "1", code: "sha256:aa", pty: mod(file) }, inst)).toBeNull();
    expect(hostStale({ den: "1", code: "sha256:aa", pty: null }, inst)).toBeNull();
  });

  it("a changed code id: host code changed", () => {
    const inst = { den: "2", code: "sha256:bb", pty: null };
    expect(hostCheck({ den: "1", code: "sha256:aa", pty: null }, inst)).toMatchObject({
      restart: "code",
    });
    // Either side unable to tell counts as changed.
    expect(hostCheck({ den: "2", code: null, pty: null }, inst)?.restart).toBe("code");
    expect(
      hostCheck({ den: "2", code: "sha256:bb", pty: null }, { ...inst, code: null })?.restart,
    ).toBe("code");
  });

  it("a host that answers its version but not its code is too old to say: restart", () => {
    const r = hostCheck({ den: "2", pty: null }, { den: "2", code: "sha256:aa", pty: null });
    expect(r).toMatchObject({ restart: "code" });
    expect(r!.why).toMatch(/older/);
    expect(hostCheck({ den: undefined, code: undefined, pty: null }, { den: "2", code: "x", pty: null })?.restart).toBe("code");
  });

  it("a replaced pty.node, or one gone: terminal module changed", () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hc-")));
    const file = path.join(tmp, "pty.node");
    fs.writeFileSync(file, "x");
    const held = mod(file);
    fs.rmSync(file);
    expect(hostCheck({ den: "2", code: "c", pty: held }, { den: "2", code: "c", pty: null })?.restart).toBe("module");
    fs.writeFileSync(file, "y");
    expect(
      hostCheck({ den: "2", code: "c", pty: held }, { den: "3", code: "c", pty: mod(file) }),
    ).toMatchObject({ restart: "module" });
  });
});
