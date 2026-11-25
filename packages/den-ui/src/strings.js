/**
 * den-ui strings: every word the kit shows, in en, es and ja, keyed
 * "kit.<component>.<word>". Pure data plus a lookup: it runs in Node too,
 * so a server can render the kit in the right language from the first
 * byte. A product adds or overrides words with addStrings(lang, table)
 * (DenUI.strings(lang, table) in the page).
 *
 *   {name}   a var; a number is formatted for the language
 *   key.one  the form for n where Intl.PluralRules says "one"
 *   {product} the product name (setProduct, or vars.product)
 *
 * tests/unit/den-ui/strings-kit.test.ts fails when a language lacks a key.
 */
export const en = {
  "kit.update.msg": "A new version of {product} is available.",
  "kit.update.reload": "Reload",
  "kit.update.notNow": "Not now",
  "kit.update.cancel": "Cancel",
  "kit.update.ask": "You have unsaved text on this page. Reload anyway?",
  "kit.update.region": "Update",
  "kit.skip": "Skip to content",
  "kit.menu": "Menu",
  "kit.scope": "Scope",
  "kit.search.ph": "Search…",
  "kit.account.local": "Local",
  "kit.search.label": "Search",
  "kit.bell": "Notifications",
  "kit.bell.n": "Notifications: {n} unread",
  "kit.bell.empty": "Nothing new.",
  "kit.bell.needs": "Needs you",
  "kit.bell.earlier": "Earlier",
  "kit.bell.needsNone": "Nothing needs you now.",
  "kit.settings": "Settings",
  "kit.appearance": "Appearance",
  "kit.appearance.title": "Appearance and theme",
  "kit.mode.system": "System",
  "kit.mode.dark": "Dark",
  "kit.mode.light": "Light",
  "kit.theme": "Theme",
  "kit.language": "Language",
  "kit.menu.filter": "Filter {label}",
  "kit.menu.filter.ph": "Filter…",
  "kit.menu.none": "No match",
  "kit.pages": "Pages",
  "kit.collapse": "Collapse",
  "kit.expand": "Expand",
  "kit.from": "from {d}",
  "kit.report.word": "Report",
  "kit.report.tip": "Report an issue (⌘⇧F)",
  "kit.version.title": "View changelog",
  "kit.pin.pinX": "Pin {s}",
  "kit.pin.unpinX": "Unpin {s}",
  "kit.badge.open": "{n} open",
  "kit.badge.waiting": "{n} waiting",
  "kit.badge.down": "{n} down",
  "kit.badge.running": "{n} running",
  "kit.kind.project": "Project",
  "kit.kind.den": "Den",
  "kit.kind.service": "Service",
  "kit.kind.hub": "Hub",
  "kit.off.connect": "connect in Settings",
  "kit.off.reconnect": "reconnect in Settings",
  "kit.off.forbidden": "ask an admin for access",
  "kit.off.unreachable": "can't be reached right now",
  "kit.off.config": "check Settings",
  "kit.whatsnew.title": "What's new",
  "kit.whatsnew.close": "Close",
  "kit.whatsnew.gotIt": "Got it",
  "kit.whatsnew.none": "No entries found.",
  "kit.whatsnew.copyMd": "Copy as Markdown",
  "kit.whatsnew.copyMdX": "Copy v{v} as Markdown",
  "kit.whatsnew.copySlack": "Copy for Slack",
  "kit.whatsnew.copySlackX": "Copy v{v} for Slack",
  "kit.whatsnew.copyFailed": "Copy failed — try again",
  "kit.whatsnew.latest": "Show latest only",
  "kit.whatsnew.all": "Show all versions ({n} earlier)",
  "kit.whatsnew.all.one": "Show all versions ({n} earlier)",
  "kit.report.title": "Report an issue",
  "kit.report.sub":
    "Tell us what is wrong, or what you wish {product} did. It becomes a GitHub issue, filed as you.",
  "kit.report.step1": "1 Write",
  "kit.report.step2": "2 Include",
  "kit.report.step3": "3 Review and send",
  "kit.report.stepOf": "{i}/{n}",
  "kit.report.kind": "What is it?",
  "kit.report.k.bug": "Bug",
  "kit.report.k.idea": "Idea",
  "kit.report.k.question": "Question",
  "kit.report.titleL": "Title",
  "kit.report.desc": "What happened, and what did you expect?",
  "kit.report.shot": "Screenshot of this page",
  "kit.report.ncap":
    "This page couldn't be captured. You can send the report without a screenshot.",
  "kit.report.shotWait": "Taking the screenshot…",
  "kit.report.shotLateWait":
    "If you send before it's ready, the report goes without it.",
  "kit.report.shotLateIn":
    "Not included: check it and hide anything private first.",
  "kit.report.shotInclude": "Include it",
  "kit.report.shotFailed":
    "No screenshot: it couldn't be taken. You can send without it.",
  "kit.report.backReview": "Back to Review and send",
  "kit.report.shotNote":
    "Includes the open dialog or drawer. Drag on it to black out anything private.",
  "kit.report.nos": "Don't include a screenshot",
  "kit.report.undo": "Undo",
  "kit.report.masks": "{n} areas hidden",
  "kit.report.masks.one": "{n} area hidden",
  "kit.report.kbdMask": "Mask by size and position",
  "kit.report.mx": "Left %",
  "kit.report.my": "Top %",
  "kit.report.mw": "Width %",
  "kit.report.mh": "Height %",
  "kit.report.addMask": "Add area",
  "kit.report.maskAll": "Mask the whole screenshot",
  "kit.report.rmMask": "Remove",
  "kit.report.area": "{x}% from the left, {y}% from the top, {w}% × {h}%",
  "kit.report.revShot": "Screenshot after masking ({n} areas hidden)",
  "kit.report.revShot.one": "Screenshot after masking ({n} area hidden)",
  "kit.report.shareTo": "Your masked screenshot goes to {recipient}",
  "kit.report.shareNo": "Text only; the screenshot stays on your machine.",
  "kit.report.shotWent": "The masked screenshot went to {recipient}.",
  "kit.report.shotStayed": "The screenshot stays on your machine: {why}.",
  "kit.report.why.off": "sharing screenshots is turned off",
  "kit.report.why.not-maintained": "no one maintains that repo on Hub",
  "kit.report.why.not-a-person":
    "Hub takes screenshots from a person's connection only",
  "kit.report.why.conflict":
    "Hub already has a different screenshot for this report",
  "kit.report.why.too-big": "it is larger than Hub takes",
  "kit.report.why.not-png": "it isn't a PNG image",
  "kit.report.why.limit": "Hub's hourly limit is reached",
  "kit.report.why.unreachable": "Hub couldn't be reached",
  "kit.report.why.not-connected": "this computer isn't connected to Hub",
  "kit.report.why.refused": "Hub didn't take it",
  "kit.report.mine": "My reports",
  "kit.report.next": "Next: Include",
  "kit.report.back": "Back",
  "kit.report.send": "Send as a GitHub issue",
  "kit.report.later": "Finish later",
  "kit.report.cancel": "Cancel",
  "kit.report.dest": "Goes to",
  "kit.report.pub": "Public repository",
  "kit.report.priv": "Private repository",
  "kit.report.int": "Internal repository",
  "kit.report.unk": "Visibility not known",
  "kit.report.unkW":
    "Treat it as public: screenshots and text may be visible to everyone. Mask anything private.",
  "kit.report.privN": "Only people with access to this repository can see it.",
  "kit.report.privW":
    "Only people with access to this repository can see it: {who}.",
  "kit.report.pubW":
    "Screenshots and text are visible to everyone. Mask anything private.",
  "kit.report.incH": "What goes with your report",
  "kit.report.incN":
    "Each part says how {product} uses it. Secrets, tokens, emails, IP addresses and store references are always removed, whatever is ticked.",
  "kit.report.all": "Include all",
  "kit.report.none": "Include none",
  "kit.report.remember": "Remember my choices",
  "kit.report.redact":
    "Redact names (companies, projects, repos, services) as <org-1>, <repo-1> …",
  "kit.report.dgi": "How {product} uses this",
  "kit.report.sec.Den": "{product}",
  "kit.report.sec.Browser": "Browser",
  "kit.report.sec.Machine": "Machine",
  "kit.report.sec.Page": "Page",
  "kit.report.use.Den":
    "Which version you run, to find the change that caused it.",
  "kit.report.use.Browser": "The browser and window size, to see it as you do.",
  "kit.report.use.Machine": "The system it runs on, never who or where.",
  "kit.report.use.Page": "Which page and dialog were open.",
  "kit.report.revH": "Review: this is exactly what will be posted",
  "kit.report.siH": "Sign in with GitHub to send",
  "kit.report.siB":
    "Reports are filed as you, so GitHub's replies reach you. {product} shows a code; enter it at github.com/login/device. This is not {product}'s own sign-in.",
  "kit.report.noApp":
    "Sending needs GitHub. Save it with Finish later, or file it in a GitHub tab.",
  "kit.report.open": "Open github.com/login/device",
  "kit.report.codeL": "Your code",
  "kit.report.waiting": "Waiting for you to approve in GitHub…",
  "kit.report.siAlt": "Or open a new GitHub tab with the report filled in.",
  "kit.report.siAltLink": "Open a filled-in GitHub tab",
  "kit.report.expired":
    "The code expired before it was approved. Nothing was sent.",
  "kit.report.denied": "GitHub sign-in was cancelled. Nothing was sent.",
  "kit.report.dupH": "A report with this title is already open",
  "kit.report.dupB":
    "“{title}” is already open. Add your details to it instead of opening a second one?",
  "kit.report.addTo": "Add to the existing report",
  "kit.report.fileNew": "File a new report",
  "kit.report.sentH": "Report sent",
  "kit.report.sentB": "Your report is a GitHub issue now: “{title}”.",
  "kit.report.addedB": "Your details were added to the open report.",
  "kit.report.openIssue": "Open the issue",
  "kit.report.done": "Done",
  "kit.report.limH": "You have sent {n} reports this hour",
  "kit.report.limB":
    "Try again in {min} minutes. Your report is not lost: save it with Finish later and send it then.",
  "kit.report.latH": "Saved. Nothing was sent.",
  "kit.report.latB":
    "It is saved on this computer with your text, choices and screenshot. Find it under My reports, at the top of Report an issue or in the command palette.",
  "kit.report.failH": "Not sent",
  "kit.report.retry": "Try again",
  "kit.report.keepH": "Keep what you wrote?",
  "kit.report.keep": "Keep it (Finish later)",
  "kit.report.discard": "Discard",
  "kit.report.needTitle": "A title is needed.",
  "kit.report.filed": "Filed as #{n}",
  "kit.report.copy": "Copy report",
  "kit.report.copied": "Copied. Paste it where your team tracks issues.",
  "kit.report.copyFailed":
    "Could not copy. Select the text and copy it yourself.",
  "kit.report.copyH": "Copy the report",
  // The Markdown editor (markdown-editor.js, 0.7.5): its toolbar.
  "kit.md.toolbar": "Formatting",
  "kit.md.toolKey": "{name} ({key})",
  "kit.md.bold": "Bold",
  "kit.md.italic": "Italic",
  "kit.md.code": "Code",
  "kit.md.link": "Link",
  "kit.md.heading": "Heading",
  "kit.md.bulleted": "Bulleted list",
  "kit.md.numbered": "Numbered list",
  "kit.md.quote": "Quote",
  "kit.md.linkText": "text",
  // The save-state line (savestate.js). "Saved" has no closing stop.
  "kit.savestate.saving": "Saving…",
  "kit.savestate.saved": "Saved",
  "kit.savestate.error": "Not saved. Retrying…",
  "kit.savestate.copy": "Copy text",
  "kit.savestate.savedAt": "Saved at {time}",
  // The panel fold toggle and its edge strip (panel-fold.js). The strip's
  // count is worded by kit.badge.*.
  "kit.fold.panel": "Panel",
  "kit.fold.show": "Show panel",
  "kit.fold.hidden": "Panel, hidden",
  // The filter bar (filter-bar.js). A facet's and an option's labels are
  // the host's; {facet} and {value} are those.
  "kit.filter.button": "Filters",
  "kit.filter.buttonN": "Filters ({n})",
  "kit.filter.chosen": "Chosen filters",
  "kit.filter.chip": "{facet}:",
  "kit.filter.remove": "Remove {facet}: {value}",
  "kit.filter.clear": "Clear",
  "kit.filter.clearFacet": "Clear {facet}",
  "kit.filter.clearAll": "Clear all",
  // The bulk bar (bulk-bar.js). {label} is the host's action.
  "kit.bulk.selected": "{n} selected",
  "kit.bulk.clear": "Clear",
  "kit.bulk.cleared": "Selection cleared",
  "kit.bulk.action": "{label} {n}",
  // The page action menu (issue 555) and the settings row (issue 554).
  "kit.pmenu.more": "More",
  "kit.setrow.save": "Save",
  "kit.setrow.who": "{who} can change this",
  "kit.setrow.nobody": "Nobody can change this",
  "kit.setrow.last": "Last changed {time} by {who}",
  "kit.setrow.never": "No changes yet",
  "kit.setrow.error": "Not saved. Try again.",
  // Issue 584: the shared button verbs.
  "kit.verb.save": "Save",
  "kit.verb.cancel": "Cancel",
  "kit.verb.delete": "Delete",
  "kit.verb.close": "Close",
  "kit.verb.tryAgain": "Try again",
};

