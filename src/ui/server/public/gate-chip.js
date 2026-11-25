/**
 * Issue 144 GATE-SLOT: the Agents page's gate chip. Heavy test runs on this
 * machine take turns (`<cli> gate run`); the chip says who holds the
 * machine now ("Gate: browser tests · Den · repo · agent:coder · until
 * 06:14") and how many wait. A press opens the queue: each run, when it
 * should end or start, and End early (a person's only: the route refuses
 * an agent). End early asks first (the kit's dialog), then goes through
 * the working pop-up. Ending a slot frees it; the run itself is not
 * stopped. Issue 715: a release run with priority says so, and why. The queue is a dialog on the body, so Report finds it.
 * Issue 795: a waiting run that let another go ahead says which, until it starts.
 * Issue 803: with classes set, each run's class, and a wait for its window.
 * Issue 1132: a run whose command waits for the load to drop under the
 * start ceiling says so; what was stopped of ended runs (last hour) shows
 * under the queue.
 *
 *   const chip = startGateChip({ button, t, api, busyAction, confirm, onChange });
 *   chip.refresh();          ask again now
 *   chip.tagFor("agent:x")   the row tag's text for an agent holding or
 *                            waiting, or ""
 */
import { formatTime } from "/kit/time.js";
import { dismissable } from "/popover.js";

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** A slot's time in the person's chosen zone: the kit's (issue 668). */
export const gateTime = (iso) => formatTime(iso, { style: "time" });
const hm = gateTime;

/** Issue 1132: a granted run held by the start ceiling, in words ("" if not). */
export function startHoldWords(s, t) {
  return s.startHold
    ? t("gate.startHold", {
        load: String(s.startHold.load),
        limit: String(s.startHold.limit),
      })
    : "";
}

/** Issue 1132: what was stopped of an ended run, in words. */
export function leftoverWords(l, t) {
  return t("gate.leftovers", { n: l.count, cmd: l.cmd, label: l.label });
}

