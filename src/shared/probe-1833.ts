import * as fs from "fs";

export async function timed<T>(label: string, p: Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await p;
  } finally {
    mark(label, Date.now() - t, t);
  }
}

export function mark(label: string, ms = 0, at = Date.now()): void {
  const f = process.env.DEN_PROBE_1833;
  if (!f) return;
  try {
    fs.appendFileSync(f, `${at} ${ms} ${process.pid} ${label}\n`);
  } catch {
    return;
  }
}
