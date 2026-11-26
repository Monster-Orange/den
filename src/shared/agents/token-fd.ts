import { spawn } from "child_process";
import * as os from "os";

export const TOKEN_FD = 3;

export function spawnWithTokenFd(
  argv: string[],
  o: {
    cwd: string;
    env: Record<string, string>;
    secret?: string;
    onStart?: (pid: number) => void;
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(argv[0]!, argv.slice(1), {
      cwd: o.cwd,
      env: o.env,
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });
    c.on("error", reject);
    c.on("exit", (code, sig) =>
      resolve(code ?? (sig ? 128 + (os.constants.signals[sig] ?? 1) : 1)),
    );
    if (c.pid !== undefined) o.onStart?.(c.pid);
    const fd = c.stdio[TOKEN_FD] as NodeJS.WritableStream | null;
    fd?.on("error", () => {});
    fd?.end(o.secret ?? "");
  });
}