export const es = {
  "kit.update.msg": "Hay una nueva versión de {product}.",
  "kit.update.reload": "Recargar",
  "kit.update.notNow": "Ahora no",
  "kit.update.cancel": "Cancelar",
  "kit.update.ask":
    "Tienes texto sin guardar en esta página. ¿Recargar igualmente?",
  "kit.update.region": "Actualización",
  "kit.skip": "Saltar al contenido",
  "kit.menu": "Menú",
  "kit.scope": "Ámbito",
  "kit.search.ph": "Buscar…",
  "kit.account.local": "Local",
  "kit.search.label": "Buscar",
  "kit.bell": "Notificaciones",
  "kit.bell.n": "Notificaciones: {n} sin leer",
  "kit.bell.empty": "Nada nuevo.",
  "kit.bell.needs": "Te necesitan",
  "kit.bell.earlier": "Antes",
  "kit.bell.needsNone": "Nada te necesita ahora.",
  "kit.settings": "Ajustes",
  "kit.appearance": "Apariencia",
  "kit.appearance.title": "Apariencia y tema",
  "kit.mode.system": "Sistema",
  "kit.mode.dark": "Oscuro",
  "kit.mode.light": "Claro",
  "kit.theme": "Tema",
  "kit.language": "Idioma",
  "kit.menu.filter": "Filtrar {label}",
  "kit.menu.filter.ph": "Filtrar…",
  "kit.menu.none": "Sin coincidencias",
  "kit.pages": "Páginas",
  "kit.collapse": "Contraer",
  "kit.expand": "Expandir",
  "kit.from": "de {d}",
  "kit.report.word": "Informar",
  "kit.report.tip": "Informar de un problema (⌘⇧F)",
  "kit.version.title": "Ver el registro de cambios",
  "kit.pin.pinX": "Fijar {s}",
  "kit.pin.unpinX": "Quitar {s}",
  "kit.badge.open": "{n} abiertos",
  "kit.badge.open.one": "{n} abierto",
  "kit.badge.waiting": "{n} en espera",
  "kit.badge.down": "{n} caídos",
  "kit.badge.down.one": "{n} caído",
  "kit.badge.running": "{n} en marcha",
  "kit.kind.project": "Proyecto",
  "kit.kind.den": "Den",
  "kit.kind.service": "Servicio",
  "kit.kind.hub": "Hub",
  "kit.off.connect": "conéctalo en Ajustes",
  "kit.off.reconnect": "vuelve a conectarlo en Ajustes",
  "kit.off.forbidden": "pide acceso a un administrador",
  "kit.off.unreachable": "no responde ahora mismo",
  "kit.off.config": "revisa Ajustes",
  "kit.whatsnew.title": "Novedades",
  "kit.whatsnew.close": "Cerrar",
  "kit.whatsnew.gotIt": "Entendido",
  "kit.whatsnew.none": "No hay entradas.",
  "kit.whatsnew.copyMd": "Copiar como Markdown",
  "kit.whatsnew.copyMdX": "Copiar v{v} como Markdown",
  "kit.whatsnew.copySlack": "Copiar para Slack",
  "kit.whatsnew.copySlackX": "Copiar v{v} para Slack",
  "kit.whatsnew.copyFailed": "No se pudo copiar; inténtalo de nuevo",
  "kit.whatsnew.latest": "Mostrar solo la última",
  "kit.whatsnew.all": "Mostrar todas las versiones ({n} anteriores)",
  "kit.whatsnew.all.one": "Mostrar todas las versiones ({n} anterior)",
  "kit.report.title": "Informar de un problema",
  "kit.report.sub":
    "Cuéntanos qué falla, o qué te gustaría que hiciera {product}. Se convierte en una incidencia de GitHub, a tu nombre.",
  "kit.report.step1": "1 Escribir",
  "kit.report.step2": "2 Incluir",
  "kit.report.step3": "3 Revisar y enviar",
  "kit.report.stepOf": "{i}/{n}",
  "kit.report.kind": "¿Qué es?",
  "kit.report.k.bug": "Error",
  "kit.report.k.idea": "Idea",
  "kit.report.k.question": "Pregunta",
  "kit.report.titleL": "Título",
  "kit.report.desc": "¿Qué pasó y qué esperabas?",
  "kit.report.shot": "Captura de esta página",
  "kit.report.ncap":
    "No se pudo capturar esta página. Puedes enviar el informe sin captura.",
  "kit.report.shotWait": "Tomando la captura…",
  "kit.report.shotLateWait":
    "Si envías antes de que esté lista, el informe va sin ella.",
  "kit.report.shotLateIn":
    "No incluida: revísala y oculta antes lo que sea privado.",
  "kit.report.shotInclude": "Incluirla",
  "kit.report.shotFailed":
    "Sin captura: no se pudo tomar. Puedes enviar sin ella.",
  "kit.report.backReview": "Volver a Revisar y enviar",
  "kit.report.shotNote":
    "Incluye el diálogo o panel abierto. Arrastra sobre ella para tapar lo privado.",
  "kit.report.nos": "No incluir captura",
  "kit.report.undo": "Deshacer",
  "kit.report.masks": "{n} zonas tapadas",
  "kit.report.masks.one": "{n} zona tapada",
  "kit.report.kbdMask": "Tapar por tamaño y posición",
  "kit.report.mx": "Izquierda %",
  "kit.report.my": "Arriba %",
  "kit.report.mw": "Ancho %",
  "kit.report.mh": "Alto %",
  "kit.report.addMask": "Añadir zona",
  "kit.report.maskAll": "Tapar toda la captura",
  "kit.report.rmMask": "Quitar",
  "kit.report.area": "{x}% desde la izquierda, {y}% desde arriba, {w}% × {h}%",
  "kit.report.revShot": "Captura tras ocultar ({n} zonas tapadas)",
  "kit.report.revShot.one": "Captura tras ocultar ({n} zona tapada)",
  "kit.report.shareTo": "Tu captura con las zonas tapadas va a {recipient}",
  "kit.report.shareNo": "Solo texto; la captura se queda en tu equipo.",
  "kit.report.shotWent": "La captura con las zonas tapadas fue a {recipient}.",
  "kit.report.shotStayed": "La captura se queda en tu equipo: {why}.",
  "kit.report.why.off": "compartir capturas está desactivado",
  "kit.report.why.not-maintained": "nadie mantiene ese repositorio en Hub",
  "kit.report.why.not-a-person":
    "Hub solo acepta capturas desde la conexión de una persona",
  "kit.report.why.conflict": "Hub ya tiene otra captura para este informe",
  "kit.report.why.too-big": "es más grande de lo que Hub acepta",
  "kit.report.why.not-png": "no es una imagen PNG",
  "kit.report.why.limit": "se alcanzó el límite por hora de Hub",
  "kit.report.why.unreachable": "no se pudo contactar con Hub",
  "kit.report.why.not-connected": "este equipo no está conectado a Hub",
  "kit.report.why.refused": "Hub no la aceptó",
  "kit.report.mine": "Mis informes",
  "kit.report.next": "Siguiente: Incluir",
  "kit.report.back": "Atrás",
  "kit.report.send": "Enviar como incidencia de GitHub",
  "kit.report.later": "Terminar luego",
  "kit.report.cancel": "Cancelar",
  "kit.report.dest": "Va a",
  "kit.report.pub": "Repositorio público",
  "kit.report.priv": "Repositorio privado",
  "kit.report.int": "Repositorio interno",
  "kit.report.unk": "Visibilidad desconocida",
  "kit.report.unkW":
    "Trátalo como público: puede que todo el mundo vea las capturas y el texto. Tapa lo que sea privado.",
  "kit.report.privN": "Solo lo ve quien tiene acceso a este repositorio.",
  "kit.report.privW":
    "Solo lo ve quien tiene acceso a este repositorio: {who}.",
  "kit.report.pubW":
    "Las capturas y el texto los ve todo el mundo. Tapa lo que sea privado.",
  "kit.report.incH": "Qué va con tu informe",
  "kit.report.incN":
    "Cada parte explica cómo la usa {product}. Los secretos, tokens, correos, direcciones IP y referencias a almacenes se quitan siempre, esté lo que esté marcado.",
  "kit.report.all": "Incluir todo",
  "kit.report.none": "No incluir nada",
  "kit.report.remember": "Recordar mis elecciones",
  "kit.report.redact":
    "Ocultar nombres (empresas, proyectos, repos, servicios) como <org-1>, <repo-1> …",
  "kit.report.dgi": "Cómo usa {product} esto",
  "kit.report.sec.Den": "{product}",
  "kit.report.sec.Browser": "Navegador",
  "kit.report.sec.Machine": "Máquina",
  "kit.report.sec.Page": "Página",
  "kit.report.use.Den":
    "Qué versión usas, para encontrar el cambio que lo causó.",
  "kit.report.use.Browser":
    "El navegador y el tamaño de la ventana, para verlo como tú.",
  "kit.report.use.Machine":
    "El sistema en el que funciona, nunca quién ni dónde.",
  "kit.report.use.Page": "Qué página y qué diálogo estaban abiertos.",
  "kit.report.revH": "Revisión: esto es exactamente lo que se publicará",
  "kit.report.siH": "Inicia sesión en GitHub para enviar",
  "kit.report.siB":
    "Los informes se registran a tu nombre, así que las respuestas de GitHub te llegan a ti. {product} muestra un código; introdúcelo en github.com/login/device. Esto no es el inicio de sesión de {product}.",
  "kit.report.noApp":
    "Para enviar hace falta GitHub. Guárdalo con Terminar luego, o regístralo en una pestaña de GitHub.",
  "kit.report.open": "Abrir github.com/login/device",
  "kit.report.codeL": "Tu código",
  "kit.report.waiting": "Esperando a que lo apruebes en GitHub…",
  "kit.report.siAlt":
    "O abre una pestaña nueva de GitHub con el informe rellenado.",
  "kit.report.siAltLink": "Abrir una pestaña de GitHub rellenada",
  "kit.report.expired":
    "El código caducó antes de aprobarse. No se envió nada.",
  "kit.report.denied":
    "Se canceló el inicio de sesión en GitHub. No se envió nada.",
  "kit.report.dupH": "Ya hay un informe abierto con este título",
  "kit.report.dupB":
    "«{title}» ya está abierto. ¿Añadir tus detalles a ese en lugar de abrir un segundo?",
  "kit.report.addTo": "Añadir al informe existente",
  "kit.report.fileNew": "Abrir un informe nuevo",
  "kit.report.sentH": "Informe enviado",
  "kit.report.sentB": "Tu informe ya es una incidencia de GitHub: «{title}».",
  "kit.report.addedB": "Tus detalles se añadieron al informe abierto.",
  "kit.report.openIssue": "Abrir la incidencia",
  "kit.report.done": "Hecho",
  "kit.report.limH": "Has enviado {n} informes esta hora",
  "kit.report.limB":
    "Inténtalo de nuevo en {min} minutos. Tu informe no se pierde: guárdalo con Terminar luego y envíalo entonces.",
  "kit.report.latH": "Guardado. No se envió nada.",
  "kit.report.latB":
    "Está guardado en este ordenador con tu texto, tus elecciones y la captura. Lo encontrarás en Mis informes, arriba en Informar de un problema o en la paleta de comandos.",
  "kit.report.failH": "No enviado",
  "kit.report.retry": "Intentar de nuevo",
  "kit.report.keepH": "¿Conservar lo que escribiste?",
  "kit.report.keep": "Conservarlo (Terminar luego)",
  "kit.report.discard": "Descartar",
  "kit.report.needTitle": "Hace falta un título.",
  "kit.report.filed": "Registrado como #{n}",
  "kit.report.copy": "Copiar el informe",
  "kit.report.copied": "Copiado. Pégalo donde tu equipo sigue las incidencias.",
  "kit.report.copyFailed":
    "No se pudo copiar. Selecciona el texto y cópialo tú.",
  "kit.report.copyH": "Copia el informe",
  "kit.md.toolbar": "Formato",
  "kit.md.toolKey": "{name} ({key})",
  "kit.md.bold": "Negrita",
  "kit.md.italic": "Cursiva",
  "kit.md.code": "Código",
  "kit.md.link": "Enlace",
  "kit.md.heading": "Encabezado",
  "kit.md.bulleted": "Lista con viñetas",
  "kit.md.numbered": "Lista numerada",
  "kit.md.quote": "Cita",
  "kit.md.linkText": "texto",
  "kit.savestate.saving": "Guardando…",
  "kit.savestate.saved": "Guardado",
  "kit.savestate.error": "No se guardó. Reintentando…",
  "kit.savestate.copy": "Copiar texto",
  "kit.savestate.savedAt": "Guardado a las {time}",
  "kit.fold.panel": "Panel",
  "kit.fold.show": "Mostrar panel",
  "kit.fold.hidden": "Panel, oculto",
  "kit.filter.button": "Filtros",
  "kit.filter.buttonN": "Filtros ({n})",
  "kit.filter.chosen": "Filtros elegidos",
  "kit.filter.chip": "{facet}:",
  "kit.filter.remove": "Quitar {facet}: {value}",
  "kit.filter.clear": "Quitar",
  "kit.filter.clearFacet": "Quitar {facet}",
  "kit.filter.clearAll": "Quitar todos",
  "kit.bulk.selected": "{n} seleccionados",
  "kit.bulk.selected.one": "{n} seleccionado",
  "kit.bulk.clear": "Quitar selección",
  "kit.bulk.cleared": "Selección quitada",
  "kit.bulk.action": "{label} {n}",
  "kit.pmenu.more": "Más",
  "kit.setrow.save": "Guardar",
  "kit.setrow.who": "{who} pueden cambiar esto",
  "kit.setrow.nobody": "Nadie puede cambiar esto",
  "kit.setrow.last": "Último cambio: {time}, por {who}",
  "kit.setrow.never": "Sin cambios todavía",
  "kit.setrow.error": "No se guardó. Inténtalo de nuevo.",
  "kit.verb.save": "Guardar",
  "kit.verb.cancel": "Cancelar",
  "kit.verb.delete": "Eliminar",
  "kit.verb.close": "Cerrar",
  "kit.verb.tryAgain": "Reintentar",
};

