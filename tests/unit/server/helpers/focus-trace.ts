import type { BrowserContext, Page } from "playwright";

export async function traceFocus(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const t0 = performance.now();
    const log: string[] = [];
    (window as unknown as { __trace: string[] }).__trace = log;
    const d = (el: Element | null) =>
      !el
        ? "null"
        : el === document.body
          ? "body"
          : `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).slice(0, 30)}${el.closest(".pane") ? `[pane ${(el.closest(".pane") as HTMLElement).dataset.id?.slice(0, 6)}]` : ""}${el.closest("#agl") ? "[list]" : ""}`;
    const at = () => Math.round(performance.now() - t0);
    for (const k of ["pointerdown", "keydown"])
      document.addEventListener(
        k,
        (e) =>
          log.push(
            `${at()} ${k} ${(e as KeyboardEvent).key ?? ""} target=${d(e.target as Element)} active=${d(document.activeElement)}`,
          ),
        true,
      );
    document.addEventListener(
      "focusin",
      (e) => log.push(`${at()} focusin ${d(e.target as Element)}`),
      true,
    );
    document.addEventListener(
      "focusout",
      (e) =>
        log.push(
          `${at()} focusout ${d(e.target as Element)} -> ${d(e.relatedTarget as Element)}`,
        ),
      true,
    );
    window.addEventListener("blur", () => log.push(`${at()} window blur`));
    window.addEventListener("focus", () => log.push(`${at()} window focus`));
    const f = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...a: unknown[]) {
      log.push(
        `${at()} focus() on ${d(this)} from ${(new Error().stack || "")
          .split("\n")
          .slice(2, 8)
          .map((l) => l.trim().replace(/https?:\/\/[^/]+/, ""))
          .join(" < ")}`,
      );
      return f.apply(this, a as []);
    };
    const b = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function () {
      log.push(
        `${at()} blur() on ${d(this)} from ${(new Error().stack || "")
          .split("\n")
          .slice(2, 6)
          .map((l) => l.trim().replace(/https?:\/\/[^/]+/, ""))
          .join(" < ")}`,
      );
      return b.apply(this);
    };
    const W = window.WebSocket;
    const sock = (w: WebSocket) =>
      new URL(w.url).pathname.split("/").slice(-2, -1)[0]?.slice(0, 6) ?? "?";
    const send = W.prototype.send;
    W.prototype.send = function (data: unknown) {
      const s =
        typeof data === "string" ? data.slice(0, 60) : `bin(${String((data as ArrayBuffer).byteLength ?? "?")})`;
      log.push(`${at()} ws-send [${sock(this)}] rs=${this.readyState} ${s}`);
      return send.call(this, data as string);
    };
    class Traced extends W {
      constructor(u: string | URL, pr?: string | string[]) {
        super(u, pr);
        this.addEventListener("open", () => log.push(`${at()} ws-open [${sock(this)}]`));
        this.addEventListener("close", (e) =>
          log.push(`${at()} ws-close [${sock(this)}] ${e.code}`),
        );
        log.push(`${at()} ws-new [${sock(this)}] ${new URL(String(u)).search}`);
      }
    }
    window.WebSocket = Traced as typeof WebSocket;
  });
}

export async function dumpTrace(p: Page, label: string): Promise<void> {
  const trace = await p.evaluate(
    () => (window as unknown as { __trace?: string[] }).__trace ?? [],
  );
  process.stdout.write(
    `\nTRACE-FAMILY ${label} active=${await p.evaluate(() => document.activeElement?.className ?? "")}\n${trace.map((l) => "  " + l).join("\n")}\nTRACE-FAMILY end\n`,
  );
}
