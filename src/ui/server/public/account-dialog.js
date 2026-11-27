import { dialogNavHtml, hydrateDialogNav } from "/kit/dialog-nav.js";

const WORDS = {
  en: {
    "acd.title": "Account",
    "acd.profile": "Profile",
    "acd.access": "Access",
    "acd.devices": "Devices",
    "acd.notifications": "Notifications",
    "acd.group": "You",
    "acd.name": "Name",
    "acd.login": "GitHub",
    "acd.role": "Role",
    "acd.local": "This computer",
    "acd.profileD": "Who is signed in to this Den, here.",
  },
  es: {
    "acd.title": "Cuenta",
    "acd.profile": "Perfil",
    "acd.access": "Acceso",
    "acd.devices": "Dispositivos",
    "acd.notifications": "Notificaciones",
    "acd.group": "Tú",
    "acd.name": "Nombre",
    "acd.login": "GitHub",
    "acd.role": "Rol",
    "acd.local": "Este equipo",
    "acd.profileD": "Quién ha iniciado sesión en este Den, aquí.",
  },
  ja: {
    "acd.title": "アカウント",
    "acd.profile": "プロフィール",
    "acd.access": "アクセス",
    "acd.devices": "デバイス",
    "acd.notifications": "通知",
    "acd.group": "あなた",
    "acd.name": "名前",
    "acd.login": "GitHub",
    "acd.role": "役割",
    "acd.local": "このコンピューター",
    "acd.profileD": "この Den に、ここでサインインしている人。",
  },
};

const ICONS = {
  profile: "person",
  access:
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  devices:
    '<rect x="3" y="5" width="18" height="11" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  notifications:
    '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
};

const shell = () => window.denShell;
const t = (k) => shell()?.t?.(k) ?? WORDS.en[k] ?? k;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let dn = null;
let building = null;

function ensureCss() {
  if (document.querySelector('link[href$="/kit/dialog-nav.css"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/kit/dialog-nav.css";
  document.head.append(l);
}

function profileStub(body) {
  const id = shell()?.getState?.()?.identity ?? {};
  const gh = id.kind === "github" ? id : (id.owner ?? null);
  const row = (k, v) =>
    `<div class="dn-kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  body.innerHTML = gh?.login
    ? (gh.name ? row(t("acd.name"), gh.name) : "") +
      row(t("acd.login"), "@" + gh.login) +
      (gh.role ? row(t("acd.role"), gh.role) : "")
    : row(t("acd.name"), t("acd.local"));
}

async function build() {
  for (const [l, m] of Object.entries(WORDS)) shell()?.addMessages?.(l, m);
  let panes = null;
  try {
    panes = await import("/account-panes.js");
  } catch {
    panes = null;
  }
  const ids = panes?.ACCOUNT_PANES ?? ["profile"];
  let adminHref = null;
  if (panes) {
    const r = await fetch("/api/account", { credentials: "same-origin" })
      .then((x) => (x.ok ? x.json() : null))
      .catch(() => null);
    adminHref = r?.adminHref ?? null;
  }
  ensureCss();
  const lang = shell()?.lang?.() ?? document.documentElement.lang ?? "en";
  const here = new URL(location.href);
  here.searchParams.delete("account");
  const wrap = document.createElement("div");
  wrap.innerHTML = dialogNavHtml({
    id: "den-account",
    kind: "account",
    param: "account",
    title: t("acd.title"),
    href: here.pathname + here.search,
    shown: false,
    lang,
    groups: [
      {
        label: t("acd.group"),
        panes: ids.map((id) => ({
          id,
          title: t("acd." + id),
          icon: ICONS[id],
          desc: id === "profile" && !panes ? t("acd.profileD") : undefined,
          lazy: true,
        })),
      },
    ],
    cross: { href: "/settings" },
    foot: adminHref ? [{ href: adminHref, label: "Admin ↗" }] : [],
  });
  const dialog = wrap.firstElementChild;
  document.body.append(dialog);
  return hydrateDialogNav(dialog, {
    lang,
    load: (pane, body) =>
      panes
        ? panes.loadAccountPane(pane, body, { t, shell: shell() })
        : profileStub(body),
  });
}

export async function openAccount(pane, from) {
  building ??= build();
  dn ??= await building;
  dn?.open(pane || null, null, from ?? null);
  return dn;
}