export const ja = {
  "kit.update.msg": "{product} の新しいバージョンがあります。",
  "kit.update.reload": "再読み込み",
  "kit.update.notNow": "後で",
  "kit.update.cancel": "キャンセル",
  "kit.update.ask":
    "このページに保存していないテキストがあります。それでも再読み込みしますか?",
  "kit.update.region": "更新",
  "kit.skip": "本文へ移動",
  "kit.menu": "メニュー",
  "kit.scope": "スコープ",
  "kit.search.ph": "検索…",
  "kit.account.local": "ローカル",
  "kit.search.label": "検索",
  "kit.bell": "通知",
  "kit.bell.n": "通知: 未読 {n} 件",
  "kit.bell.empty": "新しいものはありません。",
  "kit.bell.needs": "対応が必要",
  "kit.bell.earlier": "以前",
  "kit.bell.needsNone": "今、対応が必要なものはありません。",
  "kit.settings": "設定",
  "kit.appearance": "外観",
  "kit.appearance.title": "外観とテーマ",
  "kit.mode.system": "システム",
  "kit.mode.dark": "ダーク",
  "kit.mode.light": "ライト",
  "kit.theme": "テーマ",
  "kit.language": "言語",
  "kit.menu.filter": "{label}を絞り込む",
  "kit.menu.filter.ph": "絞り込み…",
  "kit.menu.none": "一致なし",
  "kit.pages": "ページ",
  "kit.collapse": "折りたたむ",
  "kit.expand": "展開する",
  "kit.from": "{d} から",
  "kit.report.word": "報告",
  "kit.report.tip": "問題を報告 (⌘⇧F)",
  "kit.version.title": "変更履歴を見る",
  "kit.pin.pinX": "{s} をピン留め",
  "kit.pin.unpinX": "{s} のピン留めを外す",
  "kit.badge.open": "{n} 件開いています",
  "kit.badge.waiting": "{n} 件待機中",
  "kit.badge.down": "{n} 件停止",
  "kit.badge.running": "{n} 件実行中",
  "kit.kind.project": "プロジェクト",
  "kit.kind.den": "Den",
  "kit.kind.service": "サービス",
  "kit.kind.hub": "Hub",
  "kit.off.connect": "設定で接続してください",
  "kit.off.reconnect": "設定で再接続してください",
  "kit.off.forbidden": "管理者にアクセスを依頼してください",
  "kit.off.unreachable": "現在接続できません",
  "kit.off.config": "設定を確認してください",
  "kit.whatsnew.title": "新着情報",
  "kit.whatsnew.close": "閉じる",
  "kit.whatsnew.gotIt": "OK",
  "kit.whatsnew.none": "項目がありません。",
  "kit.whatsnew.copyMd": "Markdown としてコピー",
  "kit.whatsnew.copyMdX": "v{v} を Markdown としてコピー",
  "kit.whatsnew.copySlack": "Slack 用にコピー",
  "kit.whatsnew.copySlackX": "v{v} を Slack 用にコピー",
  "kit.whatsnew.copyFailed": "コピーに失敗しました。もう一度お試しください",
  "kit.whatsnew.latest": "最新のみ表示",
  "kit.whatsnew.all": "すべてのバージョンを表示 (以前のもの {n} 件)",
  "kit.report.title": "問題を報告",
  "kit.report.sub":
    "困っていること、{product} にしてほしいことを教えてください。あなた名義の GitHub の issue になります。",
  "kit.report.step1": "1 書く",
  "kit.report.step2": "2 含める",
  "kit.report.step3": "3 確認して送る",
  "kit.report.stepOf": "{i}/{n}",
  "kit.report.kind": "種類",
  "kit.report.k.bug": "不具合",
  "kit.report.k.idea": "アイデア",
  "kit.report.k.question": "質問",
  "kit.report.titleL": "タイトル",
  "kit.report.desc": "何が起きましたか。どうなってほしかったですか。",
  "kit.report.shot": "このページのスクリーンショット",
  "kit.report.ncap":
    "このページは撮影できませんでした。スクリーンショットなしで送れます。",
  "kit.report.shotWait": "スクリーンショットを撮っています…",
  "kit.report.shotLateWait":
    "準備ができる前に送信すると、スクリーンショットなしで送られます。",
  "kit.report.shotLateIn":
    "含まれていません：先に確認して、非公開の部分を隠してください。",
  "kit.report.shotInclude": "含める",
  "kit.report.shotFailed":
    "スクリーンショットなし：撮影できませんでした。なしで送信できます。",
  "kit.report.backReview": "「確認して送る」に戻る",
  "kit.report.shotNote":
    "開いているダイアログやドロワーも入ります。ドラッグして、見せたくない部分を黒く塗れます。",
  "kit.report.nos": "スクリーンショットを含めない",
  "kit.report.undo": "元に戻す",
  "kit.report.masks": "{n} か所を非表示",
  "kit.report.kbdMask": "大きさと位置でマスク",
  "kit.report.mx": "左 %",
  "kit.report.my": "上 %",
  "kit.report.mw": "幅 %",
  "kit.report.mh": "高さ %",
  "kit.report.addMask": "範囲を追加",
  "kit.report.maskAll": "スクリーンショット全体をマスク",
  "kit.report.rmMask": "削除",
  "kit.report.area": "左から {x}%、上から {y}%、{w}% × {h}%",
  "kit.report.revShot": "マスク後のスクリーンショット({n} か所を非表示)",
  "kit.report.shareTo": "マスクしたスクリーンショットは {recipient} に届きます",
  "kit.report.shareNo":
    "テキストのみです。スクリーンショットはこのコンピューターに残ります。",
  "kit.report.shotWent":
    "マスクしたスクリーンショットは {recipient} に届きました。",
  "kit.report.shotStayed":
    "スクリーンショットはこのコンピューターに残ります: {why}。",
  "kit.report.why.off": "スクリーンショットの共有がオフです",
  "kit.report.why.not-maintained":
    "そのリポジトリを Hub で管理している人がいません",
  "kit.report.why.not-a-person":
    "Hub は人の接続からのスクリーンショットだけを受け付けます",
  "kit.report.why.conflict":
    "Hub にはこの報告の別のスクリーンショットがあります",
  "kit.report.why.too-big": "Hub が受け付ける大きさを超えています",
  "kit.report.why.not-png": "PNG 画像ではありません",
  "kit.report.why.limit": "Hub の 1 時間あたりの上限に達しました",
  "kit.report.why.unreachable": "Hub に接続できませんでした",
  "kit.report.why.not-connected":
    "このコンピューターは Hub に接続されていません",
  "kit.report.why.refused": "Hub が受け付けませんでした",
  "kit.report.mine": "自分の報告",
  "kit.report.next": "次へ: 含める",
  "kit.report.back": "戻る",
  "kit.report.send": "GitHub の issue として送る",
  "kit.report.later": "あとで仕上げる",
  "kit.report.cancel": "キャンセル",
  "kit.report.dest": "送り先",
  "kit.report.pub": "公開リポジトリ",
  "kit.report.priv": "非公開リポジトリ",
  "kit.report.int": "内部リポジトリ",
  "kit.report.unk": "公開範囲は不明",
  "kit.report.unkW":
    "公開として扱ってください。スクリーンショットとテキストは誰でも見られるかもしれません。見せたくない部分は隠してください。",
  "kit.report.privN": "このリポジトリにアクセスできる人だけが見られます。",
  "kit.report.privW":
    "このリポジトリにアクセスできる人だけが見られます（{who}）。",
  "kit.report.pubW":
    "スクリーンショットとテキストは誰でも見られます。見せたくない部分は隠してください。",
  "kit.report.incH": "報告に添えるもの",
  "kit.report.incN":
    "各項目に、{product} がどう使うかを書いています。秘密、トークン、メール、IP アドレス、ストアの参照は、チェックに関係なく常に取り除かれます。",
  "kit.report.all": "すべて含める",
  "kit.report.none": "何も含めない",
  "kit.report.remember": "選択を覚えておく",
  "kit.report.redact":
    "名前(会社、プロジェクト、リポジトリ、サービス)を <org-1>、<repo-1> … に置き換える",
  "kit.report.dgi": "{product} はこれをこう使います",
  "kit.report.sec.Den": "{product}",
  "kit.report.sec.Browser": "ブラウザ",
  "kit.report.sec.Machine": "マシン",
  "kit.report.sec.Page": "ページ",
  "kit.report.use.Den": "どのバージョンかを見て、原因になった変更を探します。",
  "kit.report.use.Browser":
    "ブラウザと画面の大きさを見て、同じ状態を再現します。",
  "kit.report.use.Machine":
    "動いているシステムです。誰か、どこかは含みません。",
  "kit.report.use.Page": "どのページとダイアログが開いていたか。",
  "kit.report.revH": "確認: 投稿される内容そのままです",
  "kit.report.siH": "送るには GitHub にサインインしてください",
  "kit.report.siB":
    "報告はあなた名義で作られるので、GitHub の返信があなたに届きます。{product} がコードを表示するので、github.com/login/device で入力してください。これは {product} 自身のサインインではありません。",
  "kit.report.noApp":
    "送るには GitHub が必要です。「あとで仕上げる」で保存するか、GitHub のタブで作成してください。",
  "kit.report.open": "github.com/login/device を開く",
  "kit.report.codeL": "あなたのコード",
  "kit.report.waiting": "GitHub での承認を待っています…",
  "kit.report.siAlt":
    "または、報告を入力済みの GitHub の新しいタブを開きます。",
  "kit.report.siAltLink": "入力済みの GitHub タブを開く",
  "kit.report.expired":
    "承認される前にコードの期限が切れました。何も送っていません。",
  "kit.report.denied":
    "GitHub のサインインが取り消されました。何も送っていません。",
  "kit.report.dupH": "同じタイトルの報告がすでに開いています",
  "kit.report.dupB":
    "「{title}」はすでに開いています。2つ目を作る代わりに、そこに内容を追加しますか。",
  "kit.report.addTo": "既存の報告に追加",
  "kit.report.fileNew": "新しい報告を作る",
  "kit.report.sentH": "報告を送りました",
  "kit.report.sentB": "報告は GitHub の issue になりました:「{title}」。",
  "kit.report.addedB": "開いている報告に内容を追加しました。",
  "kit.report.openIssue": "issue を開く",
  "kit.report.done": "完了",
  "kit.report.limH": "この1時間に {n} 件の報告を送りました",
  "kit.report.limB":
    "{min} 分後にもう一度お試しください。報告は消えません。「あとで仕上げる」で保存し、そのときに送れます。",
  "kit.report.latH": "保存しました。何も送っていません。",
  "kit.report.latB":
    "テキスト、選択、スクリーンショットごと、このコンピューターに保存しました。「問題を報告」の上部かコマンドパレットの「自分の報告」にあります。",
  "kit.report.failH": "送れませんでした",
  "kit.report.retry": "もう一度試す",
  "kit.report.keepH": "書いた内容を残しますか。",
  "kit.report.keep": "残す(あとで仕上げる)",
  "kit.report.discard": "破棄",
  "kit.report.needTitle": "タイトルが必要です。",
  "kit.report.filed": "#{n} として登録しました",
  "kit.report.copy": "報告をコピー",
  "kit.report.copied":
    "コピーしました。チームが課題を管理している場所に貼り付けてください。",
  "kit.report.copyFailed":
    "コピーできませんでした。テキストを選んでコピーしてください。",
  "kit.report.copyH": "報告をコピー",
  "kit.md.toolbar": "書式",
  "kit.md.toolKey": "{name}（{key}）",
  "kit.md.bold": "太字",
  "kit.md.italic": "斜体",
  "kit.md.code": "コード",
  "kit.md.link": "リンク",
  "kit.md.heading": "見出し",
  "kit.md.bulleted": "箇条書き",
  "kit.md.numbered": "番号付きリスト",
  "kit.md.quote": "引用",
  "kit.md.linkText": "テキスト",
  "kit.savestate.saving": "保存しています…",
  "kit.savestate.saved": "保存しました",
  "kit.savestate.error": "保存できていません。再試行しています…",
  "kit.savestate.copy": "テキストをコピー",
  "kit.savestate.savedAt": "{time} に保存しました",
  "kit.fold.panel": "パネル",
  "kit.fold.show": "パネルを表示",
  "kit.fold.hidden": "パネル（非表示）",
  "kit.filter.button": "絞り込み",
  "kit.filter.buttonN": "絞り込み（{n}）",
  "kit.filter.chosen": "選んだ条件",
  "kit.filter.chip": "{facet}：",
  "kit.filter.remove": "{facet}：{value} を外す",
  "kit.filter.clear": "解除",
  "kit.filter.clearFacet": "{facet} を解除",
  "kit.filter.clearAll": "すべて解除",
  "kit.bulk.selected": "{n} 件を選択中",
  "kit.bulk.clear": "選択を解除",
  "kit.bulk.cleared": "選択を解除しました",
  "kit.bulk.action": "{label}（{n}）",
  "kit.pmenu.more": "その他",
  "kit.setrow.save": "保存",
  "kit.setrow.who": "{who}が変更できます",
  "kit.setrow.nobody": "誰も変更できません",
  "kit.setrow.last": "最終変更: {time}（{who}）",
  "kit.setrow.never": "まだ変更はありません",
  "kit.setrow.error": "保存できませんでした。もう一度お試しください。",
  "kit.verb.save": "保存",
  "kit.verb.cancel": "キャンセル",
  "kit.verb.delete": "削除",
  "kit.verb.close": "閉じる",
  "kit.verb.tryAgain": "再試行",
};

