/**
 * AG-DROP: drop or paste a file onto an agent's terminal pane, or pick one
 * with its Attach button (touch). The browser may be on another machine,
 * so the file goes to Den's server over Den's own HTTPS
 * (`POST /api/sessions/<id>/uploads`), which writes it where the agent can
 * read it; then its absolute path is typed at the cursor, shell-quoted,
 * several space-separated, with a trailing space and no Enter: what a
 * native terminal's drop types. A paste of plain text stays a paste.
 *
 *   wireDrop(el, { id, name, typeIn, csrf, t })   on a pane's element
 *   attachFiles(el, files, opts)                   the Attach button's pick
 *   shellQuote(path)                               one shell word
 */

/** A path as a shell reads it back as one word (shared/agents/uploads.ts). */
export function shellQuote(p) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * The files a paste carries: its files, else its items of kind "file" (a
 * copied screenshot is only an item in some browsers).
 */
export function clipboardFiles(cd) {
  const files = Array.from(cd?.files ?? []);
  if (files.length) return files;
  return Array.from(cd?.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter(Boolean);
}

/** Whether a drag carries files (not text or a link). */
export function dragHasFiles(dt) {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** How long a done or failed chip stays. */
const DONE_MS = 2_500;
const FAIL_MS = 12_000;

function chips(el) {
  let box = el.querySelector(".agup");
  if (!box) {
    box = document.createElement("div");
    box.className = "agup";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    el.querySelector(".term")?.append(box);
  }
  return box;
}

function chip(el, name) {
  const c = document.createElement("div");
  c.className = "agup-c";
  c.innerHTML = `<span class="agup-n mono"></span><span class="agup-s"></span>`;
  c.querySelector(".agup-n").textContent = name;
  chips(el).append(c);
  return {
    set(text, tone) {
      c.dataset.tone = tone ?? "";
      c.querySelector(".agup-s").textContent = text;
    },
    done(ms) {
      setTimeout(() => {
        c.remove();
        const box = el.querySelector(".agup");
        if (box && !box.children.length) box.remove();
      }, ms);
    },
  };
}

/** A pasted image's name: Chrome calls each "image.png". */
function fileName(f, i) {
  const n = f.name && f.name !== "image.png" ? f.name : "";
  if (n) return n;
  const ext = (f.type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
  return `pasted${i ? `-${i + 1}` : ""}.${ext}`;
}

/**
 * Send one file; resolves to its path on the server, or throws with the
 * server's reason. A stale CSRF token is asked for again once.
 */
function send(id, file, name, csrf, onProgress, fresh = false) {
  return csrf(fresh).then(
    (token) =>
      new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(
          "POST",
          `/api/sessions/${encodeURIComponent(id)}/uploads?name=${encodeURIComponent(name)}`,
        );
        x.withCredentials = true;
        if (token) x.setRequestHeader("X-Den-CSRF", token);
        x.setRequestHeader(
          "Content-Type",
          file.type || "application/octet-stream",
        );
        x.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        x.onload = () => {
          let b = null;
          try {
            b = JSON.parse(x.responseText);
          } catch {
            /* not JSON */
          }
          if (x.status === 200 && typeof b?.path === "string")
            return resolve(b.path);
          const err = new Error(
            typeof b?.error === "string" ? b.error : `HTTP ${x.status}`,
          );
          err.code = b?.code;
          err.status = x.status;
          reject(err);
        };
        x.onerror = () => reject(new Error("the upload failed"));
        x.onabort = () => reject(new Error("the upload was stopped"));
        x.send(file);
      }),
  );
}

/**
 * Send `files` for the pane `el`, one chip each, then type every path that
 * arrived, in order. Resolves to the paths typed.
 */
export async function attachFiles(el, files, opts) {
  const { id, typeIn, csrf, t } = opts;
  const list = Array.from(files ?? []);
  if (!list.length) return [];
  const paths = await Promise.all(
    list.map(async (f, i) => {
      const name = fileName(f, i);
      const c = chip(el, name);
      c.set(t("ag.up.sending"), "busy");
      const progress = (r) =>
        c.set(t("ag.up.pct", { n: Math.round(r * 100) }), "busy");
      try {
        let path;
        try {
          path = await send(id, f, name, csrf, progress);
        } catch (e) {
          if (e.status !== 403 || e.code !== "csrf") throw e;
          path = await send(id, f, name, csrf, progress, true);
        }
        c.set(t("ag.up.done"), "ok");
        c.done(DONE_MS);
        return path;
      } catch (e) {
        c.set(e?.message ?? String(e), "bad");
        c.done(FAIL_MS);
        return null;
      }
    }),
  );
  const ok = paths.filter(Boolean);
  if (ok.length) typeIn(`${ok.map(shellQuote).join(" ")} `);
  return ok;
}

/**
 * A pane takes drops and pasted files: an overlay while a file is over it,
 * then attachFiles. `opts.name()` is the agent's name now (the overlay's
 * words). `opts.can()` says whether the pane takes one now (a live session).
 * The whole pane takes the drag (its bar, terminal and To line). One that
 * can't take a file now still takes the drag and says why (`opts.why()`,
 * on the overlay, then `opts.say` when let go): never a silent drop.
 */
export function wireDrop(el, opts) {
  const { t } = opts;
  const term = el.querySelector(".term");
  let over = 0;
  const show = (on, why = "") => {
    el.classList.toggle("dropping", on);
    let ov = el.querySelector(".agdrop");
    if (on && !ov) {
      ov = document.createElement("div");
      ov.className = "agdrop";
      ov.setAttribute("aria-hidden", "true");
      term?.append(ov);
    }
    if (ov) {
      ov.classList.toggle("no", on && !!why);
      ov.innerHTML = on
        ? `<span>${esc(why || t("ag.up.drop", { name: opts.name() }))}</span>`
        : "";
    }
    if (!on) ov?.remove();
  };
  const why = () =>
    opts.can() ? "" : opts.why?.() || t("ag.up.cant", { name: opts.name() });
  el.addEventListener("dragenter", (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    over++;
    show(true, why());
  });
  el.addEventListener("dragover", (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const no = why();
    e.dataTransfer.dropEffect = no ? "none" : "copy";
    show(true, no);
  });
  el.addEventListener("dragleave", () => {
    over = Math.max(0, over - 1);
    if (!over) show(false);
  });
  el.addEventListener("drop", (e) => {
    over = 0;
    show(false);
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const no = why();
    if (no) {
      opts.say?.(no);
      return;
    }
    void attachFiles(el, e.dataTransfer.files, opts);
  });
  // Before xterm's own paste: files are ours, text stays its.
  el.addEventListener(
    "paste",
    (e) => {
      const files = clipboardFiles(e.clipboardData);
      if (!files.length) return;
      const no = why();
      e.preventDefault();
      e.stopImmediatePropagation();
      if (no) {
        opts.say?.(no);
        return;
      }
      void attachFiles(el, files, opts);
    },
    true,
  );
}

/**
 * A drop that misses every pane must not open the file in place of the
 * page (the browser's default): it is refused, and `onMiss` says where to
 * drop. A pane that took the drop has already prevented it.
 */
export function guardPageDrops(doc = document, onMiss) {
  doc.addEventListener("dragover", (e) => {
    if (dragHasFiles(e.dataTransfer)) e.preventDefault();
  });
  doc.addEventListener("drop", (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    const taken = e.defaultPrevented;
    e.preventDefault();
    if (!taken) onMiss?.();
  });
}

/** The Attach button's hidden picker, made once. */
export function pickFiles(onPick, doc = document) {
  let input = doc.getElementById("ag-attach-input");
  if (!input) {
    input = doc.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "ag-attach-input";
    input.hidden = true;
    doc.body.append(input);
  }
  input.value = "";
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length) onPick(files);
  };
  input.click();
}
