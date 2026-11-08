/**
 * SEC-2a: the commands the signed-out page prints (cli-command.ts) and the
 * names it gives the machines. Every printed command starts with `<cli>`
 * only when the first one on PATH is this distribution's; else with its
 * absolute path. Arguments and the ssh one-liner are shell-quoted. The
 * label people read is web.machine_name or the short hostname, never the
 * browser's Host; the ssh target is that Host.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cliCommand,
  cliPrefix,
  distributionBin,
  hostOfHeader,
  isIpLiteral,
  machineLabel,
  parseMachineName,
  parseSshUser,
  sshLogin,
  sshUser,
  shellQuote,
  shortHostname,
  sshCommand,
  sshTarget,
} from "../../../src/shared/cli-command.js";

/** A throwaway tree: a distribution with bin/<cli>, and other dirs on PATH. */
function tree() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-cli-cmd-")),
  );
  const exe = (f: string, body = "#!/bin/sh\necho ran\n") => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, { mode: 0o755 });
    return f;
  };
  return { root, exe };
}

describe("cliPrefix: <cli>, or the absolute path", () => {
  it("<cli> when the first one on PATH is this distribution's bin (a symlink to it counts)", () => {
    const { root, exe } = tree();
    try {
      const dist = path.join(root, "dist");
      const bin = exe(path.join(dist, "bin", "acme"));
      const pathDir = path.join(root, "on-path");
      fs.mkdirSync(pathDir);
      fs.symlinkSync(bin, path.join(pathDir, "acme"));
      expect(
        cliPrefix("acme", dist, path.join(root, "engine"), {
          pathEnv: pathDir,
        }),
      ).toBe("acme");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the absolute path when <cli> isn't on PATH at all", () => {
    const { root, exe } = tree();
    try {
      const dist = path.join(root, "dist");
      const bin = exe(path.join(dist, "bin", "acme"));
      expect(
        cliPrefix("acme", dist, path.join(root, "engine"), { pathEnv: "" }),
      ).toBe(bin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the absolute path when the <cli> on PATH is another distribution's", () => {
    const { root, exe } = tree();
    try {
      const dist = path.join(root, "dist");
      const bin = exe(path.join(dist, "bin", "acme"));
      const other = exe(path.join(root, "other", "bin", "acme"));
      expect(
        cliPrefix("acme", dist, path.join(root, "engine"), {
          pathEnv: [path.dirname(other), path.dirname(bin)].join(
            path.delimiter,
          ),
        }),
      ).toBe(bin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("with no bin/<cli> shim, the engine's bin/den; with neither, <cli>", () => {
    const { root, exe } = tree();
    try {
      const engineBin = exe(path.join(root, "engine", "bin", "den"));
      expect(
        distributionBin(
          "acme",
          path.join(root, "dist"),
          path.join(root, "engine"),
        ),
      ).toBe(engineBin);
      expect(
        cliPrefix("acme", path.join(root, "dist"), path.join(root, "engine"), {
          pathEnv: "",
        }),
      ).toBe(engineBin);
      expect(
        cliPrefix("acme", path.join(root, "none"), path.join(root, "none"), {
          pathEnv: "",
        }),
      ).toBe("acme");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the command it prints runs: an absolute path with a space, quoted", () => {
    const { root, exe } = tree();
    try {
      const dist = path.join(root, "my dist");
      exe(path.join(dist, "bin", "acme"), '#!/bin/sh\necho "ran $*"\n');
      const prefix = cliPrefix("acme", dist, path.join(root, "engine"), {
        pathEnv: "",
      });
      const line = cliCommand(prefix, "web", "approve", "K7Q-42M");
      expect(line).toBe(`'${dist}/bin/acme' web approve K7Q-42M`);
      const r = spawnSync("/bin/sh", ["-c", line], { encoding: "utf-8" });
      expect([r.status, r.stdout.trim()]).toEqual([
        0,
        "ran web approve K7Q-42M",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("quoting", () => {
  it("a safe word as it is; anything else single-quoted, a quote escaped", () => {
    expect(shellQuote("web")).toBe("web");
    expect(shellQuote("http://box.example:7777")).toBe(
      "http://box.example:7777",
    );
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$(rm)")).toBe("'$(rm)'");
  });

  it("the ssh one-liner quotes the remote command once more, for the far shell", () => {
    expect(
      sshCommand(
        "box.example",
        "/opt/my dist/bin/acme web login --origin http://box.example:7777",
      ),
    ).toBe(
      `ssh box.example '/opt/my dist/bin/acme web login --origin http://box.example:7777'`,
    );
    const remote = cliCommand(
      "/opt/my dist/bin/acme",
      "web",
      "approve",
      "K7Q-42M",
    );
    const line = sshCommand("box.example", remote);
    expect(line).toBe(
      `ssh box.example ''\\''/opt/my dist/bin/acme'\\'' web approve K7Q-42M'`,
    );
    // What ssh hands the far side is the remote command, intact.
    const r = spawnSync(
      "/bin/sh",
      ["-c", line.replace(/^ssh box\.example /, "printf '%s' ")],
      { encoding: "utf-8" },
    );
    expect(r.stdout).toBe(remote);
  });
});

describe("the two host values", () => {
  it("the label: web.machine_name when set, else the short hostname", () => {
    expect(machineLabel("Studio", "mac-studio.localdomain")).toBe("Studio");
    expect(machineLabel(null, "Mac-Studio.localdomain")).toBe("Mac-Studio");
    expect(machineLabel("  ", "devbox")).toBe("devbox");
    expect(shortHostname("192.168.1.5")).toBe("192.168.1.5");
  });

  it("with a service-name Host, the label is the machine's and the ssh target is the Host", () => {
    const host = "svc.example.test:7443";
    expect(machineLabel(null, "Mac-Studio.localdomain")).toBe("Mac-Studio");
    expect(sshTarget(host, "Mac-Studio.localdomain")).toBe("svc.example.test");
  });

  it("the ssh target: the Host minus its port; no Host, os.hostname(); a name or an IP literal", () => {
    expect(hostOfHeader("Box.Example:7777")).toBe("box.example");
    expect(hostOfHeader("[fd00::1]:7777")).toBe("fd00::1");
    expect(sshTarget(undefined, "devbox")).toBe("devbox");
    expect(sshTarget("-oProxyCommand=x", "devbox")).toBe("devbox");
    expect(isIpLiteral("100.64.0.1")).toBe(true);
    expect(isIpLiteral("fd00::1")).toBe(true);
    expect(isIpLiteral("box.example")).toBe(false);
  });

  it('web.ssh_user (SEC-2a-UX): an account name, or "" for none; unset is the account Den runs as', () => {
    expect(parseSshUser(undefined)).toBeUndefined();
    expect(parseSshUser(null)).toBeUndefined();
    expect(parseSshUser("")).toBe("");
    expect(parseSshUser(" ops ")).toBe("ops");
    expect(parseSshUser("first.last_2-x")).toBe("first.last_2-x");
    for (const bad of ["a@b", "-oProxyCommand=x", "two words", "x;y", 7, true])
      expect(() => parseSshUser(bad)).toThrow(/web\.ssh_user must be/);
    expect(sshUser(undefined, "alex")).toBe("alex");
    expect(sshUser("ops", "alex")).toBe("ops");
    expect(sshUser("", "alex")).toBe("");
    // An account ssh couldn't take is left off, never sent.
    expect(sshUser(undefined, "DOMAIN\\me")).toBe("");
    expect(sshLogin("box.example", "alex")).toBe("alex@box.example");
    expect(sshLogin("box.example", "")).toBe("box.example");
  });

  it("web.machine_name: one line of text, at most 64 characters; blank is unset", () => {
    expect(parseMachineName(undefined)).toBeNull();
    expect(parseMachineName("  ")).toBeNull();
    expect(parseMachineName(" Studio ")).toBe("Studio");
    expect(() => parseMachineName(7)).toThrow(/web\.machine_name/);
    expect(() => parseMachineName("a\nb")).toThrow(/one line/);
    expect(() => parseMachineName("x".repeat(65))).toThrow(/64/);
  });
});
