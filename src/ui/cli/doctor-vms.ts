/**
 * Issue 1274: doctor's rows for the VMs on this machine. ⚠ when what
 * running VMs promise is over vm_memory_share × the machine's RAM (a
 * machine that promises more memory than it has was reset three times on
 * 11-22). Each running VM: its memory and cpus. A runtime it couldn't read:
 * "not counted".
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import { vmOvercommit, type VmReading } from "../../shared/gates/vms.js";

const gb = (b: number) => `${Math.round(b / 1024 ** 3)} GB`;

export function vmLines(r: VmReading): {
  lines: string[];
  check: OnboardCheck;
} {
  const running = r.vms.filter((v) => v.running);
  const o = vmOvercommit(r.vms, r.ramBytes, r.share);
  if (!running.length && !r.notCounted.length)
    return {
      lines: [],
      check: { id: "gate_vms", status: "ok", detail: "no VMs running" },
    };
  const head = `${gb(o.promised)} promised to VMs, of ${gb(o.limit)} allowed (${r.share} × ${gb(r.ramBytes)} RAM)`;
  const detail = o.over
    ? `${head}: the machine can run out of memory; stop or shrink a VM, or set gate_slots.vm_memory_share`
    : head;
  return {
    lines: [
      "",
      "VMs (gate)",
      "",
      `  ${o.over ? "⚠" : "✓"}  ${detail}`,
      ...running.map(
        (v) =>
          `     ${v.name} (${v.runtime})  ${gb(v.memBytes)}, ${v.cpus} cpus`,
      ),
      ...r.notCounted.map((n) => `     ${n}: not counted (couldn't read it)`),
    ],
    check: {
      id: "gate_vms",
      status: o.over ? "warn" : "ok",
      detail,
    },
  };
}
