/** Running the edge's CLIs (docker, mkcert): one place, one error shape. */
import { spawnSync } from "child_process";

export function sh(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
) {
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    env: { ...process.env, ...opts.env },
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  if (r.error) throw new Error(`${cmd} is not installed (${r.error.message})`);
  return {
    code: r.status ?? 1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

export function must(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  const r = sh(cmd, args, opts);
  if (r.code !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.err || r.out}`);
  return r.out;
}
