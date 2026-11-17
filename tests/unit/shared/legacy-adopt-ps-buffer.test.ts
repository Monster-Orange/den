/**
 * den#143: the process list a legacy record is decided from is the whole
 * list, however long it is. `ps -A -o …,command=` on a busy machine prints
 * more than Node's default 1 MiB buffer for a synchronous child (1.07 MB on
 * a build machine with 1,582 processes). With that default, the read stopped
 * at 1 MiB and the rows after it were silently missing, so a service listed
 * late was never adopted.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ps-buffer-"));
const ROWS = 30_000;
const LONG = "x".repeat(60);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hostProbe.processes on a machine whose ps prints more than 1 MiB", () => {
  it("reads every row, the last one too", async () => {
    // A `ps` that prints ROWS rows in the C-locale lstart format: about 2.6 MB.
    const ps = path.join(dir, "ps");
    fs.writeFileSync(
      ps,
      `#!/bin/sh\nawk 'BEGIN { for (i = 1; i <= ${ROWS}; i++) printf "%d %d S Thu Nov  5 10:00:00 2026 /usr/bin/svc ${LONG} %d\\n", i + 100, i + 100, i }'\n`,
    );
    fs.chmodSync(ps, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved ?? ""}`;
    try {
      // legacy-adopt reads PATH once, when it loads.
      const { hostProbe } =
        await import("../../../src/shared/process/legacy-adopt.js");
      const rows = hostProbe.processes();
      expect(rows).toHaveLength(ROWS);
      expect(rows[rows.length - 1]).toEqual({
        pid: ROWS + 100,
        pgid: ROWS + 100,
        lstart: "Thu Nov 5 10:00:00 2026",
        command: `/usr/bin/svc ${LONG} ${ROWS}`,
      });
    } finally {
      process.env.PATH = saved;
    }
  });
});