export function startGateChip(o) {
  const { button, t } = o;
  const kind = (k) =>
    t(k === "browser" ? "gate.kind.browser" : "gate.kind.cpu");
  let slots = [];
  let boxes = [];
  let leftovers = [];
  // Issue 1274: this machine's free memory and what its VMs reserve.
  let machine = null;
  let pop = null;
  let release = null;
  let timer = 0;

  function chipText() {
    const held = slots.filter((s) => s.granted);
    const waiting = slots.length - held.length;
    const first = held[0];
    if (!first) return "";
    return (
      t("gate.chip", {
        kind: kind(first.kind),
        who: first.who,
        at: hm(first.expectedEnd),
      }) + (waiting ? t("gate.chipWaiting", { n: waiting }) : "")
    );
  }

  function paintChip() {
    const text = chipText();
    button.hidden = !text;
    button.textContent = text;
    button.dataset.over = slots.some((s) => s.overrun) ? "1" : "";
    if (pop) paintPop();
  }

  function lineHtml(s) {
    const when =
      (s.granted
        ? t("gate.holds", { kind: kind(s.kind), at: hm(s.expectedEnd) }) +
          (s.overrun ? " · " + t("gate.over") : "")
        : t("gate.waits", { kind: kind(s.kind), at: hm(s.expectedStart) })) +
      // Issue 625: the test box a slot is on, or may go to.
      (s.box
        ? " · " + t("gate.onBox", { box: s.box })
        : s.where === "any"
          ? " · " + t("gate.anyBox")
          : s.where
            ? " · " + t("gate.onBox", { box: s.where })
            : "");
    // Issue 625 clause 11: a box this run can't use, and why.
    const skips = (s.skips || [])
      .map((x) => t("gate.boxSkip", { box: x.box, reason: x.reason }))
      .join(" · ");
    // Issue 715: a release run a person waits on, and why.
    const pri = s.priority
      ? t(
          s.granted || s.priority.holds
            ? "gate.priority"
            : "gate.priorityWaits",
          { reason: s.priority.reason },
        )
      : "";
    // Issue 795: the waiting runs it let go just ahead of it.
    const ylds = (s.yieldedTo ?? [])
      .map((id) => slots.find((x) => x.id === id)?.label ?? id)
      .join(", ");
    const yld = ylds ? t("gate.yielded", { to: ylds }) : "";
    // Issue 803: its class (from settings), and a wait for its window.
    const cls = s.class
      ? t("gate.class", { name: s.class }) +
        (s.window ? " · " + t("gate.window", { window: s.window }) : "")
      : "";
    // Issues 1009, 1048: a cpu run held by the machine's load.
    const hold = !s.loadHold
      ? ""
      : s.loadHold.why === "cores"
        ? t("gate.loadHoldCores", {
            load: String(s.loadHold.load),
            limit: String(s.loadHold.limit),
            perCore: String(s.loadHold.perCore),
            cores: String(s.loadHold.cores),
          })
        : t("gate.loadHold", {
            load: String(s.loadHold.load),
            limit: String(s.loadHold.limit),
          });
    // Issue 1274: a run here held by low memory.
    // Issue 1349: an unknown reading holds, and says so (no number).
    const mem = s.memoryHold?.unavailable
      ? t("gate.memoryUnavailableHold")
      : s.memoryHold
        ? t("gate.memoryHold", {
            free: String(s.memoryHold.free),
            limit: String(s.memoryHold.limit),
          })
        : "";
    const sw = s.swapHold?.unavailable
      ? s.memoryHold?.unavailable
        ? ""
        : t("gate.memoryUnavailableHold")
      : s.swapHold
        ? t("gate.swapHold", {
            used: String(s.swapHold.usedGb),
            limit: String(s.swapHold.limitGb),
          })
        : "";
    return (
      '<li class="gate-li" data-gate-id="' +
      esc(s.id) +
      '"><div class="gate-who">' +
      esc(s.who) +
      ' · <span class="mono">' +
      esc(s.label) +
      '</span></div><div class="gate-when">' +
      esc(when) +
      "</div>" +
      (pri ? '<div class="gate-pri">' + esc(pri) + "</div>" : "") +
      (skips ? '<div class="gate-pri">' + esc(skips) + "</div>" : "") +
      (yld ? '<div class="gate-pri">' + esc(yld) + "</div>" : "") +
      (cls ? '<div class="gate-pri">' + esc(cls) + "</div>" : "") +
      (hold
        ? '<div class="gate-pri" data-gate-load-hold>' + esc(hold) + "</div>"
        : "") +
      (s.startHold
        ? '<div class="gate-pri" data-gate-start-hold>' +
          esc(startHoldWords(s, t)) +
          "</div>"
        : "") +
      (mem
        ? '<div class="gate-pri" data-gate-memory-hold>' + esc(mem) + "</div>"
        : "") +
      (sw
        ? '<div class="gate-pri" data-gate-swap-hold>' + esc(sw) + "</div>"
        : "") +
      // Issue 999: a padded estimate, and what the queue uses instead.
      (s.padded && s.expected
        ? '<div class="gate-pri" data-gate-padded>' +
          esc(
            t("gate.padded", {
              est: s.estimate?.minutes ?? "?",
              usual: s.expected.minutes,
            }),
          ) +
          "</div>"
        : "") +
      '<button type="button" class="den-btn sm" data-gate-end>' +
      esc(t("gate.end")) +
      "</button></li>"
    );
  }

  /**
   * Issue 1274: this machine: its free memory, and what running VMs
   * reserve against the share of its RAM ("not counted" when unread).
   */
  function machineHtml(m) {
    if (!m) return "";
    const gb = (b) => String(Math.round(b / 1024 ** 3));
    const rows = [];
    // Issue 1349: the guard is off on this platform, or its reading is unknown.
    if (m.notMeasured) rows.push(esc(t("gate.memoryNotMeasured")));
    else if (m.unavailable) rows.push(esc(t("gate.memoryUnavailable")));
    if (typeof m.freeMemory === "number")
      rows.push(esc(t("gate.freeMemory", { free: String(m.freeMemory) })));
    if (typeof m.swapUsedGb === "number")
      rows.push(esc(t("gate.swapUsed", { used: String(m.swapUsedGb) })));
    if (Array.isArray(m.vms) && (m.vms.length || m.notCounted?.length)) {
      const vars = {
        promised: gb(m.promisedBytes),
        limit: gb(m.ramBytes * (m.share ?? 1)),
      };
      rows.push(
        m.over
          ? "<span data-gate-vms-over>⚠ " +
              esc(t("gate.vmsOver", vars)) +
              "</span>"
          : esc(t("gate.vms", vars)),
      );
      for (const v of m.vms)
        rows.push(
          '<span class="mono">' +
            esc(v.name) +
            "</span> · " +
            esc(gb(v.memBytes)) +
            " GB · " +
            esc(String(v.cpus)) +
            " cpu",
        );
      for (const n of m.notCounted ?? [])
        rows.push(esc(t("gate.vmsNotCounted", { runtime: n })));
    }
    return rows.length
      ? '<div class="gate-pri" data-gate-machine>' +
          rows.join("<br>") +
          "</div>"
      : "";
  }

  /** Issue 625: a test box: its slots held, or why it is skipped. */
  function boxHtml(b) {
    // Turned off, or outside its window (shown in this viewer's time).
    const text =
      b.state === "off"
        ? t("gate.boxOff", { box: b.name })
        : b.state === "window"
          ? t("gate.boxClosed", {
              box: b.name,
              time: b.opensAt ? gateTime(b.opensAt) : b.opens || "",
            })
          : b.state === "held" ||
              b.state === "unreachable" ||
              b.state === "low" ||
              b.state === "unknown"
            ? t(
                b.state === "held"
                  ? "gate.boxHeld"
                  : b.state === "low"
                    ? "gate.boxLow"
                    : b.state === "unknown"
                      ? "gate.boxMemUnknown"
                      : "gate.boxDown",
                { box: b.name, reason: b.reason || "" },
              )
            : t("gate.boxSlots", { box: b.name, held: b.held, n: b.slots });
    return (
      '<li class="gate-box" data-gate-box="' +
      esc(b.name) +
      '">' +
      esc(text) +
      "</li>"
    );
  }

  function paintPop() {
    pop.innerHTML =
      '<h2 class="gate-h" id="gate-pop-h">' +
      esc(t("gate.popH")) +
      "</h2>" +
      (slots.length
        ? '<ul class="gate-ul">' + slots.map(lineHtml).join("") + "</ul>"
        : '<p class="gate-none">' + esc(t("gate.none")) + "</p>") +
      (boxes.length
        ? '<h3 class="gate-h">' +
          esc(t("gate.boxesH")) +
          '</h3><ul class="gate-ul">' +
          boxes.map(boxHtml).join("") +
          "</ul>"
        : "") +
      (leftovers.length
        ? '<h3 class="gate-h">' +
          esc(t("gate.leftoversH")) +
          '</h3><ul class="gate-ul" data-gate-leftovers>' +
          leftovers
            .map(
              (l) =>
                '<li class="gate-box">' +
                esc(hm(l.at) + " · " + leftoverWords(l, t)) +
                "</li>",
            )
            .join("") +
          "</ul>"
        : "") +
      machineHtml(machine);
  }

  async function endIt(li, btn) {
    const s = slots.find((x) => x.id === li.dataset.gateId);
    if (!s) return;
    const sure = await o.confirm({
      title: t("gate.endT"),
      message: t("gate.endQ", { label: s.label }),
      okLabel: t("gate.endGo"),
      danger: true,
    });
    if (!sure) return;
    await o.busyAction(
      "gate-end",
      (headers) =>
        o.api("POST", "/api/gate-slots/end", { id: s.id }, { headers }),
      { button: btn, vars: { name: s.label } },
    );
    await refresh();
  }

  function close(refocus) {
    if (!pop) return;
    release?.();
    release = null;
    pop.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  }

  function open() {
    pop = document.createElement("div");
    pop.className = "den-pop gate-pop";
    pop.id = "ag-gate-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "gate-pop-h");
    paintPop();
    // On the body, as every Den pop-up is (Report finds it there), under
    // the chip.
    const r = button.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(16, Math.min(r.left, window.innerWidth - 16 - Math.min(420, window.innerWidth - 32))))}px`;
    document.body.append(pop);
    button.setAttribute("aria-expanded", "true");
    pop.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-gate-end]");
      const li = btn?.closest(".gate-li");
      if (li) void endIt(li, btn);
    });
    release = dismissable(pop, { opener: button, close });
    pop.querySelector("button")?.focus();
  }

  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => (pop ? close(true) : open()));

  async function refresh() {
    clearTimeout(timer);
    try {
      const r = await fetch("/api/gate-slots", {
        headers: { accept: "json" },
      });
      if (r.ok) {
        const before = JSON.stringify(slots);
        const body = await r.json();
        slots = body.slots ?? [];
        boxes = body.boxes ?? [];
        leftovers = body.leftovers ?? [];
        machine = body.machine ?? null;
        paintChip();
        if (JSON.stringify(slots) !== before) o.onChange?.();
      }
    } catch {
      /* the last view stays */
    }
    timer = setTimeout(refresh, document.hidden ? 60_000 : 15_000);
  }
  void refresh();

  return {
    refresh,
    tagFor(actor) {
      const s = slots.find((x) => x.actor && x.actor === actor);
      if (!s) return "";
      return t(s.granted ? "gate.rowHolds" : "gate.rowWaits", {
        kind: kind(s.kind),
      });
    },
  };
}