/** The kit's tables, by language (en is the fallback for any key). */
export const STRINGS = { en, es, ja };

/** What a product added (addStrings), by language. */
const added = {};
let productName = "";

/** The product name {product} fills in (Den, say). */
export function setProduct(name) {
  productName = String(name ?? "");
}

/**
 * A product's own words, or its own versions of the kit's, for `lang`:
 * { key: text }. Later calls add to earlier ones.
 */
export function addStrings(lang, table) {
  if (!lang || !table || typeof table !== "object") return;
  added[lang] = Object.assign(added[lang] || {}, table);
}

const has = (t, k) => !!t && Object.prototype.hasOwnProperty.call(t, k);

function pluralOf(lang, n) {
  try {
    return new Intl.PluralRules(lang).select(n);
  } catch {
    return n === 1 ? "one" : "other";
  }
}

function num(lang, n) {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}

function lookup(lang, key, vars) {
  for (const t of [added[lang], STRINGS[lang]]) {
    if (!has(t, key)) continue;
    if (vars && typeof vars.n === "number") {
      const form = `${key}.${pluralOf(lang, vars.n)}`;
      if (has(t, form)) return t[form];
    }
    return t[key];
  }
  return null;
}

/** The word for `key` in `lang` (else en, else the key), vars filled in. */
export function kitT(lang, key, vars) {
  const l = has(STRINGS, lang) || has(added, lang) ? lang : "en";
  let s = lookup(l, key, vars);
  if (s == null && l !== "en") s = lookup("en", key, vars);
  if (s == null) s = key;
  const all = { product: productName, ...(vars || {}) };
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    all[k] == null || all[k] === ""
      ? m
      : typeof all[k] === "number"
        ? num(l, all[k])
        : String(all[k]),
  );
}

/** HTML-escaped text (for attributes and content). */
/** An id safe in an attribute and a CSS selector: letters, digits, _ and -. */
export function safeId(v) {
  return String(v).replace(/[^A-Za-z0-9_-]/g, "-");
}

export function esc(v) {
  return String(v == null ? "" : v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
