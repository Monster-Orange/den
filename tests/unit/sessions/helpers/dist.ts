/**
 * A throwaway distribution (product "acme") for running the real bin/den:
 * den.yml, an org config, two workspaces, and a state dir of its own
 * (ACME_HOME), so nothing touches the developer's ~/.den or ~/.acme.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ENGINE = path.resolve(__dirname, "../../../..");

export interface Dist {
  tmp: string;
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Run bin/den in the distribution: exit code and the output. */
  den(args: string[], input?: string): { code: number; out: string };
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function makeDist(
  prefix: string,
  config = "environments: [local]\n",
): Dist {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(tmp, "acme");
  const home = path.join(tmp, "home");
  write(path.join(root, "den.yml"), "product:\n  name: acme\n");
  write(path.join(root, "config", "acme.yml"), config);
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services: {}",
      "  south:",
      "    services: {}",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEN_ROOT: root,
    ACME_HOME: home,
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  return {
    tmp,
    root,
    home,
    env,
    den(args, input) {
      const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
        cwd: root,
        encoding: "utf-8",
        env,
        input,
        timeout: 60_000,
      });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
  };
}
