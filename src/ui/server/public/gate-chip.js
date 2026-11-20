/**
 * Issue 144 GATE-SLOT: the Agents page's gate chip. Heavy test runs on this
 * machine take turns (`<cli> gate run`); the chip says who holds the
 * machine now ("Gate: browser tests · Den · repo · agent:coder · until
 * 06:14") and how many wait. A press opens the queue: each run, when it
 * should end or start, and End early (a person's only: the route refuses
 * an agent). End early asks first (the kit's dialog), then goes through
 * the working pop-up. Ending a slot frees it; the run itself is not
 * stopped. Issue 715: a release run with priority says so, and why. The queue is a dialog on the body, so Report finds it.
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

export function startGateChip(o) {
  const { button, t } = o;
  const kind = (k) =>
    t(k === "browser" ? "gate.kind.browser" : "gate.kind.cpu");
  let slots = [];
  let boxes = [];
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
    // Issue 715: a release run a person waits on, and why.
    const pri = s.priority
      ? t(
          s.granted || s.priority.holds
            ? "gate.priority"
            : "gate.priorityWaits",
          { reason: s.priority.reason },
        )
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
      '<button type="button" class="den-btn sm" data-gate-end>' +
      esc(t("gate.end")) +
      "</button></li>"
    );
  }

  /** Issue 625: a test box: its slots held, or why it is skipped. */
  function boxHtml(b) {
    const text =
      b.state === "held" || b.state === "unreachable"
        ? t(b.state === "held" ? "gate.boxHeld" : "gate.boxDown", {
            box: b.name,
            reason: b.reason || "",
          })
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
        : "");
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
