/**
 * The UI's Spanish catalog (R19, 0.3.0-dev.39). A classic script the
 * server loads before shell.js for a page in Spanish (ui-language.ts); it
 * adds its table to window.denMessages, and shell.js's t() reads it. Every
 * key of shell.js's en is here (tests/unit/server/i18n.test.ts). A `.one`
 * key is the form for n = 1 (Intl.PluralRules("es")).
 */
(function (m) {
  m.es = {
    "g.pinned": "Fijados",
    "g.develop": "Desarrollo",
    "g.verify": "Verificación",
    "g.ship": "Entrega",
    "n.workspaces": "Proyectos",
    "n.graph": "Grafo",
    "n.services": "Servicios",
    "n.logs": "Registros",
    "n.tests": "Pruebas",
    "n.verify": "Comprobaciones",
    "v.ov_t": "¿Podemos publicar?",
    "v.ov_s": "Una respuesta para cada entorno, en palabras sencillas.",
    "v.loading": "Leyendo los últimos resultados…",
    "v.env_local": "Local",
    "v.env_staging": "Staging",
    "v.env_prod": "Producción",
    "v.v_notready": "No está listo",
    "v.v_ready": "Listo",
    "v.v_nothing": "No se ejecutó nada",
    "v.v_notrun": "Aún sin ejecutar",
    "v.v_partly": "Parece bien, revisado en parte",
    "v.v_none": "Aún no hay comprobaciones",
    "v.a_fail1": "{e} no está listo: {m} falló.",
    "v.a_failn": "{e} no está listo: fallaron {n} comprobaciones.",
    "v.a_blockedonly":
      "{e} no está listo: {n} comprobaciones no pudieron ejecutarse.",
    "v.a_blockedonly.one":
      "{e} no está listo: {n} comprobación no pudo ejecutarse.",
    "v.a_waiting": "Otras {n} comprobaciones dependen de ello.",
    "v.a_waiting.one": "{n} comprobación más depende de ello.",
    "v.a_nonehere":
      "Ninguna comprobación se ejecuta aún en {e}, así que no se ejecutó nada. Esto no es un aprobado.",
    "v.a_nothingran":
      "En la última ejecución no se ejecutó nada en {e}. Esto no es un aprobado.",
    "v.a_notrun": "{e} aún no se ha comprobado.",
    "v.a_partly":
      "{e} parece bien por ahora: pasaron {p} de {n} comprobaciones. El resto aún no se ha ejecutado aquí.",
    "v.a_ready": "{e} está listo: pasaron las {n} comprobaciones.",
    "v.a_ready.one": "{e} está listo: pasó {n} comprobación.",
    "v.m_agent": "Iniciado por {a} (agente).",
    "v.m_person": "Iniciado por una persona.",
    "v.m_allowed": "Permitido por una persona.",
    "v.m_allowed_den": "Permitido por Den.",
    "v.m_commit": "Commit {c}.",
    "v.m_when": "Terminó: {t}.",
    "v.b_why": "Ver por qué",
    "v.b_report": "Abrir el informe",
    "v.back": "Volver a la respuesta",
    "v.ac_n": "Todas las comprobaciones ({n})",
    "v.ac_mod": "Comprobación",
    "v.ac_kind": "Tipo",
    "v.dep_on": "necesita que {l} pase primero",
    "v.k_smoke": "humo",
    "v.k_synthetic": "sintética",
    "v.k_security": "seguridad",
    "v.k_performance": "velocidad",
    "v.k_integration": "integración",
    "v.s_passed": "pasó",
    "v.s_failed": "falló",
    "v.s_blocked": "bloqueada",
    "v.s_error": "error",
    "v.s_none": "aún sin ejecutar",
    "v.s_off": "no se ejecuta aquí",
    "v.fd_t": "Actividad",
    "v.fd_none": "Aún no hay ejecuciones.",
    "v.actor_agent": "agente",
    "v.actor_person": "persona",
    "v.actor_den": "Den",
    "v.who_person": "Una persona",
    "v.fd_asked": "pidió ejecutar {n} comprobaciones en {e}.",
    "v.fd_asked.one": "pidió ejecutar {n} comprobación en {e}.",
    "v.fd_allowed": "permitió la ejecución en {e}.",
    "v.fd_finished": "La ejecución en {e} terminó: {v}.",
    "v.why_t": "Por qué lo creemos",
    "v.why_fail": "{m} falló: «{x}».",
    "v.why_failq": "{m} falló.",
    "v.why_err": "{m} no pudo ejecutarse: «{x}».",
    "v.why_errq": "{m} no pudo ejecutarse.",
    "v.why_wait": "Estas no pudieron ejecutarse porque esperan a la capa {l}:",
    "v.why_wait_smoke":
      "Estas no pudieron ejecutarse porque antes falló una comprobación de humo:",
    "v.why_rest": "Todo lo demás pasó aquí: {n} comprobaciones.",
    "v.why_rest.one": "Todo lo demás pasó aquí: {n} comprobación.",
    "v.no_report": "Esta comprobación no guardó salida para abrir.",
    "v.em_h": "Añade una comprobación",
    "v.em_p":
      "Una comprobación son tres líneas en el manifiesto de un repositorio:",
    "v.em_where": "Den la lee la próxima vez que planifiques una ejecución.",
    "v.old_t":
      "Los tipos de prueba anteriores siguen ejecutándose en la página Pruebas mientras se retiran.",
    "v.old_link": "Abrir Pruebas",
    "v.err_load": "Verificación no pudo cargar los resultados.",
    "v.retry": "Intentar de nuevo",
    "v.sch_link": "Programaciones",
    "v.sch_t": "Programaciones",
    "v.sch_s": "Pruebas que corren solas. Las pesadas corren en su ventana.",
    "v.sch_tz":
      "«Cuándo» y «Ventana» van en la zona horaria de este Den, {z}. Las pruebas pesadas corren de una en una.",
    "v.sch_when": "Cuándo",
    "v.sch_window_h": "Ventana",
    "v.sch_next_h": "Próxima",
    "v.sch_last_h": "Última corrida",
    "v.sch_hourly": "Cada hora",
    "v.sch_daily": "Cada día a las {t}",
    "v.sch_weekly": "{d} a las {t}",
    "v.sch_d0": "Los domingos",
    "v.sch_d1": "Los lunes",
    "v.sch_d2": "Los martes",
    "v.sch_d3": "Los miércoles",
    "v.sch_d4": "Los jueves",
    "v.sch_d5": "Los viernes",
    "v.sch_d6": "Los sábados",
    "v.sch_any": "A cualquier hora",
    "v.sch_night": "De noche (22:00 a 06:00)",
    "v.sch_span": "De {a} a {b}",
    "v.sch_st_allowed": "Permitida",
    "v.sch_st_free": "Sin permiso necesario",
    "v.sch_st_expiring": "Permiso por vencer",
    "v.sch_st_paused": "En pausa",
    "v.sch_free_code": "Solo lee el código, así que no necesita permiso.",
    "v.sch_free_local": "Corre en local, así que no necesita permiso.",
    "v.sch_needs": "Necesita un permiso antes de correr.",
    "v.sch_needs_h": "Nada corre hasta que alguien permita esta programación.",
    "v.sch_lapsed": "El permiso del {t} caducó cuando cambió el plan.",
    "v.sch_expired": "El permiso venció el {t}.",
    "v.sch_allow_until": "Permitida hasta el {t}.",
    "v.sch_changed":
      "El plan cambió, así que esta programación necesita un permiso nuevo.",
    "v.sch_expiring":
      "El permiso vence {t}. Cuando venza, esta programación se detiene hasta que alguien la permita de nuevo.",
    "v.sch_code": "Código",
    "v.sch_ro": "solo lectura",
    "v.sch_ro_h":
      "En producción es de solo lectura: solo GET, HEAD y OPTIONS, más las escrituras que el repositorio permite en write_allow.",
    "v.sch_never": "Aún sin correr",
    "v.sch_ask": "Permitir esta programación",
    "v.sch_ask_t": "¿Permitir la programación «{s}» en {e}?",
    "v.sch_ask_h":
      "Un permiso cubre cada corrida de este plan hasta que cambie o venza el {t}.",
    "v.sch_does": "Qué hace cada corrida",
    "v.sch_mk_enforced": "lo garantiza Den",
    "v.sch_mk_declared": "declarado de solo lectura",
    "v.sch_mk_code": "solo lee el código",
    "v.sch_touch_writes": "escribe",
    "v.sch_touch_reads": "solo lee",
    "v.sch_mk_service": "lo declara el servicio",
    "v.sch_decline": "Rechazar",
    "v.sch_decline_h":
      "Rechazar deja la programación en pausa. Nada corre hasta que alguien la permita.",
    "v.sch_revoke": "Retirar permiso",
    "v.sch_revoked": "Permiso retirado. La programación espera uno nuevo.",
    "v.sch_run": "Correr ahora",
    "v.sch_runs": "Ver corridas",
    "v.sch_ch_h": "Qué cambió",
    "v.sch_ch_added": "{m} se sumó a la programación",
    "v.sch_ch_removed": "{m} salió de la programación",
    "v.sch_ch_cmd": "{m}: cambió su comando",
    "v.sch_ch_writes": "{m} ahora escribe",
    "v.sch_ch_window": "Cambió su ventana",
    "v.sch_ch_cron": "Cambiaron sus horas",
    "v.sch_missed_h": "Perdidas durante la pausa",
    "v.sch_sk_allow": "necesita un permiso",
    "v.sch_sk_changed": "necesita un permiso nuevo",
    "v.sch_sk_expired": "su permiso venció",
    "v.sch_sk_window": "su ventana cerró antes",
    "v.sch_sk_busy": "había otra corrida en curso",
    "v.sch_sk_cmdoff": "los comandos están apagados aquí",
    "v.sch_sk_prodoff": "las programaciones en producción están apagadas aquí",
    "v.sch_sk_often": "corre demasiado seguido para producción",
    "v.sch_sk_host": "llega a un host que producción no permite",
    "v.sch_lim_prod_off":
      "Aquí las programaciones no corren en producción. Para activarlas, pon esto en el bloque verify: de Den:",
    "v.sch_lim_often":
      "Esto corre en producción más seguido de lo que Den permite. Córrelo menos seguido, o fija el intervalo mínimo en el bloque verify: de Den:",
    "v.sch_lim_host":
      "Una corrida en producción no puede llegar a estos hosts. Agrégalos a verify.schedule.production.hosts, o apunta la prueba a otro lugar:",
    "v.sch_sk_unclear": "Den no pudo seguir su comando",
    "v.sch_lim_off":
      "Aquí los comandos no corren solos en un entorno compartido. Para activarlos, pon esto en el bloque verify: de Den:",
    "v.sch_lim_unclear":
      "Den no puede seguir este comando, así que no puede correr solo:",
    "v.sch_empty":
      "Aún no hay programaciones. Agrega {c} a un módulo para que corra solo.",
    "v.sch_empty_h":
      "Una programación en staging o producción pide un permiso una vez. Las de solo código y las locales corren sin él.",
    "v.sch_how":
      "Las programaciones vienen de {a} en el bloque {b} del repositorio. Para agregar, cambiar o quitar una, cambia el repositorio.",
    "v.sch_started": "Empezó. Su resultado llega a la campana.",
    "v.sch_allowed": "Permitida. Corre en su próxima hora.",
    "v.sch_declined": "Rechazada. La programación sigue en pausa.",
    "v.sch_err": "No funcionó: {e}",
    // Issue 441: an outside runner's gate results on Checks.
    "v.m_ran": "Se ejecutó de {a} a {b}.",
    "v.m_runner": "De un ejecutor externo.",
    "v.i_nothing":
      "{t} se ejecutó en {e}, pero ninguna cláusula se ejecutó allí. Esto no es un aprobado.",
    "v.i_fail": "{t} en {e} falló: {a}, {b}, {c}.",
    "v.i_pass": "{t} en {e} pasó: {a}, {b}, {c}.",
    "v.i_np": "pasaron {n} cláusulas",
    "v.i_np.one": "pasó {n} cláusula",
    "v.i_nm": "{n} necesitan a una persona",
    "v.i_nm.one": "{n} necesita a una persona",
    "v.i_nf": "fallaron {n}",
    "v.i_nf.one": "falló {n}",
    "v.i_from": "De resultados importados.",
    "v.i_cfg": "Los resultados importados están desactivados: {e}",
    "v.i_b_failed": "Falló",
    "v.i_b_passed": "Pasó",
    "v.i_nchecks": "{n} comprobaciones",
    "v.i_nchecks.one": "{n} comprobación",
    "v.i_nclauses": "{n} cláusulas",
    "v.i_nclauses.one": "{n} cláusula",
    "v.i_sizes": "{a} y {b}.",
    "v.n_passed": "pasaron",
    "v.n_failed": "fallaron",
    "v.n_needs": "te necesitan",
    "v.n_cantrun": "no se pudieron ejecutar",
    "v.i_failed_h": "Fallaron ({n})",
    "v.i_cantrun_h": "No se pudieron ejecutar ({n})",
    "v.i_needs_h": "Te necesitan ({n})",
    "v.i_needs_p":
      "Una comprobación nunca toma la decisión de una persona. Estas te toca probarlas en {e}.",
    "v.i_issue": "incidencia {n}",
    "v.i_checks_h": "Comprobaciones de esta etiqueta",
    "v.i_chk": "pasaron {p} de {n} cláusulas",
    "v.i_chk.one": "pasó {p} de {n} cláusula",
    "v.i_chk_needs": ", {n} te necesitan",
    "v.i_chk_needs.one": ", {n} te necesita",
    "v.i_on": "en {t}",
    "v.i_allran": "Todas las cláusulas aquí pasaron.",
    "v.c_passed": "pasó",
    "v.c_failed": "falló",
    "v.c_error": "con error",
    "v.c_needs": "Te necesita",
    "v.c_cantrun": "no se pudo ejecutar",
    "v.ct_result": "Resultado",
    "v.ct_clause": "Cláusula",
    "v.ct_note": "Nota",
    "v.ct_time": "Tiempo",
    "v.t_ms": "{n} ms",
    "v.t_s": "{n} seg",
    "v.who_runner": "Un ejecutor externo",
    "v.actor_runner": "ejecutor externo",
    "v.fd_imported": "envió sus resultados de {t} en {e}.",
    "n.environments": "Entornos",
    "n.releases": "Versiones",
    "n.edge": "Edge",
    "n.settings": "Ajustes",
    // FB (den#81): Report an issue.
    "fb.rail": "Informar de un problema",
    "fb.tip": "Informar de un problema (⌘⇧F)",
    "fb.word": "Informar",
    "fb.palette": "Informar de un problema",
    "fb.title": "Informar de un problema",
    "fb.sub":
      "Cuéntanos qué falla, o qué te gustaría que hiciera __DEN_TITLE__. Se convierte en una incidencia de GitHub, a tu nombre.",
    "fb.step1": "1 Escribir",
    "fb.step2": "2 Incluir",
    "fb.step3": "3 Revisar y enviar",
    "fb.stepOf": "{i}/{n}",
    "fb.kind": "¿Qué es?",
    "fb.k.bug": "Error",
    "fb.k.idea": "Idea",
    "fb.k.question": "Pregunta",
    "fb.titleL": "Título",
    "fb.desc": "¿Qué pasó y qué esperabas?",
    "fb.shot": "Captura de esta página",
    "fb.ncap":
      "No se pudo capturar esta página. Puedes enviar el informe sin captura.",
    "fb.shotNote":
      "Incluye el diálogo o panel abierto. Arrastra sobre ella para tapar lo privado.",
    "fb.nos": "No incluir captura",
    "fb.undo": "Deshacer",
    "fb.masks": "{n} zonas tapadas",
    "fb.masks.one": "{n} zona tapada",
    "fb.kbdMask": "Tapar por tamaño y posición",
    "fb.mx": "Izquierda %",
    "fb.my": "Arriba %",
    "fb.mw": "Ancho %",
    "fb.mh": "Alto %",
    "fb.addMask": "Añadir zona",
    "fb.maskAll": "Tapar toda la captura",
    "fb.rmMask": "Quitar",
    "fb.area": "{x}% desde la izquierda, {y}% desde arriba, {w}% × {h}%",
    "fb.revShot": "Captura tras ocultar ({n} zonas tapadas)",
    "fb.revShot.one": "Captura tras ocultar ({n} zona tapada)",
    "fb.mine": "Mis informes",
    "fb.myS":
      "Se muestran en vivo desde GitHub. Funciona mientras tengas la sesión iniciada en GitHub.",
    "fb.tabMine": "Míos",
    "fb.tabDraft": "Borradores de agentes ({n})",
    "fb.r3": "Borrador: Terminar luego",
    "fb.r3s": "Guardado en este ordenador · no enviado",
    "fb.openL": "Abrir en GitHub",
    "fb.cont": "Continuar",
    "fb.myE":
      "Aún no hay informes. Pulsa Informar en cualquier página para enviar uno.",
    "fb.myOpen": "Abierto",
    "fb.myClosed": "Cerrado",
    "fb.myLast": "última respuesta: «{text}» {when}",
    "fb.myNone": "aún sin respuestas",
    "fb.myNew": "Respuesta nueva",
    "fb.myNoGh":
      "Inicia sesión en GitHub para ver aquí tus informes. Los borradores se muestran igual.",
    "fb.myBy": "De {agent} · {when}",
    "fb.myAgE": "No hay borradores de agentes.",
    "fb.myLoading": "Cargando…",
    "fb.untitled": "(sin título)",
    "fb.next": "Siguiente: Incluir",
    "fb.back": "Atrás",
    "fb.send": "Enviar como incidencia de GitHub",
    "fb.later": "Terminar luego",
    "fb.cancel": "Cancelar",
    "fb.dest": "Va a",
    "fb.pub": "Repositorio público",
    "fb.pubW":
      "Las capturas y el texto los ve todo el mundo. Tapa lo que sea privado.",
    "fb.incH": "Qué va con tu informe",
    "fb.incN":
      "Cada parte explica cómo la usa __DEN_TITLE__. Los secretos, tokens, correos, direcciones IP y referencias a almacenes se quitan siempre, esté lo que esté marcado.",
    "fb.all": "Incluir todo",
    "fb.none": "No incluir nada",
    "fb.remember": "Recordar mis elecciones",
    "fb.redact":
      "Ocultar nombres (empresas, proyectos, repos, servicios) como <org-1>, <repo-1> …",
    "fb.dgi": "Cómo usa __DEN_TITLE__ esto",
    "fb.sec.Den": "__DEN_TITLE__",
    "fb.sec.Browser": "Navegador",
    "fb.sec.Machine": "Máquina",
    "fb.sec.Page": "Página",
    "fb.use.Den": "Qué versión usas, para encontrar el cambio que lo causó.",
    "fb.use.Browser":
      "El navegador y el tamaño de la ventana, para verlo como tú.",
    "fb.use.Machine": "El sistema en el que funciona, nunca quién ni dónde.",
    "fb.use.Page": "Qué página y qué diálogo estaban abiertos.",
    "fb.revH": "Revisión: esto es exactamente lo que se publicará",
    "fb.siH": "Inicia sesión en GitHub para enviar",
    "fb.siB":
      "Los informes se registran a tu nombre, así que las respuestas de GitHub te llegan a ti. __DEN_TITLE__ muestra un código; introdúcelo en github.com/login/device. Esto no es el inicio de sesión de __DEN_TITLE__.",
    "fb.noApp":
      "Para enviar hace falta GitHub. Guárdalo con Terminar luego, o regístralo en una pestaña de GitHub.",
    "fb.open": "Abrir github.com/login/device",
    "fb.codeL": "Tu código",
    "fb.waiting": "Esperando a que lo apruebes en GitHub…",
    "fb.siAlt": "O abre una pestaña nueva de GitHub con el informe rellenado.",
    "fb.siAltLink": "Abrir una pestaña de GitHub rellenada",
    "fb.expired": "El código caducó antes de aprobarse. No se envió nada.",
    "fb.denied": "Se canceló el inicio de sesión en GitHub. No se envió nada.",
    "fb.dupH": "Ya hay un informe abierto con este título",
    "fb.dupB":
      "«{title}» ya está abierto. ¿Añadir tus detalles a ese en lugar de abrir un segundo?",
    "fb.addTo": "Añadir al informe existente",
    "fb.fileNew": "Abrir un informe nuevo",
    "fb.sentH": "Informe enviado",
    "fb.sentB": "Tu informe ya es una incidencia de GitHub: «{title}».",
    "fb.addedB": "Tus detalles se añadieron al informe abierto.",
    "fb.openIssue": "Abrir la incidencia",
    "fb.done": "Hecho",
    "fb.limH": "Has enviado {n} informes esta hora",
    "fb.limB":
      "Inténtalo de nuevo en {min} minutos. Tu informe no se pierde: guárdalo con Terminar luego y envíalo entonces.",
    "fb.latH": "Guardado. No se envió nada.",
    "fb.latB":
      "Está guardado en este ordenador con tu texto, tus elecciones y la captura. Lo encontrarás en Mis informes, arriba en Informar de un problema o en la paleta de comandos.",
    "fb.failH": "No enviado",
    "fb.retry": "Intentar de nuevo",
    "fb.keepH": "¿Conservar lo que escribiste?",
    "fb.keep": "Conservarlo (Terminar luego)",
    "fb.discard": "Descartar",
    "fb.needTitle": "Hace falta un título.",
    "fb.busyPreview": "Preparando la vista previa…",
    "fb.busySend": "Enviando el informe…",
    "fb.busySave": "Guardando el informe…",
    "fb.busyDone": "Hecho",
    "fb.busyFailed":
      "No se pudo contactar con __DEN_TITLE__. No se envió nada.",
    "k.org": "Empresa",
    "k.repoOwner": "Propietario del repo",
    "k.ws": "Proyecto",
    "k.env": "Entorno",
    scope: "Ámbito",
    "org.title": "Org: {title}",
    "org.titleId": "Org: {title} ({id})",
    "ws.all": "Todos los activos",
    "ws.focus": "predeterminado de la CLI",
    "ws.hubChip": "Hub: {name}",
    "ws.hubUnseen": "Den Hub no puede ver {n} repos",
    "ws.hubTip":
      "Los agentes de este proyecto archivan su trabajo de Hub en este proyecto de Hub. Cámbialo en Configuración del proyecto.",
    "ws.noServices": "Este proyecto aún no tiene servicios",
    "ws.focusTip":
      "Los comandos de la CLI se ejecutan aquí si no indicas un proyecto. Elegir un proyecto en la barra superior también lo convierte en el predeterminado de la CLI.",
    "ws.pickTip":
      "Elegir un proyecto aquí también lo convierte en el predeterminado de la CLI, así que los comandos de __DEN_CLI__ se ejecutan allí.",
    "ws.none": "No hay proyectos activos",
    "pc.title": "Color de {name}",
    "pc.help":
      "Se usa para sus agentes, pestañas y la línea «Para». Solo tuyo, nunca compartido. Automático elige uno por ti.",
    "pc.auto": "Automático",
    "pc.autoIs": "Automático ({colour})",
    "pc.save": "Guardar",
    "pc.change": "Cambiar color",
    "pc.changeFor": "Cambiar el color de {name}",
    "pc.failed": "No se guardó el color: {err}",
    "pc.blue": "Azul",
    "pc.teal": "Verde azulado",
    "pc.green": "Verde",
    "pc.purple": "Morado",
    "pc.pink": "Rosa",
    "pc.gold": "Dorado",
    "pc.brown": "Marrón",
    "pc.slate": "Pizarra",
    "set.workspace.colour": "Color",
    "set.workspace.colour.d":
      "El color de los agentes, pestañas, línea «Para» y chip de la barra superior de este proyecto. Automático elige uno, siempre el mismo; solo tuyo, nunca compartido ni enviado a Hub.",
    "ws.manage": "Gestionar proyectos…",
    "ws.order.az": "Orden de la A a la Z",
    "ws.order.mine": "Tu orden",
    "ws.order.reset": "Volver a la A a la Z",
    "ws.order.help":
      "Arrastra una fila por su asa, o usa Subir / Bajar en su menú ⋮. Un proyecto nuevo se coloca de la A a la Z hasta que lo muevas.",
    "ws.order.drag": "Arrastra para reordenar",
    "ws.order.up": "Subir",
    "ws.order.down": "Bajar",
    "ws.named.hub": "Nombre de Hub",
    "pname.label": "Nombre del proyecto",
    "pname.hubChip": "Nombre de Hub",
    "pname.hubHelp":
      "El nombre viene de Hub. Para cambiarlo, pídelo en Hub; allí decide una persona.",
    "pname.localHelp":
      "Se muestra en la cabecera, las listas y las páginas de Den. Vincula este proyecto a Hub para usar el nombre de Hub.",
    "pname.save": "Guardar nombre",
    "pname.saved": "Guardado.",
    "pname.empty": "Escribe un nombre. No puede quedar vacío.",
    "pname.failed": "No se guardó el nombre.",
    "pname.offline":
      "No se puede contactar con Hub. Se muestra el último nombre que Den recibió de Hub (hace {n} min).",
    "pname.offlineNever":
      "No se puede contactar con Hub. Se muestra el último nombre que Den recibió de Hub.",
    "pname.retry": "Reintentar",
    "pname.retryW": "Pidiendo los nombres a Hub…",
    "pname.retryS": "Hub respondió. El nombre está al día.",
    "pname.retryF": "Sigue sin poder contactarse con Hub.",
    "pname.rename": "Renombrar…",
    "pname.newName": "Nombre nuevo",
    "pname.ask": "Pedir a Hub que renombre",
    "pname.cancel": "Cancelar",
    "pname.askHelp":
      "Esto envía un cambio retenido a Hub. El nombre aquí no cambia hasta que se apruebe.",
    "pname.pending": "El cambio de nombre a «{to}» espera una decisión en Hub.",
    "pname.openHub": "Abrir en Hub",
    "pname.askW": "Pidiendo a Hub que lo renombre a {name}…",
    "pname.askS": "Pedido. Una persona lo decide en Hub.",
    "pname.askF": "Hub no aceptó el cambio de nombre. El nombre no cambió.",
    "set.workspace.name": "Nombre",
    "set.shell.projectOrder": "Orden de los proyectos",
    "ws.allN": "Todos los activos ({n})",
    "ws.allTip":
      "Todos los proyectos activos; un servicio que definen varios aparece una sola vez",
    "ws.noneLabel": "ninguno",
    "ws.viewTitle":
      "Vista: lo que muestra cada página ({ws}). Es solo un filtro: no inicia, detiene ni enruta nada.",
    "ws.viewTitleFocus":
      "Vista: lo que muestra cada página ({ws}). No inicia, detiene ni enruta nada. Predeterminado de la CLI: {focus}.",
    "ws.viewFailed": "No se pudo cambiar la vista: {msg}",
    "ws.focusFailed": "No se pudo poner el foco: {msg}",
    "org.n": "{n} proyectos",
    "org.n.one": "{n} proyecto",
    from: "de {d}",
    "act.pin": "Fijar",
    "act.unpin": "Quitar",
    "act.visit": "Visitar",
    "act.visitX": "Visitar {s} (se abre en una pestaña nueva)",
    // 0.4.18: the service panel (svc-panel.js) and Start's Folder.
    "svp.label": "{s}: panel rápido",
    "svp.more": "Panel rápido de {s}",
    "svp.notRunning": "No está en marcha",
    "svp.up": "activo {d}",
    "svp.upNow": "activo",
    "svp.down": "caído: {c}",
    "svp.downNone": "caído",
    "svp.starting": "iniciando…",
    "svp.stopped": "detenido",
    "svp.noUrl": "Sin URL",
    "svp.start": "Iniciar",
    "svp.stop": "Detener",
    "svp.restart": "Reiniciar",
    "svp.logs": "Registros",
    "svp.stopping": "Deteniendo {s}",
    "svp.tests": "Última ejecución de pruebas",
    "svp.testsOk": "✓ {t}",
    "svp.testsBad": "✗ falló {t}",
    "svp.testsRun": "en curso…",
    "svp.testsNone": "—",
    "svp.runTests": "Ejecutar pruebas",
    "svp.testsDone": "Pruebas superadas: {s}",
    "svp.testsFailed": "Pruebas fallidas: {s}",
    "svp.agents": "Agentes",
    "svp.noAgents": "No hay agentes en este repo.",
    "svp.onRepo": "En este repo",
    "svp.alsoIn": "También en {p} · {n}",
    "svp.startAg": "Iniciar {s}",
    "svp.open": "Abrir",
    "svp.openAg": "Abrir {s}",
    "svp.startHere": "Iniciar agente aquí",
    "svp.openSvc": "Abrir en Servicios",
    "svp.openGraph": "Abrir en Grafo",
    "graph.outside": "{s} está en {ws}, fuera de esta vista.",
    "graph.showWs": "Mostrar {ws}",
    "svp.close": "Cerrar",
    "ag.new.folder": "Carpeta (opcional)",
    "ag.repo": "Repo",
    "ag.repo.help":
      "Las tarjetas de servicio de su repo lo muestran. Ninguno: aparece en todo el proyecto.",
    "ag.repo.auto": "Según su carpeta",
    "ag.repo.none": "Ninguno (todo el proyecto)",
    "ag.link.change": "Cambiar",
    "ag.link.relink": "Volver a vincular",
    "ag.link.changeName": "Cambiar el repo en el que trabaja {id}",
    "ag.link.missing": "falta el repo",
    "ag.link.title": "El repo en el que trabaja {id}",
    "ag.link.help":
      "Las tarjetas de servicio de su repo lo muestran. Ninguno: aparece en También en {p}.",
    "ag.link.save": "Guardar",
    "ag.new.folderHelp": "Dentro de la carpeta del proyecto. Vacío: la suya.",
    "act.pinX": "Fijar {s}",
    "act.unpinX": "Quitar {s}",
    "toast.pinned": "{s} fijado",
    "toast.unpinned": "{s} ya no está fijado",
    "toast.unpinnedAll": "{s} ya no está fijado en ningún proyecto",
    "toast.undo": "Deshacer",
    collapse: "Contraer",
    expand: "Expandir",
    menu: "Menú",
    skip: "Saltar al contenido",
    pages: "Páginas",
    "search.ph": "Buscar páginas, servicios, acciones…",
    "status.checking": "Comprobando…",
    "status.none": "Sin servicios",
    "status.unchecked": "{n} sin comprobar",
    "status.all": "Los {n} en buen estado",
    "status.all.one": "{n} en buen estado",
    "status.some": "{ok}/{n} en buen estado",
    "status.down": "{n} caídos",
    "status.down.one": "{n} caído",
    "status.title": "{n} comprobados",
    "status.title.one": "{n} comprobado",
    "status.pending": "{n} pendientes",
    "status.pending.one": "{n} pendiente",
    "status.awaiting": "{n} aún comprobándose",
    "status.unknown": "Estado desconocido",
    "status.unknownTip":
      "El servidor de Den no responde, así que no se sabe el estado de los servicios",
    "chk.awaiting": "aún comprobándose",
    "chk.pending": "{what} — pendiente",
    "chk.check": "comprobación",
    "chk.unchecked": "sin comprobar",
    "chk.healthy": "en buen estado",
    "chk.down": "caído",
    "chk.pendingWord": "pendiente",
    "chk.checking": "comprobando…",
    ms: "{n} ms",
    "fix.failedAt": "{line} · falló a las {at}",
    "fix.start": "Iniciar",
    "fix.startX": "Iniciar {s}",
    "fix.logs": "Registros",
    "fix.logsX": "Registros de {s}",
    "row.name": "{id}, {state}",
    "row.nameMs": "{id}, {state}, {ms}",
    "drawer.title": "Estado",
    "drawer.refresh": "Comprobar de nuevo",
    "drawer.close": "Cerrar",
    "drawer.attention": "Requiere atención",
    "drawer.nothing": "Nada requiere atención.",
    "drawer.everything": "Todo",
    "drawer.okTip": "{ok} de {n} servicios comprobados en buen estado",
    "drawer.okTip.one": "{ok} de {n} servicio comprobado en buen estado",
    "toast.openWs": "Abre Proyectos para ejecutarlo",
    "kind.page": "Página",
    "kind.service": "Servicio",
    "kind.app": "App",
    "kind.action": "Acción",
    "kind.setting": "Ajuste",
    "kind.workspace": "Proyecto",
    "pal.goWs": "Ir al proyecto {ws}",
    "pal.repos": "{n} repositorios",
    "pal.repos.one": "{n} repositorio",
    "pal.restart": "Reiniciar {s}",
    "pal.results": "Resultados",
    "pal.move": "↑↓ para moverte",
    "pal.open": "↵ para abrir",
    "pal.newTab": "{mod}↵ pestaña nueva",
    "pal.close": "esc para cerrar",
    "pal.none": "Sin coincidencias",
    "pal.count": "{n} resultados",
    "pal.count.one": "{n} resultado",
    "runs.title": "Ejecuciones",
    "runs.n": "{n} en ejecución",
    "runs.aria": "Ejecuciones, {n} en ejecución",
    "runs.last": "Última ejecución: {s}",
    "runs.none": "Sin ejecuciones",
    "runs.empty":
      "Aún no se ha ejecutado nada. La salida de cualquier página aparece aquí.",
    "runs.toast":
      "Aún no se ha ejecutado nada. La salida de una página aparece aquí.",
    "runs.all": "Todas",
    "runs.allTip": "Se muestran las ejecuciones de {ws}; pulsa para ver todas",
    "runs.allOn":
      "Se muestran todas las ejecuciones; pulsa para ver solo las de {ws}",
    "dock.done": "terminó en {s} s",
    "dock.failed": "falló en {s} s",
    "run.nothingRan":
      "– No se ejecutó nada en {d}. Ninguna prueba pasó ni falló.",
    "run.nothingRanShort": "no se ejecutó nada ({d})",
    "v.v_cancelled": "Cancelada",
    "dock.close": "Ocultar ejecuciones",
    "dock.show": "Mostrar ejecuciones",
    "dock.copy": "Copiar",
    "dock.copied": "¡Copiado!",
    "dock.clear": "Borrar",
    "dock.closeRun": "Cerrar {s}",
    "dock.err": "falló",
    "dock.last": "Última ejecución: {s} ↗",
    "dock.resize": "Arrastra para cambiar el tamaño",
    "lock.waiting": "Se necesita la contraseña de administrador",
    "lock.needs": "{cmd} necesita tu contraseña de administrador",
    "lock.cmd": "Un comando",
    "lock.cfg":
      "Guardar la contraseña está desactivado: define secrets.provider y secrets.refs.sudo en {file}.",
    "lock.update": "Actualizar la contraseña guardada",
    "lock.saveTo": "Guardar en {s}",
    "lock.pw": "Contraseña de administrador",
    "lock.go": "Continuar",
    "lock.note":
      "Den la usa solo para sudo. Los agentes no pueden introducirla.",
    "lock.saved": "Contraseña de administrador guardada para esta sesión",
    "lock.savedTo":
      "Contraseña de administrador guardada para esta sesión y en {s}",
    "lock.saveFailed":
      "Guardada para esta sesión, pero no se pudo guardar en {s}: {err}",
    "lock.wrong": "Contraseña incorrecta; inténtalo de nuevo",
    "lock.reqFailed": "La solicitud falló: ¿está en marcha el servidor?",
    "v.title": "Ver el registro de cambios",
    "cl.title": "Novedades",
    "cl.close": "Cerrar",
    "cl.gotIt": "Entendido",
    "cl.none": "No hay entradas.",
    "cl.copyMd": "Copiar como Markdown",
    "cl.copyMdX": "Copiar v{v} como Markdown",
    "cl.copySlack": "Copiar para Slack",
    "cl.copySlackX": "Copiar v{v} para Slack",
    "cl.copyFailed": "No se pudo copiar; inténtalo de nuevo",
    "cl.latest": "Mostrar solo la última",
    "cl.all": "Mostrar todas las versiones ({n} anteriores)",
    "cl.all.one": "Mostrar todas las versiones ({n} anterior)",
    "stale.title":
      "Este servidor web de {cli} ejecuta código más antiguo que tu copia de trabajo: haz clic para reiniciarlo y cargar tus cambios. Los despliegues en curso siguen en GitHub; un registro de despliegue abierto se reconecta tras recargar.",
    "stale.aria": "Servidor desactualizado: reiniciar",
    "stale.label": "servidor desactualizado",
    "stale.restart": "Reiniciar",
    "rd.menu": "Reiniciar Den…",
    "rd.title": "¿Reiniciar Den?",
    "wsd.title": "“{ws}” tiene agentes ({n})",
    "wsd.running": "en marcha",
    "wsd.move": "Moverlos a",
    "wsd.moveRunning":
      "Uno en marcha se mueve cuando termina su turno, con la misma conversación.",
    "wsd.stop": "Detenerlos y quitarlos",
    "wsd.stopHelp":
      "Sus conversaciones se conservan. Deshacer recupera uno durante una hora.",
    "wsd.cancel": "Cancelar",
    "wsd.go": "Eliminar el proyecto",
    // issue 133: the kit's dialogs (dialog-den.js), in place of confirm(),
    // prompt() and alert().
    "dlg.ok": "Aceptar",
    "dlg.cancel": "Cancelar",
    "dlg.close": "Cerrar",
    "dlg.keep": "Conservar",
    "dlg.delete": "Eliminar",
    "dlg.remove": "Quitar",
    "dlg.removeSvcT": "¿Quitar el servicio?",
    "dlg.removeSvc": "¿Quitar “{svc}” de “{ws}”?",
    "dlg.delProjT": "¿Eliminar el proyecto?",
    "dlg.delProj": "¿Eliminar el proyecto “{ws}”?",
    "dlg.dirT": "¿Eliminar también su carpeta?",
    "dlg.dir":
      "¿Eliminar también el directorio del proyecto de este ordenador?\n\n{dir}\n\nSe borran todos los archivos del directorio. Los commits sin enviar se perderán.",
    "dlg.reposT": "¿Eliminar también sus repositorios?",
    "dlg.devRepos.one":
      "¿Eliminar también {n} repositorio gestionado en desarrollo de este ordenador?\n\n{list}\n\nLos commits sin enviar se perderán.",
    "dlg.devRepos":
      "¿Eliminar también {n} repositorios gestionados en desarrollo de este ordenador?\n\n{list}\n\nLos commits sin enviar se perderán.",
    "dlg.denRepos.one":
      "¿Eliminar también {n} repositorio gestionado que solo usa este proyecto?\n\n{list}\n\nNingún otro proyecto usa estos clones.",
    "dlg.denRepos":
      "¿Eliminar también {n} repositorios gestionados que solo usa este proyecto?\n\n{list}\n\nNingún otro proyecto usa estos clones.",
    "dlg.renameT": "Cambiar el nombre del proyecto",
    "dlg.rename": "Nuevo nombre para el proyecto “{ws}”:",
    "dlg.renameGo": "Cambiar nombre",
    "dlg.openT": "Ejecútalo tú",
    "dlg.editorFail":
      "No se pudo abrir Terminal.app automáticamente.\n\nEjecuta esto en tu terminal:\n\n  {cmd}\n\n{msg}",
    "dlg.termFail":
      "No se pudo abrir la terminal automáticamente.\n\nEjecuta esto en tu terminal:\n\n  {cmd}\n\n{msg}",
    "dlg.autoOffT": "¿Desactivar el inicio automático de {repo}?",
    "dlg.autoOff":
      "Es una dependencia estricta de: {list}. Mientras esté desactivado, el Up de su proyecto puede fallar la comprobación de disponibilidad.",
    "dlg.autoOffGo": "Desactivar",
    "rd.keepsHead": "Sigue en marcha:",
    "rd.keepsAgents": "Los agentes y sus terminales",
    "rd.keepsServices": "Los servicios y los despliegues en GitHub",
    "rd.pausesHead": "Se pausa unos segundos y vuelve a conectarse:",
    "rd.pausesLive":
      "Las vistas en vivo de esta página: terminales, registros, un registro de despliegue abierto",
    "rd.go": "Reiniciar",
    "rd.cancel": "Cancelar",
    "rd.restarting": "Reiniciando Den…",
    "rd.back": "Den ha vuelto.",
    "busy.linkW": "Vinculando proyectos…",
    "busy.linkS.one": "Hecho: {names} quedó vinculado al Hub.",
    "busy.linkS": "Hecho: {names} quedaron vinculados al Hub.",
    "busy.linkF": "No se pudieron vincular los proyectos.",
    "busy.connW": "Conectando con el Hub…",
    "busy.connS": "Conectado al Hub.",
    "busy.connF": "No se pudo conectar con el Hub.",
    "busy.startW": "Iniciando {name}…",
    "busy.startS": "{name} iniciado.",
    "busy.startF": "No se pudo iniciar {name}.",
    "busy.termW": "Abriendo una terminal…",
    "busy.termS": "Terminal abierta.",
    "busy.schAllowW": "Permitiendo la programación…",
    "busy.schAllowS": "Permitida. Corre en su próxima hora.",
    "busy.schAllowF": "No se pudo permitir la programación.",
    "busy.schRunW": "Iniciando las pruebas programadas…",
    "busy.schRunS": "Empezó. Su resultado llega a la campana.",
    "busy.schRunF": "No se pudieron iniciar las pruebas programadas.",
    "busy.termF": "No se pudo abrir una terminal.",
    "busy.sayW": "Enviando a {name}…",
    "busy.sayS": "Enviado a {name}.",
    "busy.sayF": "No se pudo enviar a {name}.",
    "busy.emcW": "Permitiendo la aplicación web…",
    "busy.emcS": "Aplicación web permitida.",
    "busy.emcF": "No se pudo permitir la aplicación web.",
    "agc.kept": "Tu mensaje sigue aquí.",
    "busy.restartW": "Reiniciando {name}…",
    "busy.restartS": "{name} reiniciado.",
    "busy.restartF": "No se pudo reiniciar {name}.",
    "busy.modeW": "Cambiando el modo de {name}…",
    "busy.modeS": "Modo de {name} cambiado.",
    "busy.modeF": "No se pudo cambiar el modo de {name}. Nada cambió.",
    "keep.label": "Mantener los agentes al cerrar sesión",
    "keep.warn":
      "Allí los agentes inician sesión con un token de larga duración de tu almacén de secretos, no con el llavero de inicio.",
    "keep.apply": "Aplicar",
    "keep.pending": "Guardado, aún sin aplicar: pulsa Aplicar.",
    "keep.w": "Aplicando…",
    "keep.s": "Aplicado. __DEN_TITLE__ se reinicia.",
    "keep.needs": "Necesita tu contraseña de administrador.",
    "keep.failed": "No se aplicó. Nada cambió.",
    "busy.edgeW": "Iniciando el edge…",
    "busy.edgeS": "Edge iniciado",
    "busy.edgeF": "El edge no se inició.",
    "busy.testPersonW": "Configurando la persona de prueba…",
    "busy.testPersonS": "Persona de prueba configurada",
    "busy.testPersonF": "La persona de prueba no se configuró.",
    "keep.onNow": "Activado: los agentes siguen al cerrar sesión.",
    "keep.offNow": "Desactivado: los agentes se detienen al cerrar sesión.",
    "keep.saved": "Guardado. __DEN_TITLE__ ya funciona así.",
    "keep.noService":
      "Guardado. Se aplica cuando __DEN_TITLE__ funciona como servicio: __DEN_CLI__ service install",
    "keep.refused": "Sin contraseña de administrador: nada cambió.",
    "keep.offer":
      "Aún sin configurar, así que los agentes se detienen al cerrar sesión. Actívalo y pulsa Aplicar (pide tu contraseña de administrador una vez).",
    "keep.noToken":
      "No hay token de inicio de sesión: los agentes no podrán iniciar sesión tras cerrar sesión. {runtime} crea uno cuando inicias sesión en él ({docs}); pégalo en {field}, abajo.",
    "keep.credKeychain":
      "La credencial del almacén está en el llavero de inicio, al que el servicio siempre activo puede no llegar; usa file: o env: (ver docs/always-on-gate.md).",
    "keep.setup":
      "El único paso en la terminal: ejecuta esto, inicia sesión en el navegador que abre y pega aquí su token.",
    "keep.copy": "Copiar",
    "keep.tokenLabel": "Token de inicio de sesión",
    "keep.tokenSave": "Guardar",
    "keep.tokenFailed": "No se guardó: {error}",
    "keep.tokenClear": "Quitar",
    "gate.priorityOffTitle": "¿Desactivar la prioridad de versión?",
    "gate.priorityOffAsk":
      "0 desactiva la prioridad de versión para todos los repositorios de esta máquina. Una ejecución de versión que alguien espera queda entonces detrás de las normales.",
    "gate.priorityOffOk": "Desactivarla",
    "keep.clearTitle": "¿Quitar el token de inicio de sesión?",
    "keep.clearAsk":
      "Se quita del almacén de secretos. Con «Mantener los agentes al cerrar sesión», los agentes no podrán iniciar sesión hasta que se defina uno nuevo.",
    "keep.clearOk": "Quitar",
    "keep.clearW": "Quitando el token de inicio de sesión…",
    "keep.clearS": "Quitado.",
    "keep.clearF": "No se pudo quitar el token de inicio de sesión.",
    "keep.noTokenNotNeeded":
      "No hay token de inicio de sesión; solo hace falta con «Mantener los agentes al cerrar sesión».",
    "keep.processLocal":
      "Solo en este proceso: se guarda hasta que Den se reinicie.",
    "keep.noStore":
      "Esta instalación no tiene almacén de secretos, así que el token de inicio de sesión no se puede guardar. Primero define secrets.provider como 1password o doppler.",
    "keep.tokenSet":
      "Los agentes inician sesión con el token guardado el {date}.",
    "keep.tokenStore": "Los agentes inician sesión con el token de {store}.",
    "keep.tokenOld":
      "El token de inicio de sesión se guardó hace {n} días y dura alrededor de un año. {runtime} crea uno nuevo cuando inicias sesión en él ({docs}); pégalo en {field}, abajo.",
    "keep.docs": "su documentación de inicio de sesión",
    "keep.runtimeAny": "La CLI de tus agentes",
    "acct.title": "Cuentas de {vendor}",
    "acct.default": "Cuenta de {vendor} {letter}",
    "acct.add": "Añadir cuenta de {vendor}",
    "acct.none": "Sin token.",
    "acct.set": "Token guardado el {date}.",
    "acct.setUnknown": "Token guardado.",
    "acct.first": "Los agentes inician sesión con esta.",
    "acct.tokenLabel": "Token de inicio de sesión de {name}",
    "acct.tokenSave": "Guardar token de inicio de sesión",
    "acct.up": "Subir",
    "acct.down": "Bajar",
    "acct.failed": "No se guardó: {error}",
    "busy.askAllowW": "Preguntando…",
    "busy.askAllowS": "Preguntado. Permítelo en el cuadro de diálogo.",
    "busy.askAllowF": "No se pudo preguntar.",
    "busy.pushTestW": "Enviando un aviso de prueba…",
    "busy.pushTestS": "Aviso de prueba hecho. Cada dispositivo dice cómo fue.",
    "busy.pushTestF": "No se pudo enviar el aviso de prueba.",
    "busy.pushForgetW": "Olvidando este dispositivo…",
    "busy.pushForgetS": "Este dispositivo ya no recibe push.",
    "busy.pushForgetF": "No se pudo olvidar este dispositivo.",
    "busy.saveW": "Guardando…",
    "busy.saveS": "Guardado.",
    "busy.saveF": "No se pudo guardar.",
    "rd.reconnects": "Esta página se reconecta sola cuando Den vuelva.",
    "rd.version": "Versión {v}.",
    "rd.notBack": "Den no volvió.",
    "rd.notBackB":
      "Puede que aún esté arrancando. Vuelve a comprobar en un momento.",
    "rd.setButton": "Reiniciar Den",
    "um.label": "Apariencia",
    "um.title": "Apariencia y tema",
    "um.appearance": "Apariencia",
    "um.system": "Sistema",
    "um.dark": "Oscuro",
    "um.light": "Claro",
    "um.theme": "Tema",
    "um.language": "Idioma",
    "um.all": "Todos los ajustes",
    "cmd.appearance": "Apariencia: {mode}",
    "cmd.theme": "Tema: {name}",
    "cmd.language": "Idioma: {name}",
    "theme.orgDefault": "Predeterminado de la org ({name})",
    "theme.pinned": "{name} (fijado)",
    "theme.notInstalled":
      "Tu tema {id} no está instalado, así que se usa {inUse}",
    "theme.invalid":
      "Tu tema {id} no es válido ({why}), así que se usa {inUse}",
    "theme.invalidBare": "Tu tema {id} no es válido, así que se usa {inUse}",
    "api.network": "El servidor de Den no respondió a {what}",
    "api.failed": "{what} falló",
    "api.request": "Solicitud {id}",
    "api.retry": "Reintentar",
    "api.copy": "Copiar detalles",
    "api.copied": "Copiado",
    "api.close": "Descartar",
    "api.retried": "Hecho",
    "net.down": "El servidor de Den no responde; reintentando",
    "net.next": "próximo intento en {s} s",
    "net.now": "Reintentar ahora",
    "upd.msg": "Hay una nueva versión de Den.",
    "upd.reload": "Recargar",
    "upd.notNow": "Ahora no",
    "upd.cancel": "Cancelar",
    "upd.ask": "Tienes texto sin guardar en esta página. ¿Recargar igualmente?",
    "upd.region": "Actualización",
    "err.404.title": "Página no encontrada",
    "err.404.sub": "No hay nada en {path}",
    "err.404.lead": "No hay ninguna página en esta dirección.",
    "err.404.mean": "¿Querías decir {page}?",
    "err.404.stale":
      "Puede que esta página sea nueva en Den {onDisk}: el servidor sigue ejecutando {loaded}.",
    "err.404.plugin":
      "Esta página pertenece al plugin {name}, que no está instalado en esta distribución.",
    "err.404.pluginLocked":
      "Esta página pertenece al plugin {name}. Está en plugins.lock.json, pero faltan sus archivos.",
    "err.404.pluginNoPage":
      "El plugin {name} está instalado, pero no tiene ninguna página aquí.",
    "err.404.workspaces": "Ir a Proyectos",
    "err.404.search": "Buscar",
    "err.404.pages": "Páginas",
    "err.500.title": "Algo salió mal",
    "err.500.sub": "{what} falló en el servidor",
    "err.500.lead":
      "El servidor tuvo un error al responder a esta página. Reintenta o copia los detalles para un informe: el registro del servidor tiene el error completo con el mismo id de solicitud.",
    "err.500.what": "Qué falló",
    "err.500.time": "Hora",
    "err.500.id": "Id de solicitud",
    "err.500.version": "Versión",
    "err.421.title": "Dirección incorrecta",
    "err.421.lead":
      "Este servidor solo responde en sus propias direcciones, así que una página con otro nombre no puede alcanzarlo.",
    "err.421.open": "Abrir en localhost",
    "err.link.title": "Este enlace al agente no se puede abrir",
    "err.link.project": "No hay ningún proyecto {project} en este Den.",
    "err.link.agent":
      "El proyecto {project} no tiene el agente {agent}. Puede que se haya quitado.",
    "err.link.context_scheme":
      "El contexto del enlace debe ser una dirección web http o https.",
    "err.link.context_long":
      "El contexto del enlace supera los {max} caracteres. Ajustes › Incrustación fija el límite.",
    "err.link.agents": "Abrir Agentes",
    "err.refused.title": "Solicitud rechazada",
    "err.signin.terminal": "Inicia sesión para usar la terminal",
    "err.signin.agents": "Inicia sesión para iniciar agentes",
    "err.signin.sub": "Este navegador no ha iniciado sesión",
    "err.signin.lead": "Ejecuta {cmd} y abre el enlace.",
    "err.signin.expiredTitle": "El enlace de inicio de sesión caducó",
    "err.signin.local":
      "Un inicio de sesión pertenece a una sola dirección. Esta página está en {host}: abre la misma página en localhost, donde este navegador tiene la sesión iniciada.",
    "err.signin.atAddress": "{name} inicia sesión en {address}",
    "err.signin.offerTitle": "Hacer de {alias} la dirección de {name}",
    "err.signin.offerLoop":
      "La dirección de {name} es {url}, que solo se abre en su propia máquina, así que el inicio de sesión no puede llevarte allí.",
    "err.signin.offerWrong":
      "La dirección de {name} es {url}, y no funciona desde aquí.",
    "err.signin.offerUnset": "{name} aún no tiene dirección.",
    "err.signin.offerHow":
      "Inicia sesión abajo como propietario de {name}: con GitHub o con un código que apruebes en su máquina. Luego haz de {alias} su dirección y el inicio de sesión funcionará aquí.",
    "err.signin.copy": "Copiar comando",
    "err.signin.title": "Inicia sesión en {name}",
    "err.signin.where":
      "Estás abriendo {name} desde otro ordenador. {name} corre en {host}, así que necesita saber que eres tú.",
    "err.signin.ghStep1":
      "En {host}, ejecuta {cmd}, o usa Ajustes › Acceso allí.",
    "err.signin.ghStep2":
      "Muestra un código. Introdúcelo en github.com/login/device y apruébalo.",
    "err.signin.ghStep3":
      "Después vuelve aquí y pulsa Iniciar sesión con GitHub, con la misma cuenta de GitHub.",
    "err.signin.ghOwner": "Propietario: @{login}",
    "err.signin.ghOnly":
      "Solo la cuenta de GitHub del propietario puede iniciar sesión así. Para cualquier otra persona, usa «Aprueba este ordenador».",
    "err.signin.ghLearn": "Más información",
    "err.signin.claimTitle": "Conecta tu cuenta de GitHub",
    "err.signin.claimLead":
      "{name} aún no tiene propietario. Conecta tu cuenta de GitHub para que sea tuyo.",
    "err.signin.claimOrg":
      "Los miembros de la organización {org} de GitHub pueden reclamarlo, en un navegador en {host}.",
    "err.signin.claimHere": "Este es mi ordenador: conectar GitHub",
    "err.signin.claimHereOn": "En {host}: conectar GitHub",
    "err.signin.claimOrgOnly":
      "Los miembros de la organización {org} de GitHub pueden reclamarlo desde un navegador en {host}. Abre esta página en {host}, o define web.owner_github para iniciar sesión desde cualquier sitio.",
    "err.signin.claimAs": "Iniciar sesión como @{login}",
    "err.signin.claimChecking": "Comprobando que esto es {host}…",
    "err.signin.githubRefused":
      "@{login} no es el propietario de este {name}. Solo la cuenta del propietario puede usar Iniciar sesión con GitHub. Usa «Aprueba este ordenador» en su lugar.",
    "err.signin.approveOr": "O aprueba este ordenador",
    "err.signin.approve": "Aprueba este ordenador",
    "err.signin.step1": "En {host} (no en este ordenador), ejecuta:",
    "err.signin.step1Or":
      "O abre {name} en el propio {host} y ve a Ajustes › Acceso › Dispositivos en espera.",
    "err.signin.step2":
      "Esta página inicia sesión sola una vez aprobada. El código caduca en 10 minutos.",
    "err.signin.waiting": "Esperando la aprobación…",
    "err.signin.allowFrom":
      "Abre {name} en un navegador con la sesión iniciada, en {host} u otro equipo. Pregunta «¿Permitir este equipo?» con este código. Permítelo allí.",
    "err.signin.pairOther": "Otras formas: un comando en el equipo de Den",
    "err.signin.windowsSteps":
      "Abre Windows Terminal o PowerShell, pega esto y pulsa Intro.",
    "err.signin.nothingOpened":
      "¿No se abrió nada? Copia el comando de abajo y pégalo en tu app de terminal.",
    "err.signin.noTerminal":
      "¿No tienes una terminal en {host}? Desde este ordenador, ejecuta:",
    "err.signin.openTerminal": "Abrir Terminal",
    "err.signin.sshUserNote":
      "Inicia sesión con tu cuenta de {host} ({user}) y su contraseña, o con una clave SSH.",
    "err.signin.sshNote":
      "Abrir Terminal abre ssh://{target} en tu aplicación de terminal. Necesita acceso SSH a {target}.",
    "err.signin.whyTitle": "¿Por qué?",
    "err.signin.whyText":
      "{name} puede iniciar terminales y agentes en {host}, así que solo deja entrar a quien demuestra ser el propietario. Solo lo haces una vez por ordenador: la sesión se mantiene.",
    "err.signin.other": "Otras formas (el enlace de un solo uso con {cmd})",
    "err.signin.otherStep":
      "En {host} (no en este ordenador), ejecuta esto y abre en este navegador el enlace que imprime:",
    "err.signin.whereLocal":
      "{name} corre en este ordenador. Inicia sesión una vez para que sepa que este navegador eres tú. La sesión se mantiene.",
    "err.signin.step1Local": "En una terminal de este ordenador, ejecuta:",
    "err.signin.otherLocal":
      "Otras formas ({cmd} abre un enlace de inicio de sesión de un solo uso)",
    "err.signin.otherStepLocal":
      "En una terminal de este ordenador, ejecuta esto. Abre esta página con la sesión iniciada:",
    "shell.signin.line": "Inicia sesión para hacer cambios aquí.",
    "shell.signin.btn": "Iniciar sesión",
    "shell.view.title": "Vista de solo lectura",
    "shell.view.line":
      "{agent} está viendo estas páginas. Aquí no se puede cambiar nada, y la vista termina en unos minutos.",
    "shell.view.off": "Vista de solo lectura: esto no cambia nada aquí",
    "err.signin.codeExpired": "Este código caducó.",
    "err.signin.codeDenied": "Este ordenador fue rechazado en {host}.",
    "err.signin.codeFailed":
      "{name} no dio un código a esta página. Inténtalo de nuevo.",
    "err.signin.newCode": "Obtener un código nuevo",
    "err.signin.youreIn": "Ya estás dentro.",
    "err.signin.expiredLead":
      "Ese enlace de inicio de sesión caducó o ya se usó. Inicia sesión de nuevo abajo.",
    "err.signin.pairLinkLead":
      "Para dejar entrar a este navegador, apruébalo desde un navegador que ya tenga la sesión iniciada: abre allí Ajustes › Acceso y aprueba el código de abajo.",
    "err.signin.pairLinkWaiting":
      "Esperando a que lo apruebes desde un navegador con la sesión iniciada…",
    "err.signin.pairLinkDenied":
      "Se rechazó este navegador. Para iniciar sesión, obtén un código nuevo y apruébalo desde un navegador con la sesión iniciada.",
    "err.signin.pairLinkEnded":
      "Esta solicitud terminó. Obtén un código nuevo y apruébalo otra vez.",
    "err.signin.confirmLead":
      "Introduce el código que web login imprimió en {host}:",
    "err.signin.confirmGo": "Iniciar sesión",
    "err.signin.confirmWrong":
      "Ese código no es correcto. Revisa lo que imprimió web login e inténtalo de nuevo.",
    "err.signin.confirmBusy":
      "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
    "err.signin.confirmGone":
      "Este enlace ya no funciona. En {host}, ejecuta web login de nuevo para obtener uno nuevo.",
    "err.signin.confirmWhy":
      "El enlace solo no basta: también hace falta el código que se muestra en {host}, así que alguien que vea el enlace no puede iniciar sesión.",
    // Issue 868: the ways in this install has, on the signed-out page.
    "err.signin.methods.title": "Formas de iniciar sesión en {name}",
    "err.signin.methods.ready": "Configurado aquí",
    "err.signin.methods.notReady": "No configurado aquí",
    "err.signin.methods.hostOnly": "Solo en {host}",
    "err.signin.methods.github": "Iniciar sesión con GitHub",
    "err.signin.methods.githubReady":
      "Usa Iniciar sesión con GitHub más abajo, desde cualquier ordenador.",
    "err.signin.methods.githubNoClient":
      "No hay ningún id de cliente de GitHub App ({setting}). Una persona lo pone en {file} en {host} y después ejecuta {restart} allí.",
    "err.signin.methods.githubNoOwner":
      "Aún no hay ningún propietario vinculado en GitHub, así que nadie puede usarlo desde otro ordenador.",
    "err.signin.methods.pair": "Pedir iniciar sesión desde este dispositivo",
    "err.signin.methods.pairReady":
      "Un navegador que ya inició sesión en {name} aprueba este escribiendo el código que muestra esta página.",
    "err.signin.methods.pairNone":
      "Aún no hay ningún navegador con sesión iniciada en {name}, así que nadie puede aprobar este.",
    "err.signin.methods.ask": "Pedir iniciar sesión",
    "err.signin.methods.terminal": "Un enlace desde una terminal en {host}",
    "err.signin.methods.terminalHow":
      "Ejecuta {cmd} en una terminal en {host} y abre el enlace que imprime.",
    "err.signin.methods.stuck":
      "Aún no se puede iniciar sesión en {name} desde otro ordenador. Iniciar sesión con GitHub no está configurado, y no hay ningún navegador con sesión iniciada en {name} que apruebe este.",
    "err.signin.methods.fixClient":
      "Para arreglarlo, en {host} pon en {setting} un id de cliente de GitHub App en {file} y ejecuta {restart}. Así Iniciar sesión con GitHub funciona desde cualquier ordenador.",
    "err.signin.methods.fixOwner":
      "Para arreglarlo, vincula al propietario en GitHub: en {host}, ejecuta {cmd}. Así Iniciar sesión con GitHub funciona desde cualquier ordenador.",
    "err.signin.methods.fixFirst":
      "O termina el primer inicio de sesión en el propio {host}: después ese navegador puede aprobar este.",
    "err.signin.firstRunHere":
      "{name} aún no está configurado. Termina su primer inicio de sesión en el propio {host}: abre allí el enlace de configuración, o ejecuta web login en tu propia terminal allí.",
    "err.signin.tooManyRequests":
      "Demasiadas solicitudes de inicio de sesión desde esta dirección. Espera un minuto y abre el enlace de nuevo.",
    "err.signin.tooManyWaiting":
      "Hay demasiados dispositivos esperando aprobación en {name}. Espera unos minutos y abre el enlace de nuevo.",
    "err.signin.claimSetUp":
      "{name} ya está configurado, así que el enlace de configuración ya no inicia sesión por sí solo. Aprueba este navegador desde uno con la sesión iniciada: Ajustes › Acceso y luego el código de abajo.",
    "err.signin.github": "Iniciar sesión con GitHub",
    "err.signin.githubEnter": "Introduce este código en {url}:",
    "err.signin.githubOpen": "Abrir GitHub",
    "err.signin.githubWaiting": "Esperando a que lo apruebes en GitHub…",
    "err.signin.githubDone": "Sesión iniciada. Cargando…",
    "err.signin.githubExpired": "El código caducó antes de aprobarse.",
    "err.signin.githubDenied": "La solicitud se canceló en GitHub.",
    "err.signin.githubBusy":
      "Hay demasiados inicios de sesión en curso. Vuelve a intentarlo en unos minutos.",
    "err.signin.githubFailed":
      "No se pudo contactar con GitHub. Inténtalo de nuevo.",
    "err.signin.githubAgain": "Empezar de nuevo",
    "err.422.title": "La configuración no es válida",
    "err.422.sub": "La configuración de la distribución no pasa la validación",
    "err.422.lead":
      "Las páginas que leen la configuración esperan hasta que sea válida. Corrige cada clave de abajo; mientras tanto, Ajustes y Registros siguen funcionando.",
    "err.422.file": "Archivo",
    "err.422.key": "Clave",
    "err.422.problem": "Problema",
    "err.422.cmd": "Para ver lo mismo en una terminal, ejecuta:",
    "err.422.reload": "Recargar cuando esté corregido",
    "err.422.logs": "Abrir Registros",
    "err.422.settings": "Abrir Ajustes",
    "set.appearance.mode": "Modo",
    "set.appearance.theme": "Tema",
    "set.language": "Idioma",
    "set.time_zone": "Zona horaria",
    "set.appearance.org-theme": "Tema predeterminado de la org",
    "set.editor": "IDE predeterminado",
    "set.server.self_update": "Versiones nuevas",
    "set.server.self_update.d":
      "Cuando sale un __DEN_TITLE__ nuevo. Preguntar: la actualización espera tu permiso en la campana. Automático: __DEN_TITLE__ se actualiza en un momento tranquilo y vuelve atrás por sí mismo si la versión nueva no arranca.",
    "set.server.self_update.o.ask": "Preguntar",
    "set.server.self_update.o.auto": "Automático",
    "set.server.update_check": "Comprobaciones de versión",
    "set.server.update_check.d":
      "De dónde viene la opción Versiones nuevas, y cuándo __DEN_TITLE__ buscó una versión nueva por última vez y cuándo vuelve a buscar.",
    "set.ui.suFrom.user": "Elegido por ti (config/local/user.yml)",
    "set.ui.suFrom.dist":
      "De la configuración de la distribución; se copia a config/local/user.yml en el próximo arranque",
    "set.ui.suFrom.default": "El valor por defecto: Preguntar",
    "set.ui.ucOff": "Las comprobaciones están desactivadas",
    "set.ui.ucNone": "Aún sin comprobar",
    "set.ui.ucLast": "Última comprobación {t}: {did}",
    "set.ui.ucNext": "siguiente {t}",
    "set.ui.ucDid.asked": "salió {v}, espera tu permiso",
    "set.ui.ucDid.waiting": "salió {v}, espera un momento tranquilo",
    "set.ui.ucDid.waitAllow":
      "salió {v}, espera: el agente de __DEN_TITLE__ espera tu permiso",
    "set.ui.ucDid.waitAsked":
      "salió {v}, espera: el agente de __DEN_TITLE__ te hizo una pregunta",
    "set.ui.ucDid.updating": "actualizando a {v}",
    "set.ui.ucDid.failed": "no se pudo actualizar a {v}",
    "set.ui.ucDid.skipped": "omitida",
    "set.ui.ucDid.current": "en la versión más nueva",
    "set.server.crash_loop": "Protección contra reinicios",
    "set.server.crash_loop.d":
      "Cuando la app web de __DEN_TITLE__ se detiene sin un cierre limpio estas veces dentro de los minutos de abajo, el siguiente arranque espera antes de atender, más cada vez, y la campana lo avisa. __DEN_CLI__ config web.crash_loop_restarts=5",
    "set.server.crash_loop_minutes": "Ventana de la protección, en minutos",
    "set.server.crash_loop_minutes.d":
      "Los minutos en los que se cuentan los cierres no limpios de arriba. __DEN_CLI__ config web.crash_loop_minutes=10",
    "set.server.lookup_first": "Espera de la búsqueda de procesos",
    "set.server.lookup_first.d":
      "Cuánto espera __DEN_TITLE__ en su primer intento cuando pregunta al sistema qué proceso tiene una conexión (lsof, ps). Así se ubican las llamadas de un agente. __DEN_CLI__ config process_lookup.first_seconds=5",
    "set.server.lookup_retry": "Espera del reintento de la búsqueda",
    "set.server.lookup_retry.d":
      "Cuánto espera el segundo intento cuando el primero se quedó sin tiempo. Una máquina ocupada puede tardar en responder. __DEN_CLI__ config process_lookup.retry_seconds=20",
    "set.server.address_check_timeout":
      "Espera de la comprobación de dirección",
    "set.server.address_check_timeout.d":
      "Cuánto espera __DEN_TITLE__ a que una dirección responda al comprobar que llega a este __DEN_TITLE__, antes de mostrarla o abrirla. __DEN_CLI__ config web.address_check_timeout_seconds=5",
    "set.server.address_check_retries":
      "Reintentos de la comprobación de dirección",
    "set.server.address_check_retries.d":
      "Cuántas veces más pregunta __DEN_TITLE__ a una dirección que no respondió a tiempo. __DEN_CLI__ config web.address_check_retries=2",
    "set.server.address_check_cache":
      "Comprobación de dirección guardada durante",
    "set.server.address_check_cache.d":
      "Cuánto tiempo reutilizan el aviso de la página y Edge la última comprobación de la dirección de __DEN_TITLE__. 0 comprueba en cada lectura. __DEN_CLI__ config web.address_check_cache_seconds=60",
    "set.server.address_check_drop_after":
      "Fallos de la dirección antes de que el inicio de sesión vuelva",
    "set.server.address_unknown_keep":
      "Dirección mantenida mientras las comprobaciones no saben",
    "set.server.address_unknown_keep.d":
      "Una vez comprobada la dirección https de __DEN_TITLE__, cuánto tiempo las comprobaciones que no pueden saberlo (sin respuesta a tiempo) mantienen el inicio de sesión allí, desde su última respuesta. Después se toman como fallos, y el inicio de sesión vuelve al nombre propio de esta máquina. Mejor corto. __DEN_CLI__ config web.address_unknown_keep_seconds=300",
    "set.server.address_check_drop_after.d":
      "Una vez comprobada la dirección https de __DEN_TITLE__, el inicio de sesión vive solo allí. Cuántas comprobaciones seguidas deben encontrar otra cosa, o nada, respondiendo en esa dirección antes de que el inicio de sesión vuelva a funcionar en el nombre propio de esta máquina. Una comprobación que no puede saberlo se ignora. __DEN_CLI__ config web.address_check_drop_after=2",
    "set.server.bridge_listen": "Puente de Docker, para el edge",
    "set.server.bridge_listen.d":
      "Solo en Linux, con un edge configurado aquí: __DEN_TITLE__ también escucha en la dirección del puente de Docker, por donde el edge llega a esta máquina. Desactivado: solo 127.0.0.1, y el edge no llega a __DEN_TITLE__. Se aplica en el siguiente arranque. __DEN_CLI__ config web.bridge_listen=off",
    "set.server.bridge_listen.o.auto": "Automático",
    "set.server.bridge_listen.o.off": "Desactivado",
    "set.server.bridge_probe": "Comprobación del puente de Docker, en segundos",
    "set.server.bridge_probe.d":
      "Cuánto espera __DEN_TITLE__ a que Docker dé la dirección del puente al arrancar. Nunca retrasa el arranque. __DEN_CLI__ config web.bridge_probe_seconds=10",
    "set.server.owner_name_timeout":
      "Consulta del nombre en GitHub al arrancar, en segundos",
    "set.server.owner_name_timeout.d":
      "Cuánto espera __DEN_TITLE__ al arrancar el nombre del propietario de su perfil público de GitHub, cuando aún no lo tiene. Nunca retrasa el arranque. __DEN_CLI__ config web.owner_name_timeout_seconds=10",
    "set.server.github_watch_interval":
      "Vigilancia de GitHub: primer intervalo, en segundos",
    "set.server.github_watch_interval.d":
      "Cada cuánto el único vigilante de GitHub de __DEN_TITLE__ mira las solicitudes de cambios y las ejecuciones que vigilan los agentes (MCP github_watch). Se duplica mientras nada cambia y vuelve a empezar cuando algo cambia. __DEN_CLI__ config github.watch_interval_seconds=60",
    "set.server.github_watch_max_interval":
      "Vigilancia de GitHub: intervalo más largo, en segundos",
    "set.server.github_watch_max_interval.d":
      "Lo más que espera el vigilante de GitHub entre una mirada y otra mientras nada cambia. __DEN_CLI__ config github.watch_max_interval_seconds=300",
    "set.server.github_api_budget_floor":
      "Vigilancia de GitHub: llamadas a la API en reserva",
    "set.server.github_api_budget_floor.d":
      "Con menos llamadas a la API de GitHub que estas en lo que queda de hora, el vigilante no pregunta nada a GitHub y rechaza vigilancias nuevas hasta que GitHub reinicia el límite, y lo dice con la hora del reinicio. __DEN_CLI__ config github.api_budget_floor=500",
    "set.server.github_watches_max":
      "Vigilancia de GitHub: vigilancias a la vez",
    "set.server.github_watches_max.d":
      "Cuántas solicitudes de cambios y ejecuciones vigila a la vez el vigilante de GitHub, para todos los agentes de aquí juntos. Una más se rechaza, diciendo por qué. __DEN_CLI__ config github.watches_max=50",
    "set.server.ready_probe": "Comprobación de que está listo, en segundos",
    "set.server.ready_probe.d":
      "Cuánto espera cada comprobación de que __DEN_TITLE__ está en marcha a que responda. Una máquina ocupada responde tarde; una respuesta tardía también vale. __DEN_CLI__ config web.ready_probe_seconds=10",
    "set.server.start_wait": "Espera al arrancar, en segundos",
    "set.server.start_wait.d":
      "Cuánto espera `web up` a que __DEN_TITLE__ esté listo antes de decir que no arrancó. Un arranque que falla termina la espera enseguida. __DEN_CLI__ config web.start_wait_seconds=120",
    "set.server.gate_cpu": "Pruebas unitarias a la vez, en esta máquina",
    "set.server.gate_cpu.d":
      "Cuántas ejecuciones de pruebas unitarias (`gate run --kind cpu`) comparten esta máquina. Las pruebas unitarias y las de navegador esperan en colas separadas. Cada instalación y repositorio de aquí comparte la misma cola. __DEN_CLI__ gate settings --cpu-slots 2",
    "set.server.gate_cpu_beside":
      "Pruebas unitarias junto a una prueba de navegador",
    "set.server.gate_cpu_beside.d":
      "Cuántas pruebas unitarias pueden ejecutarse en esta máquina mientras se ejecuta una prueba de navegador, nunca más que las pruebas unitarias a la vez. 0: una prueba de navegador se ejecuta sola. Una prueba de navegador en una máquina de pruebas no se incluye. __DEN_CLI__ gate settings --cpu-slots-beside-browser 2",
    "set.server.gate_cpu_beside_release":
      "Pruebas unitarias junto a una prueba de navegador de versión",
    "set.server.gate_cpu_beside_release.d":
      "Cuántas pruebas unitarias pueden ejecutarse en esta máquina mientras se ejecuta una prueba de navegador con prioridad de versión. 0 (el valor predeterminado): la prueba de versión se ejecuta sola, para que otras no ralenticen sus comprobaciones. Las demás pruebas de navegador usan el ajuste de arriba. __DEN_CLI__ gate settings --cpu-slots-beside-release-browser 0",
    "set.server.gate_load_hold_per_core":
      "Esperar nuevas pruebas unitarias por encima de esta carga por núcleo",
    "set.server.gate_load_hold_per_core.d":
      "Las nuevas pruebas unitarias esperan mientras la carga media de 5 minutos de esta máquina supere este número de veces sus núcleos, pero solo mientras otra prueba unitaria se ejecuta: si no hay ninguna, la siguiente empieza con cualquier carga. Las pruebas de versión y las que ya se ejecutan nunca esperan. Cada prueba unitaria recibe también su parte de los núcleos en DEN_GATE_WORKERS. 0 desactiva la espera. __DEN_CLI__ gate settings --load-hold-per-core 3",
    "set.server.gate_cpu_hold_load":
      "Carga de la máquina que detiene las pruebas unitarias durante una prueba de navegador de versión",
    "set.server.gate_cpu_hold_load.d":
      "Mientras la carga media de 5 minutos de esta máquina sea igual o mayor que este valor, y una prueba de navegador con prioridad de versión tenga un puesto de navegador, las pruebas unitarias esperan. Las que ya corren nunca se detienen. El valor predeterminado es el número de núcleos × 4 / 3. 0 lo apaga. __DEN_CLI__ gate settings --cpu-hold-load 24",
    "set.server.gate_local_browser":
      "Pruebas de navegador a la vez en esta máquina",
    "set.server.gate_local_browser.d":
      "Cuántas pruebas de navegador pueden ejecutarse a la vez en esta máquina, cada una en su propio contenedor. Una prueba de navegador en una máquina de pruebas no se incluye. 1: una a la vez. __DEN_CLI__ gate settings --local-browser-slots 1",
    "set.server.gate_overrun_bell":
      "Turno de prueba en la campana pasadas estas veces su estimación",
    "set.server.gate_overrun_bell.d":
      "Un turno de prueba que dura estas veces más que su estimación aparece en la campana, en Te necesitan, con Terminar. Si lo tiene un agente, Den le dice una vez que lo libere. 2: el doble de su estimación. __DEN_CLI__ gate settings --overrun-bell-multiple 2",
    "set.server.gate_overrun":
      "Prueba marcada pasada su estimación, en minutos",
    "set.server.gate_overrun.d":
      "Una prueba que sigue tanto tiempo después de su estimación se marca en `gate status` y en la página Agentes. Nunca se detiene. __DEN_CLI__ gate settings --overrun-margin-minutes 15",
    "set.server.gate_remote_renew":
      "El runner de CI renueva su turno cada, en segundos",
    "set.server.gate_remote_renew.d":
      "Un trabajo de CI en una VM runner mantiene su turno de pruebas renovándolo con esta frecuencia (se le dice el número cuando lo pide). __DEN_CLI__ gate settings --remote-renew-seconds 30",
    "set.server.gate_remote_lapse":
      "El turno de un runner de CI se recupera tras, en segundos",
    "set.server.gate_remote_lapse.d":
      "Un runner de CI que no renueva su turno en este tiempo lo pierde, y empieza el siguiente en la cola. Al menos el doble del tiempo de renovación. __DEN_CLI__ gate settings --remote-lapse-seconds 120",
    "set.server.gate_remote_slots":
      "Turnos de pruebas que un runner de CI puede tener a la vez",
    "set.server.gate_remote_slots.d":
      "Ocupados o en espera. Otra petición se rechaza, diciendo por qué, hasta que el runner devuelva uno. __DEN_CLI__ gate settings --remote-max-slots 4",
    "set.server.gate_remote_asks":
      "Peticiones que un runner de CI puede tener esperando a la vez",
    "set.server.gate_remote_asks.d":
      "Peticiones de turno que aún esperan respuesta. Otra se rechaza, diciendo por qué, hasta que una responda. __DEN_CLI__ gate settings --remote-max-asks 4",
    "set.server.gate_priority_max":
      "Ejecuciones de versión con prioridad a la vez, por tipo",
    "set.server.gate_priority_max.d":
      "Una ejecución de versión que una persona espera, marcada con prioridad de versión, pasa delante de las demás que esperan de su tipo. Nunca detiene una que ya se ejecuta. Una segunda espera detrás de la primera. 0 lo desactiva. __DEN_CLI__ gate settings --priority-max 1",
    "set.server.gate_priority_pass":
      "Una ejecución de versión marcada que espera tanto nunca se adelanta, en minutos",
    "set.server.gate_priority_pass.d":
      "Una ejecución de versión con prioridad pasa delante de todas las demás que esperan de su tipo. Entre las marcadas con prioridad de versión, nunca pasa a una que lleva esperando este tiempo. 0: nunca pasa a otra marcada. __DEN_CLI__ gate settings --priority-pass-limit-minutes 0",
    "set.server.gate_priority_agents":
      "Los agentes pueden pedir prioridad de versión",
    "set.server.gate_priority_agents.d":
      "Activado, un agente puede marcar una ejecución de versión para un problema que tú informaste. Desactivado, solo tú puedes. Cada adelanto queda en el registro de turnos, con quién y por qué. __DEN_CLI__ gate settings --priority-agents 1",
    "set.server.gate_priority_runners":
      "Los runners de CI pueden pedir prioridad de versión",
    "set.server.gate_priority_runners.d":
      "Activado, un trabajo de CI con un token de runner puede marcar su ejecución como de versión, con un motivo. Desactivado, su petición se rechaza y espera en la cola normal. Cada adelanto queda en el registro de turnos, con el runner y el porqué. __DEN_CLI__ gate settings --priority-runners 1",
    "set.server.gate_browser_container":
      "Las ejecuciones de navegador necesitan un contenedor",
    "set.server.gate_browser_container.d":
      "Activado, una ejecución de pruebas de navegador en esta máquina debe indicar dónde corre su navegador: el endpoint de Playwright de un contenedor (ws:// o wss://, también desde DEN_PW_WS, HUB_PW_WEBKIT_WS o E2E_WEBKIT_WS), o self cuando la ejecución inicia su propio contenedor. Una ejecución sin él se rechaza, así ninguna prueba inicia un navegador en este Mac. Activado por defecto en macOS, desactivado en los demás. __DEN_CLI__ gate settings --browser-requires-container 1",
    "set.server.gate_claim": "Turno de un agente: minutos para reclamarlo",
    "set.server.gate_claim.d":
      "Cuando se concede un turno que un agente esperaba, Den se lo dice. Si no lo reclama en este tiempo, pasa al siguiente de la cola y el agente vuelve a la cola. __DEN_CLI__ gate settings --claim-minutes 3",
    "set.server.gate_mcp_renew":
      "Turno de un agente: renovarlo cada, en minutos",
    "set.server.gate_mcp_renew.d":
      "Cada cuánto se pide a un agente que tiene un turno que lo renueve mientras trabaja. __DEN_CLI__ gate settings --mcp-renew-minutes 5",
    "set.server.gate_mcp_lapse":
      "Turno de un agente: caduca sin renovar tras, en minutos",
    "set.server.gate_mcp_lapse.d":
      "Un turno que un agente tiene y no renueva en este tiempo, pasada su estimación más el margen, pasa al siguiente de la cola. La campana lo dice. __DEN_CLI__ gate settings --mcp-lapse-minutes 15",
    "set.server.gate_mcp_grace":
      "Turno de un agente: margen tras su estimación, en minutos",
    "set.server.gate_mcp_grace.d":
      "Un turno sin renovar se mantiene hasta pasar su estimación en este tiempo. __DEN_CLI__ gate settings --mcp-grace-minutes 15",
    "set.server.gate_class_order": "Clases de turno, de mayor a menor",
    "set.server.gate_class_order.d":
      "Separadas por comas, por ejemplo release, lane, other. Una ejecución en espera de una clase mayor empieza antes; dentro de una clase, por orden de llegada. Una ejecución que tiene su turno nunca se detiene. Vacío: orden de llegada para todas. __DEN_CLI__ gate settings --class-order release,lane,other",
    "set.server.gate_class_map": "Clase de turno de cada proyecto",
    "set.server.gate_class_map.d":
      "Separadas por comas: <proyecto>=<clase>, label:<patrón>=<clase> (* vale por cualquier texto) y *=<clase> para los demás proyectos. Sin *, la última clase. __DEN_CLI__ gate settings --class-map den=lane,label:release*=release,*=other",
    "set.server.gate_class_windows": "Horarios de las clases de turno",
    "set.server.gate_class_windows.d":
      "Separados por comas: <clase>=HH:MM-HH:MM/<minutos>, en la hora de esta máquina. Fuera de su horario, una ejecución de esa clase estimada en al menos esos minutos espera mientras una de clase mayor tiene turno o espera; si no hay ninguna, empieza enseguida. __DEN_CLI__ gate settings --class-windows other=22:00-06:00/30",
    "set.server.gate_runners": "Tokens de runners de CI",
    "set.server.gate_runners.d":
      "Tokens con los que un trabajo de CI en una VM runner pide, renueva y devuelve turnos de pruebas en esta máquina. Nada más. Un agente pide uno y tú lo permites; revócalo aquí.",
    "set.server.gate_boxes": "Máquinas de pruebas",
    "set.server.gate_boxes.d":
      "Otras máquinas que ejecutan pruebas de navegador. Cada una tiene sus propios turnos de navegador. Una ejecución de navegador que puede usar una máquina toma el turno que se libere primero, aquí o en una máquina. Una máquina con su archivo de pausa presente no toma ejecuciones nuevas. Una que no responde se omite, nunca se espera. Una máquina con horario solo toma ejecuciones dentro de él, en la hora de esta máquina. Fuera de él, o apagada, Den nunca la contacta; una ejecución que ya está en ella termina. __DEN_CLI__ gate box add <name> --ssh login@host --slots 1",
    "set.server.gate_box_check":
      "Espera de la comprobación de una máquina, en segundos",
    "set.server.gate_box_check.d":
      "Cuánto espera Den la respuesta de una máquina de pruebas cuando está a punto de darle un turno. Sin respuesta, la máquina se omite. __DEN_CLI__ gate settings --box-check-timeout-seconds 8",
    "set.server.gate_box_recheck":
      "Una máquina omitida se comprueba de nuevo tras, en segundos",
    "set.server.gate_box_recheck.d":
      "Una máquina en pausa o que no respondió se omite durante este tiempo y luego se comprueba de nuevo la próxima vez que se quiera un turno en ella. Nunca con un temporizador. __DEN_CLI__ gate settings --box-recheck-seconds 30",
    "set.server.gate_box_default": "Las pruebas de navegador van a",
    "set.server.gate_box_default.d":
      "Adónde va una prueba de navegador sin --box. Aquí o una máquina de pruebas: el primer turno de navegador libre, aquí o en una máquina de pruebas. Una prueba sin --base-url, o sin máquina para su versión de Playwright, se queda aquí y dice por qué. Solo aquí: como antes; una prueba va a una máquina solo con --box. __DEN_CLI__ gate settings --browser-box-default any",
    "set.server.gate_box_default.any": "Aquí o una máquina de pruebas",
    "set.server.gate_box_default.local": "Solo aquí",
    "set.server.gate_host_only": "Pruebas de navegador que se quedan aquí",
    "set.server.gate_host_only.d":
      "Separados por comas: <proyecto>, label:<patrón> (* vale por cualquier texto). Estas pruebas de navegador nunca van a una máquina de pruebas, por ejemplo las de diseño o WebKit en macOS. Vacío: ninguna. __DEN_CLI__ gate settings --browser-host-only den,label:*webkit*",
    "set.server.crash_loop_wait": "Espera máxima de la protección",
    "set.server.crash_loop_wait.d":
      "Lo más que espera el siguiente arranque. 0 nunca espera. __DEN_CLI__ config web.crash_loop_max_wait_seconds=300",
    "set.server.report_screenshot_days": "Capturas de informes, se guardan",
    "set.server.report_screenshot_days.d":
      "Cuántos días guarda __DEN_TITLE__ la captura con las zonas tapadas de un informe enviado desde aquí, para que tú y el agente propio de esta instalación la leáis (report_screenshot). Después se borra. __DEN_CLI__ config reports.screenshot_keep_days=30",
    "set.server.report_screenshot_max":
      "Capturas de informes, la más grande guardada",
    "set.server.report_screenshot_max.d":
      "La captura con las zonas tapadas más grande que __DEN_TITLE__ guarda con un informe. Una mayor se rechaza antes de enviar nada. __DEN_CLI__ config reports.screenshot_max_mb=8",
    "set.server.report_screenshot_hub_max":
      "Capturas de informes, la más grande enviada a Hub",
    "set.server.report_screenshot_hub_max.d":
      "La captura con las zonas tapadas más grande que __DEN_TITLE__ envía a Hub. Una mayor se guarda aquí igualmente, y el informe se envía igual. __DEN_CLI__ config reports.hub_screenshot_max_mb=6",
    "set.server.report_screenshot_hub_wait":
      "Capturas de informes, espera a Hub",
    "set.server.report_screenshot_hub_wait.d":
      "Cuánto espera __DEN_TITLE__ a que Hub reciba la captura de un informe. Pasado ese tiempo, la captura se guarda aquí, y el informe ya está enviado. __DEN_CLI__ config reports.hub_timeout_seconds=10",
    "set.server.report_visibility_cache":
      "Informe: visibilidad del repositorio guardada durante",
    "set.server.report_visibility_cache.d":
      "Cuánto guarda __DEN_TITLE__ si cada repositorio de Informe es público o privado. Pasado este tiempo, vuelve a preguntar a GitHub. __DEN_CLI__ config feedback.visibility_cache_hours=24",
    "set.server.report_visibility_wait":
      "Informe: espera de la visibilidad del repositorio",
    "set.server.report_visibility_wait.d":
      "Cuánto espera Informe a que GitHub diga si un repositorio es público o privado. Pasado este tiempo, dice que no se sabe (con el aviso), y la respuesta se ve la próxima vez. __DEN_CLI__ config feedback.visibility_timeout_seconds=3",
    "set.server.report_visibility_retry":
      "Informe: reintento de la visibilidad del repositorio",
    "set.server.report_visibility_retry.d":
      "Si GitHub no responde si un repositorio es público o privado, cuánto tarda Informe en volver a preguntar. 0 pregunta cada vez que se abre. __DEN_CLI__ config feedback.visibility_retry_seconds=60",
    "set.agents.pane_reconnect": "Intentos de reconexión de la terminal",
    "set.agents.pane_reconnect.d":
      "Una terminal que pierde la conexión vuelve a intentarlo sola, esperando más cada vez. Tras estos intentos fallidos dentro del tiempo de abajo, se detiene y muestra Reconectar. __DEN_CLI__ config panes.reconnect_max_failures=20",
    "set.agents.pane_reconnect_window": "Ventana de reconexión de la terminal",
    "set.agents.pane_reconnect_window.d":
      "El tiempo en el que se cuentan los intentos fallidos de arriba. __DEN_CLI__ config panes.reconnect_window_seconds=300",
    "set.agents.pane_reconnect_wait": "Espera máxima entre intentos",
    "set.agents.pane_reconnect_wait.d":
      "El primer intento espera 1 s y cada espera se duplica, hasta este valor. __DEN_CLI__ config panes.reconnect_max_seconds=30",
    "set.agents.shell_path_wait": "Espera al PATH del shell",
    "set.agents.shell_path_wait.d":
      "Cuánto espera __DEN_TITLE__ a que tu shell diga su PATH al buscar las CLI de agentes: el PATH que recibe un shell nuevo, con sus archivos de inicio. Pasado este tiempo, busca en los lugares habituales. __DEN_CLI__ config agents.shell_path_timeout_seconds=10",
    "set.agents.list_host_wait": "Espera al host de terminales",
    "set.agents.list_host_wait.d":
      "Cuánto espera la lista de agentes al host de terminales. Pasado este tiempo, la lista dice que no pudo contactarlo y lo intenta de nuevo. __DEN_CLI__ config agents_list.host_timeout_seconds=10",
    "set.server.sessions_max": "Terminales a la vez",
    "set.server.sessions_max.d":
      "Cuántas terminales simples pueden funcionar a la vez. Los agentes nunca cuentan. Una nueva por encima de esto se rechaza, y lo dice. __DEN_CLI__ config sessions.max_concurrent=8",
    "set.server.sessions_close_grace": "Margen al cerrar una terminal",
    "set.server.sessions_close_grace.d":
      "Cuánto tiempo tiene una terminal para terminar después de que la cierras, antes de que se detenga a la fuerza. __DEN_CLI__ config sessions.close_grace_seconds=5",
    "set.server.sessions_pty_close": "Cierre de terminal tras salir",
    "set.server.sessions_pty_close.d":
      "Cuánto tiempo después de que termina el programa de una terminal se cierra su terminal. 0 la cierra al instante. Su historial sigue legible en ambos casos. Se aplica la próxima vez que arranque el host de terminales. __DEN_CLI__ config sessions.pty_close_seconds=0",
    "set.server.sessions_pty_warn": "Aviso por número de terminales",
    "set.server.sessions_pty_warn.d":
      "Doctor falla cuando el host de terminales tiene más terminales que esto. __DEN_CLI__ config sessions.pty_warn_above=400",
    "set.server.sessions_pty_machine":
      "Aviso de terminales de la máquina, en porcentaje",
    "set.server.sessions_pty_machine.d":
      "Doctor falla cuando las terminales en uso en esta máquina llegan a esta parte de su límite. __DEN_CLI__ config sessions.pty_machine_warn_percent=90",
    "set.agents.hook_wait": "Espera de los hooks de agente",
    "set.agents.hook_wait.d":
      "Cuánto esperan los hooks de un agente a __DEN_TITLE__ en cada intento cuando le avisan de que el agente te necesita o revisan la bandeja de Hub. Una máquina ocupada puede tardar en responder. Se aplica la próxima vez que el agente arranque. __DEN_CLI__ config agent_hooks.timeout_seconds=20",
    "set.agents.hook_retries": "Reintentos de los hooks de agente",
    "set.agents.hook_retries.d":
      "Cuántas veces más lo intenta el hook de un agente cuando __DEN_TITLE__ no respondió a tiempo o rechazó la llamada. Se aplica la próxima vez que el agente arranque. __DEN_CLI__ config agent_hooks.retries=2",
    "set.agents.hook_backoff": "Pausa de los hooks de agente",
    "set.agents.hook_backoff.d":
      "Cuánto espera el hook de un agente antes de su primer reintento. Cada pausa siguiente se duplica. Se aplica la próxima vez que el agente arranque. __DEN_CLI__ config agent_hooks.backoff_seconds=1",
    "set.agents.compaction_loop": "Compactación repetida: compactaciones",
    "set.agents.compaction_loop.d":
      "Cuántas compactaciones automáticas puede tener un agente dentro de los minutos de abajo antes de que la campana avise de que se compacta una y otra vez. Una campana por episodio. __DEN_CLI__ config agent_context.compaction_loop_count=3",
    "set.agents.compaction_minutes": "Compactación repetida: minutos",
    "set.agents.compaction_minutes.d":
      "El intervalo en el que se cuentan las compactaciones de arriba. __DEN_CLI__ config agent_context.compaction_loop_minutes=10",
    "set.agents.compaction_pause":
      "Retener entregas tras una compactación repetida",
    "set.agents.compaction_pause.d":
      "Activado: cuando la campana avisa de que un agente se compacta una y otra vez, las nuevas entregas (comentarios de Hub, avisos) esperan hasta que una persona lo despeje en la página de agentes. Desactivado (por defecto): se entregan como siempre. __DEN_CLI__ config agent_context.pause_after_loop=true",
    "set.agents.instruction_share":
      "Archivos de instrucciones: avisar por encima de",
    "set.agents.instruction_share.d":
      "Cuando los archivos de instrucciones que un agente carga al empezar (CLAUDE.md, AGENTS.md y similares, subiendo por sus carpetas) superan esta parte del contexto de su modelo, su fila y doctor avisan y nombran el más grande. El tamaño se estima como bytes / 4 tokens. __DEN_CLI__ config agent_context.instruction_share_percent=15",
    "set.agents.context_tokens": "Tamaño del contexto si se desconoce",
    "set.agents.context_tokens.d":
      "El tamaño del contexto, en tokens, sobre el que se toma la parte de arriba cuando __DEN_TITLE__ no conoce el del modelo. __DEN_CLI__ config agent_context.context_tokens=200000",
    "set.agents.list_refresh_wait": "Espera de la lista de agentes",
    "set.agents.list_refresh_wait.d":
      "Cuánto espera la página de agentes su lista. Pasado este tiempo, dice que la lista puede estar desactualizada y lo intenta de nuevo. __DEN_CLI__ config agents_list.refresh_timeout_seconds=15",
    "set.server.address": "La dirección de __DEN_TITLE__",
    "set.server.address.d":
      "La dirección con la que las personas y otros dispositivos abren este __DEN_TITLE__, por ejemplo https://__DEN_CLI__.local.example.com. Comprobar y guardar le pide primero que responda, y solo guarda si responde. Igual que __DEN_CLI__ web url.",
    "addr.now": "Definida: {url}",
    "addr.unset": "Sin definir. Los enlaces que da __DEN_TITLE__ la necesitan.",
    "addr.label": "Dirección",
    "addr.check": "Comprobar y guardar",
    "addr.checkW": "Comprobando que {url} responde",
    "addr.saved": "Guardada: {url} respondió.",
    "addr.notSaved": "No se guardó. Se mantiene la dirección anterior.",
    "addr.empty": "Escribe primero una dirección.",
    "addr.loopback":
      "{url} solo se abre en esta máquina: otros dispositivos no llegan a ella.",
    "addr.adopt": "Hacer de {alias} la dirección de __DEN_TITLE__",
    "addr.adopted": "Guardada: {url} es ahora la dirección.",
    "set.workspace.approvals_policy": "Escrituras de los agentes aquí",
    "set.workspace.approvals_policy.d":
      "Lo que un agente de este proyecto puede hacer sin tu Permitir, por encima de Escrituras de agentes. Una escritura que amplía lo que un agente puede hacer, toca secretos, borra datos o gasta dinero siempre pregunta.",
    "set.workspace.approvals_policy.o.install": "Como en todas partes",
    "set.workspace.approvals_policy.o.auto": "Ejecutar sin aviso",
    "set.workspace.approvals_policy.o.notify": "Ejecutar y avisarme",
    "set.workspace.approvals_policy.o.ask": "Preguntarme",
    "set.workspace.approvals_watch": "Vigilado aquí",
    "set.workspace.approvals_watch.d":
      "Una escritura de un agente sobre cualquiera de estos te pregunta primero, sea del tipo que sea. Separados por comas: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, o un nombre solo.",
    "set.workspace.approvals_critical": "Crítico aquí",
    "set.workspace.approvals_critical.d":
      "Tipos de escritura de agentes que siempre te preguntan en este proyecto. Separados por comas, por ejemplo repo_clone, service_try.",
    "set.agents.approvals_policy": "Escrituras de agentes",
    "set.agents.approvals_policy.d":
      "Lo que un agente puede hacer sin tu Permitir. Ejecutar y avisarme: se ejecuta y tus novedades lo dicen. Una escritura que amplía lo que un agente puede hacer, toca secretos, borra datos o gasta dinero siempre pregunta, igual que una sobre algo que vigilas o fijaste.",
    "set.agents.approvals_policy.o.auto": "Ejecutar sin aviso",
    "set.agents.approvals_policy.o.notify": "Ejecutar y avisarme",
    "set.agents.approvals_policy.o.ask": "Preguntarme",
    "set.agents.approvals_watch": "Vigilado",
    "set.agents.approvals_watch.d":
      "Una escritura de un agente sobre cualquiera de estos te pregunta primero, sea del tipo que sea; también una sobre un repo o servicio que fijaste. Separados por comas: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, o un nombre solo.",
    "set.agents.approvals_critical": "Crítico",
    "set.agents.approvals_critical.d":
      "Tipos de escritura de agentes que siempre te preguntan, en todos los proyectos. Separados por comas, por ejemplo repo_clone, service_try.",
    "set.server.health_poll": "Comprobaciones de salud mientras miras",
    "set.server.health_poll.d":
      "Cada cuánto una página abierta y visible comprueba la salud de cada servicio: de 2 a 300 segundos. __DEN_CLI__ config health_poll.visible_seconds=5",
    "set.server.health_poll_hidden":
      "Comprobaciones de salud en una pestaña oculta",
    "set.server.health_poll_hidden.d":
      "Cada cuánto una página en una pestaña oculta comprueba la salud: de 10 a 3600 segundos. Sin ninguna página a la vista, las comprobaciones se ejecutan como mucho con esa frecuencia. Al volver a la vista, la página comprueba enseguida. __DEN_CLI__ config health_poll.hidden_seconds=60",
    "set.agents.held_wait": "Las solicitudes esperan tu permiso",
    "set.agents.held_wait.d":
      "Cuánto espera tu permiso la solicitud de un agente antes de vencer: de 10 minutos a 7 días (10080). Se queda en la campana todo ese tiempo y sobrevive a un reinicio. Al permitir una antigua, se vuelve a comprobar primero. __DEN_CLI__ config held_writes.wait_minutes=1440",
    "set.agents.issue_writes": "Quién escribe issues de GitHub",
    "set.agents.issue_writes.d":
      "Los roles cuyos agentes pueden crear issues, comentar, poner etiquetas y fijar hitos en los repositorios de GitHub de su propio proyecto, al momento y con registro. Separados por comas; vacío: ninguno. Sin definir: planner, orchestrator, lead, sde, builder, reviewer e install (el agente propio de __DEN_TITLE__). __DEN_CLI__ config agents.issue_writes=[planner,sde]",
    "set.agents.issue_writes_per_hour":
      "Escrituras de issues de GitHub por hora",
    "set.agents.issue_writes_per_hour.d":
      "Cuántas escrituras de issues pueden hacer todos los agentes juntos en una hora. Pasado ese número, al agente se le dice cuánto esperar. __DEN_CLI__ config agents.issue_writes_per_hour=60",
    "ap.do.agent_import":
      'Traer la conversación {session} como agente {persona} del proyecto "{project}"',
    "ap.do.approval_policy":
      "Cambiar la política de aprobación de todos los proyectos a {to}",
    "ap.do.approval_policy.project":
      "Cambiar la política de aprobación del proyecto {where} a {to}",
    "ap.do.pr_close": "Cerrar la pull request {pr} de {repo}: {comment}",
    "set.agents.default_mode":
      "Modo de los agentes: valor por defecto de todo Den",
    "set.agents.default_mode.d":
      "El modo en que trabajan todos los agentes, también el agente de __DEN_TITLE__, salvo que su proyecto lo reemplace. Cuál gana: el propio ajuste de un agente, luego el proyecto, luego el valor por defecto de todo Den, luego su persona. Un cambio llega a los agentes en marcha al terminar su turno, solo.",
    "set.agents.default_mode.o.persona": "El de cada persona",
    "set.agents.default_mode.o.ask": "Preguntar por todo",
    "set.agents.default_mode.o.edits": "Aprobar ediciones",
    "set.agents.default_mode.o.auto": "Modo automático",
    "set.agents.default_mode.o.all": "Aprobar todo",
    "set.editor.open": "Abrir enlaces de archivo en",
    "set.editor_overrides": "IDE por lenguaje",
    "set.terminal": "Terminal predeterminada",
    "set.shell.pages": "Páginas",
    "set.shell.pins": "Fijados",
    "set.shell.collapsed": "Contraer la barra lateral",
    "set.shell.dock": "Abrir el panel de ejecuciones",
    "set.graph.workspaces": "Lista de proyectos",
    "set.graph.groupBy": "Agrupar repositorios por",
    "set.graph.direction": "Dirección",
    "set.graph.group": "Marcos",
    "set.graph.density": "Tarjetas",
    "set.graph.panelWidth": "Panel de detalles",
    "set.workspace.hub": "Proyecto de Hub",
    "hubp.offline": "Esta instalación aún no está conectada a Hub.",
    "hubp.connect": "Conéctala en Ajustes › Hub",
    "hubp.suggested": "Sugeridos por Hub",
    "hubp.others": "Otros proyectos de Hub de tu empresa",
    "hubp.whyRepo": "tiene estos repos",
    "hubp.whyName": "mismo nombre",
    "hubp.link": "Vincular",
    "hubp.unlink": "Desvincular",
    "hubp.none": "Tu empresa aún no tiene proyectos en Hub.",
    "hubp.noOther":
      "Tu empresa no tiene otros proyectos en Hub a los que cambiar.",
    "hubp.failed": "Den no pudo obtener los proyectos de Hub.",
    "hubp.cantSee": "Den Hub no puede ver {repo}.",
    "hubp.giveAccess": "Dar acceso a Den Hub a {org}",
    "hubp.noHub":
      "Esta instalación no está conectada a Hub, así que aún no hay nada que vincular.",
    "hubp.connectBtn": "Conectar con Hub",
    "hubp.sideProject": "Proyecto",
    "hubp.sideHub": "Proyecto en Hub",
    "hubp.byId":
      "Den vincula un proyecto de Hub por su ID oculto, así que cambiar en Hub el nombre del proyecto o su nombre corto no rompe el vínculo.",
    "hubp.linkedWhen": "Vinculado cuando esta instalación se conectó a Hub.",
    "hubp.does":
      "Los documentos, maquetas y comentarios que creen los agentes de {project} van a {hub} en Hub.",
    "hubp.more": "Más",
    "hubp.moreNote":
      "Den lo vinculó al conectarse a Hub. Cámbialo solo si Den eligió el proyecto de Hub equivocado.",
    "hubp.switchL": "Usar otro proyecto de Hub",
    "hubp.switch": "Cambiar",
    "hubp.unlinkDoes":
      "Desvincular lo detiene. Los documentos, maquetas y comentarios nuevos de los agentes de {project} irán a Sin archivar en Hub. Lo que ya está en {hub} se queda allí. El nombre que Den muestra no cambia.",
    "hubp.cliL": "Desde una terminal:",
    "hubp.unlinkAsk": "¿Desvincular {project} del proyecto de Hub {hub}?",
    "hubp.unlinkYes": "Sí, desvincular",
    "hubp.cancel": "Cancelar",
    "hubp.waiting":
      "Den no sabe qué proyecto de Hub corresponde a {project}, así que no se guarda nada de {project} hasta que elijas uno.",
    "hubp.pickBtn": "Elegir un proyecto de Hub",
    "hubp.notLinked":
      "Sin vincular. Los documentos, maquetas y comentarios de los agentes de {project} se guardan en Sin archivar, en Hub.",
    "hubp.linkProject": "Vincular {project} a un proyecto de Hub",
    "hubp.scope":
      "Vincular solo afecta al proyecto {project}. Tus otros proyectos no cambian.",
    // Issue 271: Crear un proyecto de Hub desde el selector.
    "hubp.createOpt": "Crear un proyecto de Hub llamado {name}",
    "hubp.newName": "Nombre en Hub",
    "hubp.create": "Crear",
    "hubp.nameEmpty": "Escribe un nombre para el proyecto de Hub.",
    "hubp.nameLong":
      "El nombre de un proyecto de Hub tiene hasta 80 caracteres.",
    "hubp.asked":
      "Den pidió a Hub crear el proyecto de Hub {name} para {project}.",
    "hubp.youAllow":
      "Eres propietario en Hub. Permítelo allí y Den vincula {project} con él.",
    "hubp.allowBtn": "Permitir en Hub",
    "hubp.ownerMust":
      "Un propietario de {company} en Hub debe permitirlo. Den vincula {project} por sí solo cuando lo haga.",
    "hubp.ownerMustAny":
      "Un propietario de tu empresa en Hub debe permitirlo. Den vincula {project} por sí solo cuando lo haga.",
    "hubp.declined":
      "Un propietario en Hub rechazó el proyecto de Hub {name}. Elige un proyecto de Hub o vuelve a pedirlo.",
    "hubp.ended":
      "La petición a Hub de {name} terminó sin cambios. Vuelve a pedirlo.",
    "hubp.createW": "Pidiendo a Hub que cree {name}…",
    "hubp.createS": "Pedido. Un propietario lo permite en Hub.",
    "hubp.createF": "Hub no aceptó la petición. No se creó nada.",
    "hub.legacy":
      "Esta instalación usa un token antiguo de Hub, guardado donde Den no puede reemplazarlo. Vuelve a conectar para pasar a uno nuevo.",
    "hub.reconnect": "Volver a conectar",
    "hubgh.offline": "Esta instalación aún no está conectada a Hub.",
    "hubgh.failed": "Den no pudo preguntar a Hub por el acceso a GitHub.",
    "hubgh.noOrgs": "Aún no se han enviado repos a Hub.",
    "hubgh.line": "{org}: Den Hub puede leer {what}.",
    "hubgh.all": "todos los repos",
    "hubgh.some": "{n} de {m} repos",
    "hubgh.none": "ningún repo (sin acceso)",
    "hubgh.give": "Dar acceso a Den Hub",
    "hubgh.change": "Cambiar repos",
    "hubgh.error":
      "Den Hub no pudo comprobar {org} en GitHub: {reason}. Inténtalo más tarde.",
    "hubgh.errorNoReason":
      "Den Hub no pudo comprobar {org} en GitHub. Inténtalo más tarde.",
    "hubgh.retry": "Comprobar de nuevo",
    "set.distribution.hub_github": "Acceso de Den Hub a GitHub",
    "set.agents.hub_github": "Acceso de Den Hub a GitHub",
    "hubla.noProjects": "Aún no hay proyectos.",
    "hubla.linked.one": "{n} proyecto vinculado.",
    "hubla.linked": "{n} proyectos vinculados.",
    "hubla.failed": "{n} sin vincular: {names}. Inténtalo de nuevo.",
    "hubla.failedAll": "No se pudo vincular {names}. Inténtalo de nuevo.",
    "set.agents.hub_link_all": "Coincidencias dudosas",
    "set.agents.hub_link_all.d":
      "Vincular une un proyecto con su proyecto de Hub, para que sus agentes guarden allí documentos, maquetas y comentarios. Den lista aquí un proyecto solo cuando no sabe cuál de Hub corresponde. Elige uno y pulsa Vincular. Hasta entonces, no se guarda nada de ese proyecto.",
    "set.agents.hub_delivery_loop": "Ciclo de entrega de Hub",
    "set.agents.hub_delivery_loop.d":
      "Activado, cada agente que Den inicia en un proyecto conectado a Hub recibe el ciclo de entrega en sus instrucciones: documentos de requisitos en Hub, issues enlazados completos, revisión y comentarios en los hilos de Hub, estado desde git. Desactivado para todos los proyectos de aquí, salvo que un proyecto lo active. Llega a un agente en su próximo inicio.",
    "set.workspace.hub_delivery_loop": "Ciclo de entrega de Hub: este proyecto",
    "set.workspace.hub_delivery_loop.d":
      "Si los agentes de este proyecto reciben el ciclo de entrega de Hub en sus instrucciones, por encima del ajuste de la instalación. Llega a un agente en su próximo inicio.",
    "set.workspace.hub_delivery_loop.o.install": "Como en todas partes",
    "set.workspace.hub_delivery_loop.o.on": "Activado",
    "set.workspace.hub_delivery_loop.o.off": "Desactivado",
    "set.workspace.hub_delivery_loop_extra":
      "Añadido al ciclo de entrega de Hub",
    "set.workspace.hub_delivery_loop_extra.d":
      "El texto propio de este proyecto, añadido tras la copia de Den del ciclo en las instrucciones de sus agentes. La copia de Den no se puede editar. Vacío no añade nada.",
    "ub.intro":
      "Den no sabe qué proyecto de Hub corresponde a estos. Elige uno para cada uno y pulsa Vincular.",
    "ub.why.repos": "Dos proyectos de Hub comparten sus repositorios",
    "ub.why.split":
      "Sus repositorios coinciden con un proyecto de Hub; su nombre, con otro",
    "ub.why.names": "Dos proyectos de Hub tienen su nombre",
    "ub.pick": "Elige el proyecto de Hub para {project}",
    "ub.link": "Vincular",
    "ub.waiting": "Aún no se guarda nada de este proyecto.",
    "ub.empty":
      "Todas las coincidencias están claras. Den lista aquí un proyecto solo cuando no sabe qué proyecto de Hub corresponde.",
    "ub.repos": "mismos repositorios",
    "ub.name": "mismo nombre",
    "ub.clear": "{project}: Hub sugiere",
    "set.workspace.editor": "IDE de este proyecto",
    "set.agents.runtimes": "Runtimes",
    "set.agents.layout": "Disposición de la pestaña Agentes",
    "set.cli.local_dev": "Entorno local",
    "set.cli.cli_tabs": "Pestañas de terminal",
    "set.agents.keep_running": "Mantener los agentes al cerrar sesión",
    "set.cli.log_window_lines": "Líneas del panel de registros",
    "set.server.restart": "Reiniciar Den",
    "set.cli.web_port": "Tu puerto web",
    "set.cli.signin": "Inicio de sesión del navegador",
    "set.cli.sudo": "Contraseña de administrador",
    "set.cli.op_token": "Origen del token de 1Password",
    "set.access.owner": "Propietario",
    "set.access.devices": "Dispositivos vinculados",
    "set.access.waiting": "Dispositivos en espera",
    "set.embed.url_max": "Contexto de enlace más largo",
    "set.embed.app_keys": "Claves de aplicación",
    "set.embed.app_key_audit":
      "Lecturas de clave de aplicación en una línea de actividad",
    "set.embed.origins": "Aplicaciones web que pueden incrustar agentes",
    "set.embed.key_minutes": "Duración del permiso del panel incrustado",
    "set.embed.context_max_kb": "Página compartida más grande",
    "set.access.machine_name": "Nombre de la máquina",
    "ident.toast":
      "Este dispositivo tiene la sesión iniciada en {name} en {host}",
    "acct.roleOwner": "Propietario",
    "set.access.approveNeedsBrowser":
      "Para aprobar un dispositivo hace falta un navegador con la sesión iniciada. Vuelve a iniciar sesión en esta página y apruébalo.",
    "set.access.approveNotAgent":
      "Solo una persona aprueba un dispositivo, desde su propio navegador con la sesión iniciada.",
    "set.access.wrongCode":
      "Ese código no coincide con el de la pantalla de ese ordenador. Revísalo y escríbelo de nuevo.",
    "set.access.tooManyTries":
      "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
    "set.access.ended": "Esa solicitud terminó o caducó. No se permitió nada.",
    "set.access.pair": "Emparejar un dispositivo",
    "set.access.pair_requests":
      "Solicitudes nuevas de inicio de sesión por dirección, por minuto",
    "set.access.pair_requests.d":
      "Cuántos dispositivos nuevos puede pedir una dirección por minuto para iniciar sesión. Los demás se rechazan hasta que pase el minuto. __DEN_CLI__ config web.pair_requests_per_minute=30",
    "set.access.approve_attempts": "Códigos incorrectos permitidos al aprobar",
    "set.access.approve_attempts.d":
      "Cuántos códigos incorrectos se aceptan al aprobar un dispositivo en el intervalo de abajo antes de esperar. __DEN_CLI__ config web.approve_attempts=10",
    "set.access.approve_window":
      "Intervalo de códigos incorrectos, en segundos",
    "set.access.approve_window.d":
      "Durante cuánto tiempo se cuentan los códigos incorrectos. Cuando pasa, se puede volver a intentar aprobar. __DEN_CLI__ config web.approve_window_seconds=30",
    "set.access.agent_view": "Los agentes pueden ver las páginas, solo lectura",
    "set.access.agent_view.d":
      "Activado, un agente que funciona aquí puede abrir estas páginas en solo lectura, como él mismo, para mirar o hacer una captura (page_view). No cambia nada, y cada página que abre queda registrada con su nombre. Desactivado, se le dice al agente que las vistas están desactivadas. __DEN_CLI__ config web.agent_view=true",
    "set.access.agent_view_minutes":
      "Duración de la vista de un agente, en minutos",
    "set.access.agent_view_minutes.d":
      "Cuánto dura la vista de solo lectura de un agente; después termina. __DEN_CLI__ config web.agent_view_minutes=10",
    "set.access.test_install": "Instalación de prueba",
    "set.distribution.brand": "Nombre del producto",
    "set.distribution.github_org": "Org de GitHub",
    "set.distribution.orgs": "Etiquetas de org",
    "set.distribution.web_port": "Puerto web",
    "set.distribution.environments": "Entornos",
    "set.distribution.domain": "Dominio de edge",
    "err.retry": "Reintentar",
    "err.copy": "Copiar detalles",
    "err.copied": "Copiado",
    "ag.title": "Agentes",
    "ag.caption": "Agentes en {ws}",
    "ag.count": "{n} agentes",
    "ag.count.one": "{n} agente",
    "ag.col.agent": "Agente",
    "ag.col.runtime": "Motor",
    "ag.col.state": "Estado",
    "ag.col.cwd": "Directorio",
    "ag.col.started": "Inicio",
    "ag.col.actions": "Acciones",
    "ag.listFailed":
      "No se pudieron listar los agentes de este proyecto: {err}",
    "ag.loading": "Cargando agentes…",
    "ag.none": "Aún no hay agentes en este proyecto",
    "ag.personaOf": "persona {persona}",
    "ag.state.running": "en marcha",
    "ag.state.stopping": "deteniéndose…",
    "ag.state.stopped": "detenido",
    "ag.state.ended": "terminado",
    "ag.state.exited": "salió",
    "ag.state.exitedCode": "salió ({code})",
    "ag.stop": "Detener",
    "ag.closeShell": "Cerrar shell",
    "ag.closeShellTip": "Termina este shell y lo que se ejecuta en él",
    "ag.newShell": "Nueva terminal",
    "ag.newShellTip": "Inicia otro shell en la carpeta de este proyecto",
    "ag.shellClosed": "Se cerró {id}",
    "ag.resume": "Reanudar",
    "ag.stopName": "Detener {id}",
    "ag.resumeName": "Reanudar {id}",
    "ag.start": "+ Iniciar agente",
    "ag.persona": "Persona",
    "ag.runtime": "Motor",
    "ag.runtime.auto": "La de la persona",
    "ag.runtime.default": "{name} (la de la persona)",
    "ag.unavailable": "no disponible",
    "ag.go": "Iniciar",
    "ag.cancel": "Cancelar",
    "ag.started": "Agente {id} iniciado",
    "ag.stopped": "Agente {id} detenido",
    "ag.stillStopping": "{id} todavía se está deteniendo",
    "ag.resumedFresh": "{id}: aún no hay nada que reanudar; se inició de nuevo",
    "ag.resumedHandoff":
      "{id}: su conversación nunca se escribió; se inició de nuevo desde su último traspaso",
    "ag.inactive": "El proyecto {ws} no está activo",
    "ag.otherTabs.one": "{n} pestaña de otros proyectos oculta",
    "ag.otherTabs": "{n} pestañas de otros proyectos ocultas",
    "ag.showAllActive": "Mostrar en Todos los activos",
    "ag.switchedTo": "Cambiado a {ws}",
    "ag.backTo": "Volver a {ws}",
    "ag.pickIn": "Elige un agente en {ws}",
    "ag.switchWs": "Cambiar a {ws}",
    "ag.unknownWs": "(ningún proyecto tiene ese nombre)",
    "ag.resumed": "Agente {id} reanudado",
    "ag.state.interrupted": "interrumpido",
    "ag.why.stopped": "Lo detuviste a las {time}",
    "ag.why.interrupted": "Interrumpido: {name} se reinició",
    "ag.why.restartFailed": "No volvió tras un reinicio: {why}",
    "ag.why.trustDeclined":
      "No se inició: esta carpeta no es de confianza. Reanuda y elige Yes.",
    "ag.why.exited": "Salió",
    "ag.why.exitedCode": "Salió (código {code})",
    "ag.fresh": "Empezar de cero",
    "ag.freshName": "Empezar {id} de cero",
    "ag.startedFresh": "{id} empezó de cero",
    "ag.rot.ready": "Listo para relanzar ({why})",
    "ag.rot.due": "Falta el traspaso ({why})",
    "ag.rot.compactions": "{n} compactaciones",
    "ag.rot.compactions.one": "{n} compactación",
    "ag.rot.merged": "PR fusionado",
    "ag.rot.noHandoff":
      "Rotó ({why}), pero no escribió handoff.md. Reanúdalo para que lo escriba, o empieza de cero.",
    "ag.rot.badHandoff":
      "Rotó ({why}), pero su handoff.md no está completo. Reanúdalo para arreglarlo, o empieza de cero.",
    "ag.relaunch": "Relanzar ahora",
    "ag.relaunchName": "Relanzar {id} ahora",
    "ag.relaunched": "{id} relanzado desde su traspaso",
    "ag.relaunchHandoff": "Relanzar desde su último traspaso",
    "ag.rc.autoAsk":
      "Toca rotar ({why}). Den le pide el traspaso cuando esté libre y luego lo relanza.",
    "ag.rc.waiting.one":
      "Toca rotar ({why}). Den espera a que termine {n} tarea en segundo plano que inició y luego lo rota.",
    "ag.rc.waiting":
      "Toca rotar ({why}). Den espera a que terminen las {n} tareas en segundo plano que inició y luego lo rota.",
    "ag.rc.autoReady":
      "Toca rotar ({why}). Su traspaso está listo: Den lo relanza cuando esté libre.",
    "ag.rc.ready": "Toca rotar ({why}). Su traspaso está listo.",
    "ag.rc.missing": "Toca rotar ({why}). Aún no tiene traspaso.",
    "ag.rc.bad": "Toca rotar ({why}). Su traspaso no está completo.",
    "ag.rc.fellBack":
      "Toca rotar ({why}). No escribió el traspaso tras pedírselo 2 veces.",
    "ag.rc.wanted":
      "Toca rotar ({why}). Den lo relanza en cuanto escriba su traspaso.",
    "ag.rc.write": "Escribir traspaso",
    "ag.rc.writeName": "Pedir a {id} que escriba su traspaso",
    "ag.rc.keep": "Mantener esta conversación",
    "ag.rc.keepName": "Mantener la conversación de {id}",
    "ag.rc.never": "No volver a preguntar para este agente",
    "ag.rc.settings": "Ajustes",
    "ag.rc.from":
      "Rota tras {n} compactaciones ({src}); al tocar: {mode} ({src2})",
    "ag.rc.fellBackBad":
      "Toca rotar ({why}). Su traspaso sigue sin pasar la revisión tras pedírselo 2 veces.",
    "ag.rc.from.one":
      "Rota tras {n} compactación ({src}); al tocar: {mode} ({src2})",
    "ag.rc.fromNever": "Nunca rota ({src}); al tocar: {mode} ({src2})",
    "ag.rc.midTurn":
      "{id} está a mitad de turno: pídelo de nuevo cuando termine",
    "ag.rc.neverN": "nunca",
    "ag.rc.mode.auto": "relanzar solo",
    "ag.rc.mode.ask": "preguntar",
    "ag.rc.mode.off": "nada",
    "ag.rc.menu": "Ajustes de rotación",
    "ag.rr.item": "Reanudar tras un reinicio",
    "ag.rr.default": "del perfil",
    "ag.rr.on": "{id} se reanuda solo tras un reinicio",
    "ag.rr.off": "{id} queda detenido tras un reinicio",
    "ag.rc.noState": "Aún no rota: cuenta desde su próximo inicio.",
    "ag.rc.asked": "Se pidió a {id} su traspaso",
    "ag.rc.askedRelaunch":
      "Se pidió a {id} su traspaso. Den lo relanza en cuanto pase la revisión.",
    "ag.rc.askedResumed":
      "{id} reanudado para escribir su traspaso. Den lo relanza en cuanto pase la revisión.",
    "ag.rc.kept": "Conversación de {id} mantenida: su cuenta vuelve a empezar",
    "ag.rc.keptNever": "Conversación de {id} mantenida: ya no rotará",
    "ag.rc.autoRelaunched":
      "{id} relanzado desde su traspaso tras {why}. La conversación anterior {old} se conserva.",
    "ag.remove": "Quitar",
    "ag.removed": "{id} quitado",
    "ag.removeShell": "Quitar {id}",
    "ag.clearedMany": "{n} quitados de Detenidos",
    "ag.clearedMany.one": "{n} quitado de Detenidos",
    "ag.removedMany": "{n} agentes detenidos quitados",
    "ag.removedMany.one": "{n} agente detenido quitado",
    "ag.undo": "Deshacer",
    "ag.restored": "De vuelta en la lista: {ids}",
    "ag.clear": "Quitar detenidos",
    "ag.noResume": "{runtime} no puede reanudar una conversación",
    "ag.interrupted": "{n} agentes se interrumpieron al reiniciarse {name}",
    "ag.interrupted.one": "{n} agente se interrumpió al reiniciarse {name}",
    "ag.resumeAll": "Reanudar todos",
    "ag.review": "Revisar",
    "ag.resumedAll": "{n} agentes reanudados",
    "ag.resumedAll.one": "{n} agente reanudado",
    "pe.configFirst":
      "Corrige primero la configuración: las personas se leen de ella.",
    "ag.new.title": "Iniciar un agente",
    "rt.missingLine": "No encontrados en esta máquina:",
    "rt.install": "Instalar…",
    // The Start dialog and personas (AG-10 to AG-13).
    "ag.new.what": "¿Qué es una persona?",
    "ag.new.details": "Detalles: {n}",
    "ag.new.hide": "Ocultar detalles",
    "ag.new.newP": "+ Nueva persona",
    "ag.new.plain": "Shell simple",
    "ag.new.plainP": "Una terminal en la carpeta del proyecto. Sin agente.",
    "ag.new.task": "Primera instrucción (opcional)",
    "ag.new.name": "Nombre (opcional)",
    "ag.new.as": "Se inicia como {id}",
    "ag.new.openRunning": "Abrir el que está en ejecución",
    "ag.new.isRunning": "{id} ya está en ejecución",
    "ag.new.openIt": "Abrirlo",
    "ag.new.isStopped": "{id} está detenido",
    "ag.new.resumeIt": "Reanudarlo",
    "ag.new.orNext": "o Iniciar crea {id}",
    "ag.new.taskPh":
      "p. ej., Toma la historia del estado vacío. Sigue el diseño y añade una prueba.",
    "ag.new.adv": "Avanzado: modelo y permisos",
    "ag.new.advNote":
      "Los valores predeterminados vienen de la persona. Los cambios aquí solo afectan a este agente, y el agente queda marcado en la lista.",
    "ag.new.model": "Modelo",
    "ag.new.modelDef": "Predeterminado de la persona ({m})",
    "ag.new.ver": "Versión",
    "ag.new.verDef": "Predeterminado de la persona ({v})",
    // AG-17.1, Bring in.
    "ag.bring": "Traer",
    "ag.bring.title": "Traer una conversación",
    "ag.bring.conv": "Conversación",
    "ag.bring.help":
      "Conversaciones iniciadas fuera de Den en la carpeta de este proyecto o en las de sus repositorios, la más reciente primero.",
    "ag.bring.none":
      "No hay conversaciones iniciadas fuera de Den en la carpeta de este proyecto ni en las de sus repositorios.",
    "ag.bring.untitled": "Conversación sin título",
    "ag.bring.outside": "Iniciadas fuera de cualquier proyecto",
    "ag.bring.outsideHelp":
      "Se ejecutaron en una carpeta fuera de todos los proyectos, por ejemplo tu carpeta personal. Si traes una, se ejecuta allí, en la carpeta que aparece debajo, como agente de este proyecto.",
    "ag.outside": "iniciado en {folder} (fuera del proyecto)",
    "ag.bring.open": "Abierta en otro lugar",
    "ag.bring.openTip": "Sigue abierta en otra terminal. Ciérrala allí primero",
    "ag.bring.agent": "Agente {id}",
    "ag.bring.note":
      "La continúa en la carpeta donde se ejecutó, con las herramientas y protecciones de Den desde ahora. Sigue en ejecución si cierras el panel. Ciérrala antes en cualquier otro terminal: Den solo la ve abierta si se escribió en el último minuto.",
    "ag.keep.model": "Mantiene {m} de la conversación.",
    "ag.keep.modelNew": "Usa {m} a partir de ahora.",
    "ag.keep.from":
      "A partir de ahora trabaja como {p}: su rol, sus permisos ({mode}), las herramientas y protecciones de Den. Su historial se mantiene.",
    "ag.keep.lost":
      "No tendrá: {s}. Den ejecuta los agentes solo con las herramientas de Den.",
    "ag.keep.opt": "Mantener {m}",
    "ag.keep.optNone": "Mantener el modelo que usa",
    "ag.keep.advNote":
      "El modelo que usa se mantiene salvo que elijas otro aquí. Los permisos vienen de la persona.",
    "ag.pc.item": "Cambiar persona…",
    "ag.pc.title": "Cambiar la persona de {id}",
    "ag.pc.note":
      "Den lo detiene y reanuda la misma conversación con la nueva persona. Su id, nombre, carpeta y pestaña se mantienen.",
    "ag.pc.go": "Cambiar persona",
    "ag.pc.current": "actual",
    "ag.pc.busy":
      "Está trabajando. ¿Cambiar después de este turno o detenerlo ahora?",
    "ag.pc.after": "Después de este turno",
    "ag.pc.now": "Detenerlo ahora",
    "ag.pc.fresh":
      "{id} ahora es {p}: aún no hay nada que reanudar; se inició de nuevo (mismo id de conversación, carpeta y alcance)",
    "ag.freshLine":
      "Aún no hay nada que reanudar; se inició de nuevo (mismo id de conversación, carpeta y alcance)",
    "ag.pc.done": "{id} ahora es {p}",
    "ag.pc.pending": "{id} pasará a ser {p} cuando termine este turno",
    "ag.more": "Más para {id}",
    "ag.chip.stopped": "Detenido",
    "ag.chip.exited": "Terminado",
    "ag.chip.interrupted": "Interrumpido",
    "agc.label": "Mensaje para {name}",
    "agc.hint": "No se envía nada hasta que pulses Enviar.",
    "agc.send": "Enviar",
    "agc.close": "Cerrar",
    "agc.empty": "Escribe primero un mensaje.",
    "agc.sending": "Enviando…",
    "agc.sent": "Enviado a {name}.",
    "agc.failed": "No se envió: {e}",
    "agc.stopped":
      "{name} está detenido. Reanúdalo y vuelve a abrir el enlace.",
    "emb.open": "Abrir en __DEN_TITLE__",
    "emb.waiting": "Esperando a la página que rodea este panel.",
    "emb.signin": "Iniciar sesión en __DEN_TITLE__",
    "emb.signinWhy":
      "Inicia sesión en __DEN_TITLE__ para usar este agente aquí.",
    "emb.connecting": "Conectando…",
    "emb.failed": "Algo salió mal: {e}",
    "emb.notFramed":
      "Este panel va dentro de la página de otra aplicación web. Abre el agente en __DEN_TITLE__.",
    "emc.title": "Permitir una aplicación web",
    "emc.how":
      "Puede poner una página en el cuadro de mensaje del agente. No se envía nada hasta que pulses Enviar allí. El permiso dura poco tiempo.",
    "emc.what":
      "¿Permitir que {origin} use el agente {agent} del proyecto {project}?",
    "emc.allow": "Permitir",
    "emc.cancel": "Cancelar",
    "emc.noOpener":
      "Abre esto desde el panel del agente dentro de la otra aplicación web.",
    "emc.done": "Permitido. Esta ventana se cierra ahora.",
    "agc.shared": "Páginas compartidas con este mensaje",
    "agc.removeShared": "Quitar {title}",
    "emb.tooLarge":
      "Esta página ocupa {size} KB, más que el límite de {max} KB, así que no se añadió. Ajustes › Incrustación fija el límite.",
    "emb.badShared":
      "Una página compartida debe ser texto: una dirección, un título y texto o HTML.",
    "emb.badUrl": "Una página compartida necesita una dirección http o https.",
    "ag.link.none":
      "No hay ningún agente {id} aquí. Puede que se haya quitado.",
    "ag.apiOnly": "Solo API: {names}",
    "ag.apiOnlyTip":
      "Este agente llega a {names} solo por su API. Den bloquea docker exec en él, sus volúmenes y sus datos, y registra cada intento. Es una barandilla, no una barrera de seguridad.",
    "ag.apiOnlyOff": "Solo API sin aplicar",
    "ag.apiOnlyOffTip":
      "Este runtime no tiene un hook que Den pueda usar, así que no se le limita a la API de {names}. Usa den-claude para los agentes que deban estarlo.",
    "ag.mcp.adds": "Las herramientas de Hub llegan al reiniciar",
    "ag.mcp.reloading": "Reiniciando para cargar las herramientas de Hub",
    "ag.mcp.reloadingTip":
      "Las herramientas de Hub cambiaron. Den reinicia este agente cuando esté inactivo para que pueda usarlas. Mantiene su conversación.",
    "ag.mcp.addsTip":
      "Hub se conectó después de que este agente empezó, así que aún no tiene las herramientas de Hub. Reiniciar mantiene su conversación y espera a que termine su turno.",
    "ag.mcp.drops": "Las herramientas de Hub se van al reiniciar",
    "ag.mcp.dropsTip":
      "Hub se desconectó después de que este agente empezó; sus herramientas de Hub ya no funcionan. Reiniciar mantiene su conversación y espera a que termine su turno.",
    "ag.mcp.failed": "Las herramientas de Hub no cargaron",
    "ag.mcp.failedTip":
      "Este agente no pudo cargar al iniciar las herramientas de Hub ({error}), así que no se le puede contactar por Hub. Reiniciar conserva su conversación y espera a que termine su turno.",
    "ag.mcp.restart": "Reiniciar",
    "ag.mcp.restartName": "Reiniciar {id} cuando quede libre",
    "ag.mcp.restarting":
      "{id} se reinicia cuando quede libre, en la misma conversación.",
    "ag.det.label": "Detalles de {id}",
    "ag.det.close": "Cerrar",
    "ag.det.where": "Dónde",
    "ag.det.ended": "Cómo terminó",
    "ag.det.lastLine": "Su última línea",
    "ag.det.lastAsk": "Última petición",
    "ag.det.noAsk": "Aún no se le pidió nada",
    "ag.det.reading": "Leyendo…",
    "ag.det.compactions": "{n} compactaciones en esta conversación",
    "ag.det.output": "Ver su salida",
    "ag.det.handoffDue": "Traspaso pendiente ({why})",
    "ag.stoppedGroup": "Detenidos ({n})",
    "ag.stoppedGroupTip":
      "Agentes que no están en marcha. Abre uno para ver sus detalles.",
    "ag.bring.go": "Traer",
    "ag.bring.done": "Traída como {id}",
    "ag.bring.now": "ahora mismo",
    "ag.bring.min": "hace {n} min",
    "ag.bring.h": "hace {n} h",
    "ap.title": "{agent} quiere:",
    "ap.agent": "El agente {name}",
    "ap.noAgent": "Algo en esta máquina (sin identidad de agente)",
    "ap.noAgentWarn": "Si no le pediste esto a un agente, deniégalo.",
    "ap.signin.title": "Algo espera tu aprobación.",
    "ap.signin": "Inicia sesión en este navegador para verlo y aprobarlo.",
    "ap.signin.btn": "Iniciar sesión",
    "pair.title": "¿Permitir este equipo?",
    "pair.what": "{device} {client} quiere iniciar sesión en Den.",
    "pair.aDevice": "Un navegador",
    "pair.local": "en este ordenador, por localhost",
    "pair.help":
      "Escribe el código que se muestra en la pantalla de ese ordenador. Permite solo un ordenador en el que estés iniciando sesión tú.",
    "pair.allow": "Permitir",
    "pair.allowed": "Ese equipo ya inició sesión.",
    "pair.ended":
      "Esa solicitud terminó: ese ordenador cerró su página o ya inició sesión. No se permitió nada.",
    "pair.expired": "Ese código caducó. No se permitió nada.",
    "pair.close": "Cerrar",
    "pair.codeLabel": "Código en la pantalla de ese ordenador",
    "pair.age": "Lo pidió hace {n} min.",
    "pair.ageNow": "Lo pidió ahora mismo.",
    "pair.fromLogin": "Del web login ejecutado a las {time}.",
    "pair.wrong":
      "Ese código no coincide con el de la pantalla de ese ordenador. Revísalo y escríbelo de nuevo.",
    "pair.busy": "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
    "ap.do.workspace_create": 'Crear el proyecto "{name}"',
    "ap.do.repo_add":
      'Añadir el repositorio de {path} al proyecto "{workspace}"',
    "ap.do.repo_add.new":
      'Añadir el repositorio de {path} a un proyecto nuevo "{workspace}"',
    "ap.do.service_try": "Iniciar {service}",
    "ap.do.den_restart": "Reiniciar Den ({reason})",
    "ap.do.den_update": "Actualizar Den a {version} ({reason})",
    "ap.do.hub_connect": "Poner la dirección de Hub en {url}",
    "ap.do.hub_connect.clear": "Borrar la dirección de Hub",
    "ap.do.persona_create": "Añadir la persona {name} ({id})",
    "ap.do.persona_update": "Cambiar la persona {id}: {fields}",
    "ap.do.persona_create.project":
      "Añadir la persona {name} ({id}) al proyecto {where}",
    "ap.do.persona_update.project":
      "Cambiar la persona {id} en el proyecto {where}: {fields}",
    "ap.do.den_pin_commit":
      "Confirmar la versión fijada de la distribución en Den {version}",
    "ap.do.repo_clone": "Clonar {source} en {path}",
    "ap.do.project_mode":
      "Cambiar el modo del proyecto {project}: {from} → {to}",
    "ap.do.agent_folder": "Mover el agente {agent} a {where}",
    "ap.do.embed_key_create":
      "Permitir que {origin} envíe mensajes a {agent} en {project} y lea su estado",
    "ap.do.embed_key_revoke":
      "Revocar la clave de {origin} para {agent} en {project}",
    "ap.det.embed_key_create.reach":
      "Crea una clave para el backend propio de {origin}. Solo llega a {agent} en {project}: su estado y los mensajes que se escriben cuando termina su turno.",
    "ap.det.embed_key_create.once":
      "La clave se muestra una vez, aquí, después de que lo permitas. Den guarda solo su hash.",
    "ap.det.embed_key_create.revoke":
      "Puedes revocarla cuando quieras en Ajustes › Incrustación.",
    "ap.do.gate_runner_token_create":
      "Crear un token solo para turnos de pruebas para el runner de CI {name}",
    "ap.det.gate_runner_token_create.reach":
      "Crea un token para el runner de CI {name}. Solo puede pedir, renovar y devolver turnos de pruebas en esta máquina: nada más en Den.",
    "ap.det.gate_runner_token_create.onceAgent":
      "El token va una vez a {agent}, el agente que lo pidió, y no se vuelve a mostrar. Den guarda solo su hash.",
    "ap.det.gate_runner_token_create.once":
      "El token va una vez a quien lo pidió, y no se vuelve a mostrar. Den guarda solo su hash.",
    "ap.det.gate_runner_token_create.revoke":
      "Puedes revocarlo cuando quieras en Ajustes, en Tokens de runners de CI.",
    "ap.do.gate_box_set": "Reemplazar la máquina de pruebas {name}",
    "ap.do.gate_box_set.new": "Añadir la máquina de pruebas {name}",
    "ap.do.gate_box_remove": "Quitar la máquina de pruebas {name}",
    "ap.det.gate_box_set.adds":
      "Añade la máquina de pruebas {name}. Sus turnos de navegador reciben ejecuciones de pruebas de los agentes.",
    "ap.det.gate_box_set.replaces":
      "Reemplaza la máquina de pruebas {name} con estos ajustes. Sus turnos de navegador reciben ejecuciones de pruebas de los agentes.",
    "ap.det.gate_box_set.ssh": "SSH: {v}",
    "ap.det.gate_box_set.ssh_port": "Puerto SSH: {v}",
    "ap.det.gate_box_set.ssh_identity": "Archivo de clave SSH: {v}",
    "ap.det.gate_box_set.playwright": "Dirección de Playwright: {v}",
    "ap.det.gate_box_set.slots": "Turnos de navegador: {v}",
    "ap.det.gate_box_set.hold_file": "Archivo de pausa: {v}",
    "ap.det.gate_box_set.time_scale": "Escala de tiempo: {v}",
    "ap.det.gate_box_set.playwright_version": "Versión de Playwright: {v}",
    "ap.det.gate_box_set.min_free_mem_mb": "Memoria libre mínima (MB): {v}",
    "ap.det.gate_box_set.playwright_endpoints": "Playwright por versión: {v}",
    "ap.det.gate_box_remove.what":
      "Quita la máquina de pruebas {name}. Las ejecuciones en curso terminan; no va ninguna nueva.",
    "ap.do.agent_signing_key_create":
      "Crear la clave de firma de los agentes ({path})",
    "ap.det.agent_signing_key_create.make":
      "Crea una clave SSH ed25519 sin frase de contraseña en {path}. Den y sus agentes firman con ella; no está oculta a otros programas que se ejecutan con el mismo login.",
    "ap.det.agent_signing_key_create.set":
      "Pone agents.git.signing_key en config/local/user.yml: los commits de los agentes y los de la versión fijada de Den se firman con ella.",
    "ap.det.agent_signing_key_create.github":
      "Después añade su clave pública en GitHub como clave de firma, para que GitHub muestre esos commits como verificados.",
    "ap.do.host_restart":
      "Reiniciar el host de terminales cuando los agentes estén libres",
    "ap.det.host_restart.wait":
      "Espera a que ningún agente esté a mitad de turno (como máximo {min} min) y reinicia el host de terminales con el Den instalado.",
    "ap.det.host_restart.resume":
      "Los agentes que ejecutaba continúan donde estaban; los terminales abiertos se cierran. El registro de actividad dice cómo fue.",
    "ap.do.report": "Enviar un reporte a {repo}: {title}",
    "ap.det.report.to": "Va a: {repo}",
    "ap.det.report.pub":
      "Repositorio público: el texto lo puede ver cualquiera; la captura no se publica allí. Antes se quitan secretos, tokens, correos, direcciones IP y referencias a almacenes.",
    "ap.det.report.priv":
      "Repositorio privado: solo lo ven las personas con acceso a este repositorio.",
    "ap.det.report.int":
      "Repositorio interno: solo lo ven las personas con acceso a este repositorio.",
    "ap.det.report.unk":
      "Visibilidad desconocida: no se sabe quién puede ver este repositorio, así que se trata como público. El texto puede ser visible para cualquiera; la captura no se publica allí.",
    "ap.det.report.title": "Título: {title}",
    "ap.det.report.addTo": "Se añade como comentario al issue {n}.",
    "ap.det.report.as":
      "Se publica en GitHub a tu nombre (con tu gh). Lo que se publicará:",
    "ap.det.report.shot":
      "Con una captura que tomó el agente. No se enmascara: solo se limpia el texto de arriba.",
    "ap.det.embed_key_revoke.reach":
      "{origin} ya no puede enviar mensajes a {agent} ni leer su estado con esta clave.",
    "ap.det.embed_key_revoke.held":
      "Los mensajes que envió y que esperan el turno del agente se escriben igualmente.",
    "ap.det.workspace_create.new":
      'Un proyecto nuevo y vacío llamado "{name}", activado para que sus servicios puedan arrancar.',
    "ap.det.service_try.activates":
      'Primero activa el proyecto "{project}", para que pueda funcionar.',
    "ap.det.service_try.up":
      'Ejecuta el "up" local del servicio, como hace Iniciar en la página Servicios.',
    "ap.det.service_try.reports":
      "Den informa del código de salida y de las últimas líneas de su salida.",
    "ap.det.den_restart.restart":
      "Den se detiene y vuelve a arrancar en la misma dirección, con la versión instalada ahora.",
    "ap.det.den.carryOn":
      "Los agentes y las terminales siguen donde estaban; las páginas abiertas se vuelven a conectar.",
    "ap.det.den_restart.told":
      "Al agente que lo pidió se le avisa cuando Den vuelve.",
    "ap.det.den_update.latest":
      "Den obtiene de npm la última versión para esta distribución, la comprueba con doctor y arranca con ella.",
    "ap.det.den_update.version":
      "Den obtiene de npm la versión {version} para esta distribución, la comprueba con doctor y arranca con ella.",
    "ap.det.den_update.rollback":
      "Si la nueva versión no está lista a tiempo, Den vuelve por sí solo a la versión que usa ahora y dice por qué.",
    "ap.det.repo_clone.fromBranch": "Desde: {source}, rama {branch}.",
    "ap.det.repo_clone.from": "Desde: {source}, su rama predeterminada.",
    "ap.det.repo_clone.gh":
      "Con tu gh, ya conectado a GitHub (un repositorio de GitHub).",
    "ap.det.repo_clone.git":
      "Con git y tus propias credenciales (no gh: no es GitHub).",
    "ap.det.repo_clone.into":
      "En: {path} (una carpeta nueva; nada de lo que ya hay cambia).",
    "ap.det.repo_clone.then":
      "Después el agente redacta su manifiesto (manifest_draft) y pide añadirlo (repo_add): cada paso te lo vuelve a preguntar.",
    "ap.det.agent_import.what": "Proyecto: {project}. Persona: {persona}.",
    "ap.det.agent_import.whatRuntime":
      "Proyecto: {project}. Persona: {persona}. Motor: {runtime}.",
    "ap.det.agent_import.goesOn":
      "La conversación sigue como un agente de Den, en la carpeta donde se ejecutaba, con el token, los hooks y las protecciones de Den.",
    "ap.det.agent_import.refused":
      "Se rechaza si sigue abierta en otra terminal, o si un agente ya la continúa.",
    "ap.det.approval_policy.now": "Ahora: {v}.",
    "ap.det.approval_policy.nowNone": "Ahora: ninguna.",
    "ap.det.approval_policy.then": "Después: {v}.",
    "ap.det.approval_policy.thenNone": "Después: ninguna.",
    "ap.det.approval_policy.person":
      "Solo una persona cambia la política de aprobación sin un Permitir: un agente siempre pregunta.",
    "ap.det.pr_close.what": "Repositorio: {repo}. Pull request: {pr}.",
    "ap.det.pr_close.comment": "Den la cierra con este comentario: {comment}",
    "ap.det.pr_close.nothing": "No se fusiona nada y no se borra ninguna rama.",
    "ap.det.hub_connect.set": "Dirección de Hub: {was} → {url}.",
    "ap.det.hub_connect.setNew": "Dirección de Hub: ninguna → {url}.",
    "ap.det.hub_connect.clear":
      "Se borra la dirección de Hub {was}; este Den deja de usar Hub.",
    "ap.det.hub_connect.leave":
      "Den primero se desconecta del Hub que usa ahora, para que ese Hub revoque su clave.",
    "ap.det.hub_connect.restart":
      "Después Den se reinicia, y los agentes obtienen las herramientas de Hub cuando se reinicien.",
    "ap.det.hub_connect.connect":
      "Después te conectas en Ajustes › Hub: Conectar te inicia sesión en Hub allí.",
    "ap.det.den_pin_commit.pr":
      "Den hace commit de package.json y package-lock.json en la rama den/pin-{version} y abre una pull request.",
    "ap.det.den_pin_commit.push":
      "Den hace commit de package.json y package-lock.json y los sube a la rama remota de la rama.",
    "ap.det.den_pin_commit.only":
      "No se hace commit de nada más en la carpeta de la distribución.",
    "ap.det.persona.local":
      "Archivo: las personas propias de esta máquina (no se comparten con el proyecto)",
    "ap.det.persona.newFile":
      "Archivo: {file} (nuevo; haz commit para que los otros Den del proyecto lo tengan)",
    "ap.det.persona.changedFile":
      "Archivo: {file} (cambiado; haz commit para que los otros Den del proyecto lo tengan)",
    "ap.det.persona.name": "Nombre: {v}",
    "ap.det.persona.role": "Rol: {v}",
    "ap.det.persona.category": "Categoría: {v}",
    "ap.det.persona.description": "Descripción: {v}",
    "ap.det.persona.runtime": "Motor: {v}",
    "ap.det.persona.runtimeModel": "Motor: {v}, modelo {model} ({version})",
    "ap.det.persona.mode": "Modo: {v}",
    "ap.det.persona.commands": "Comandos permitidos: {v}",
    "ap.det.persona.commandsNone": "Comandos permitidos: ninguno",
    "ap.det.persona.instructions": "Instrucciones:",
    "ap.det.asWritten": "{v}",
    "ap.det.persona.field": "{field}: {v}",
    "ap.det.persona.fieldNone": "{field}: ninguno",
    "ap.det.persona.asItWillRead": "Así quedará:",
    "ap.det.agent_create.persona": "Persona: {v}",
    "ap.det.agent_create.project": "Proyecto: {v}",
    "ap.det.agent_create.folder": "Carpeta: {v}",
    "ap.det.agent_create.runtime": "Motor: {v}",
    "ap.det.agent_create.mode": "Modo: {mode} (el del proyecto: {cap})",
    "ap.det.agent.who": "Agente: {agent}, proyecto {project}",
    "ap.det.agent.whoId": "Agente: {agent} ({id}), proyecto {project}",
    "ap.det.agent_folder.from": "Desde: {v}",
    "ap.det.agent_folder.to": "A: {v}",
    "ap.det.agent_folder.running":
      "Está en marcha: Den lo detiene, lo mueve y lo arranca de nuevo allí (una conversación nueva; la anterior queda en su historial).",
    "ap.det.agent_folder.stopped":
      "Está detenido y sigue así: su próximo arranque es una conversación nueva allí.",
    "ap.det.agent_folder.self":
      "Es el agente que lo pidió: se detiene cuando lo permites, y su respuesta para ti termina ahí.",
    "ap.det.agent_mode.loosens": "Esto deja que {agent} actúe sin preguntarte.",
    "ap.det.agent_mode.now": "Ahora: su propio modo, {mode}",
    "ap.det.agent_mode.then": "Después: sigue al proyecto, {mode}",
    "ap.det.agent_mode.running":
      "Está en marcha: Den lo reinicia después de su turno, en la misma conversación, en {mode}.",
    "ap.det.agent_mode.stopped":
      "Está detenido: su próximo arranque es en {mode}.",
    "ap.do.agent_mode": "{agent}: {from} → seguir el proyecto ({to})",
    "ap.do.agent_mode.loosens":
      "Esto permite que {agent} actúe sin preguntarte: {from} → seguir el proyecto ({to})",
    "ap.pm.warn":
      "Esto permite que los agentes de {project} actúen sin preguntarte.",
    "ap.pm.project": "Proyecto: {project}",
    "ap.do.hub_project_create":
      "Pedir a Hub que cree el proyecto de Hub {name} para el proyecto {project}",
    "ap.hc.project": "Proyecto: {project}",
    "ap.hc.name": "Nombre en Hub: {name}",
    "ap.hc.owner":
      "Un propietario en Hub lo permite allí; Den vincula el proyecto en cuanto lo haga.",
    "ap.do.hub_link": "Vincular el proyecto {project} al proyecto de Hub {hub}",
    "ap.hl.project": "Proyecto: {project}",
    "ap.hl.now": "Ahora: {hub}",
    "ap.hl.nowNone": "Ahora: sin vincular a un proyecto de Hub",
    "ap.hl.then": "Después: {hub}",
    "ap.hl.filed":
      "El trabajo de sus agentes en Hub se archiva allí desde su próxima llamada.",
    "ap.pm.now": "Ahora: {mode}",
    "ap.pm.then": "Después: {mode}",
    "ap.pm.thenNone":
      "Después: ninguno (los agentes empiezan en el modo de la instalación, si no en el de su persona)",
    "ap.pm.switch":
      "Los agentes nuevos empiezan en él; los que están en marcha cambian tras su turno actual, en la misma conversación.",
    "ap.pm.own":
      "Estos conservan su propio modo y no seguirán el proyecto: {list}",
    "ap.pm.follow": "Y hace que sigan el proyecto: se borra su propio modo.",
    // Issue 208: a Verify run's Allow (verify-routes.ts).
    "ap.do.verify_run":
      "Ejecutar comprobaciones en {env} en el proyecto {project}: {list}",
    "ap.vr.scope.changed":
      "Alcance: lo que cambió (smoke y las comprobaciones cuyos archivos cambiaron desde su último resultado).",
    "ap.vr.scope.all": "Alcance: todo en este entorno.",
    "ap.vr.scope.chosen": "Alcance: las comprobaciones elegidas por nombre.",
    "ap.vr.mod.enforced": "{module} ({kind}): garantizado",
    "ap.vr.mod.declared-read-only":
      "{module} ({kind}): declarado de solo lectura",
    "ap.vr.mod.reads-code-only": "{module} ({kind}): solo lee código",
    "ap.vr.mod.declared-by-service":
      "{module} ({kind}): declarado por el servicio",
    "ap.vr.cant.environment":
      "{module} no puede correr aquí: solo corre en {envs}.",
    "ap.vr.cant.production":
      "{module} aún no puede correr en producción: activarlo para producción llega en un Den posterior.",
    "ap.vr.cant.production-declared":
      "{module} queda fuera de una corrida programada en producción: Den no puede mantener un comando en solo lectura, así que allí solo corren las pruebas de humo y los análisis del código.",
    "ap.vr.cant.adapter-later":
      "{module} aún no puede correr: su adaptador ({adapter}) llega en un Den posterior.",
    "ap.vr.cant.no-health-url":
      "{module} no puede correr aquí: no hay URL de salud para {env}.",
    "ap.vr.once":
      "Este permiso vale solo para esta ejecución. Nada corre hasta que lo permitas.",
    "ap.own.h":
      "Estos agentes conservan su propio modo y no seguirán el proyecto:",
    "ap.own.item": "{agent} (modo propio: {mode})",
    "ap.own.follow": "Hacer también que estos sigan el proyecto",
    "ap.res.following": "Siguen el proyecto ahora: {list}.",
    "ap.res.own": "Conservan su propio modo: {list}.",
    "ap.do.project_mode.loosens":
      "Esto permite que los agentes de {project} actúen sin preguntarte. Cambiar el modo del proyecto {project}: {from} → {to}",
    "ap.do.agent_create":
      "Iniciar el agente {name} ({persona}) en {where}, modo {mode}",
    "ap.do.service_try.activates":
      "Iniciar {service} (esto activa el proyecto {workspace})",
    "ap.says": "El agente dice:",
    "ap.review": "Revisar",
    "ap.hide": "Ocultar detalles",
    "ap.later": "Más tarde",
    "ap.deny": "Denegar",
    "ap.allow": "Permitir",
    "ap.waits": "Nada cambia hasta que lo permitas. Espera hasta las {time}.",
    "ap.more": "{n} más en espera",
    "ap.failed": "Se ejecutó y falló: {error}",
    "ap.done": "Hecho: {what}",
    "ag.new.note":
      "Se inicia en la carpeta del proyecto. Sigue en ejecución si cierras el panel.",
    "ag.new.started": "{p} iniciado en {w}",
    "pm.ask": "Preguntar por todo",
    "pm.edits": "Aprobar ediciones en el árbol de trabajo",
    "pm.auto": "Modo automático",
    "pm.all": "Aprobar todo",
    "pm.tag.ask": "pregunta por todo",
    "pm.tag.edits": "aprueba ediciones",
    "pm.tag.auto": "modo automático",
    "pm.tag.all": "aprueba todo",
    "pm.name.ask": "Preguntar",
    "pm.name.edits": "Ediciones",
    "pm.name.auto": "Auto",
    "pm.name.all": "Todo",
    "ag.mode.tag": "modo: {m}",
    "ag.mode.own": "modo: {m}, de su propio ajuste",
    "ag.mode.ownNot": "modo: {m}, de su propio ajuste (proyecto: {p})",
    "ag.mode.drift":
      "Fijado en {want}. Funciona en {running} hasta que se reinicie.",
    "ag.mode.apply": "Reiniciar para aplicar",
    "ag.mode.applyName": "Reiniciar {id} ahora para que funcione en su modo",
    "ag.mode.applied": "{id} se reinicia en la misma conversación, en {m}.",
    "ag.mode.from": "modo: {m}, de {src}",
    "ag.mode.src.own": "su propio ajuste",
    "ag.mode.src.project": "el proyecto",
    "ag.mode.src.install": "el valor por defecto de todo Den",
    "ag.mode.src.persona": "su persona",
    "ag.mode.src.default": "el valor integrado de Den",
    "ag.mode.item": "Modo: {m}",
    "ag.mode.menu": "Modo de {id}",
    "ag.mode.pick": "Cambiar el modo de {id}",
    "ag.mode.follow": "Seguir el proyecto",
    "ag.mode.setS":
      "{id}: {m}, su propio ajuste. Den lo reinicia en su próxima pausa para aplicarlo.",
    "ag.mode.setStopped":
      "{id}: {m}, su propio ajuste. Lo aplica en su próximo inicio.",
    "ag.mode.followS":
      "{id} sigue el proyecto ahora: {m}. Den lo reinicia en su próxima pausa para aplicarlo.",
    "ag.mode.followStopped":
      "{id} sigue el proyecto ahora: {m}. Lo aplica en su próximo inicio.",
    "set.workspace.agents_mode":
      "Modo de los agentes: este proyecto (reemplaza el valor por defecto de todo Den)",
    "set.workspace.agents_mode.d":
      "El modo en que funcionan los agentes de este proyecto, por encima del valor por defecto de todo Den. Cuál gana: el propio ajuste de un agente, luego el proyecto, luego el valor por defecto de todo Den, luego su persona. Cada agente dice abajo su modo y de dónde viene. Un cambio llega a los agentes en marcha después de su turno, solo.",
    "set.workspace.mcp_servers":
      "MCP adicionales de los agentes: este proyecto",
    "set.workspace.mcp_servers.d":
      "MCP por HTTP que reciben los agentes de este proyecto, además de los de Den y Hub, por nombre y dirección. El bearer se lee del almacén de secretos de la instalación en cada llamada y nunca se muestra. Cambia o quita uno aquí. Un agente lo pide con project_mcp_add, project_mcp_update o project_mcp_remove, y tú lo permites.",
    "pmcp.none": "No hay MCP adicionales para los agentes de este proyecto.",
    "set.workspace.event_feeds": "Flujos de eventos de apps: este proyecto",
    "set.workspace.event_feeds.d":
      "Eventos que una app de este proyecto envía en su propio flujo, para un agente. Den escribe al agente una línea corta cuando hay sin leer, cuando está libre, nunca a mitad de turno; el agente los lee con app_feed_read. Cada flujo dice si está conectado y cuándo llegó su último evento. Añade uno en agents.event_feeds; el bearer es un nombre de secrets.refs.",
    "set.embed.feed_max_streams": "Flujos de apps leídos a la vez",
    "set.embed.feed_max_streams.d":
      "El máximo de flujos de eventos de apps que Den lee a la vez, en todos los proyectos. Por encima, un flujo no se lee y las notificaciones de su proyecto lo dicen.",
    "set.embed.feed_event_max_kb": "Evento de flujo más grande",
    "set.embed.feed_event_max_kb.d":
      "El evento más grande que un flujo de app guarda para su agente. Uno mayor se guarda como un aviso de que llegó, sin sus datos, y las notificaciones del proyecto lo dicen.",
    "set.embed.feed_events_per_minute": "Eventos de flujo por minuto",
    "set.embed.feed_events_per_minute.d":
      "Cuántos eventos lee Den de un flujo de app por minuto. Por encima, Den lee el resto según lo permita el ritmo, y las notificaciones del proyecto lo dicen.",
    "feed.none": "Este proyecto no tiene flujos de eventos de apps.",
    "feed.row": "{name} a {agent}: {url}",
    "feed.last": "Último evento {time}.",
    "feed.noEvents": "Aún no hay eventos.",
    "set.embed.feed_keep_events": "Eventos que guarda un flujo de app",
    "set.embed.feed_keep_events.d":
      "El máximo de eventos que Den guarda para un flujo de app. Por encima, se van los más antiguos, y las notificaciones del proyecto lo dicen si alguno no se había leído.",
    "set.embed.feed_read_max_kb": "Datos de flujo en una lectura",
    "set.embed.feed_read_max_kb.d":
      "El máximo de datos de eventos que da una llamada a app_feed_read. El agente lee el resto con otra llamada.",
    "set.embed.feed_list_timeout": "Espera de la lista de un flujo",
    "set.embed.feed_list_timeout.d":
      "Cuánto espera Den la lista de eventos de una app (llena un hueco tras un corte) antes de volver a intentarlo más tarde.",
    "set.embed.feed_list_max_mb": "Lista de flujo más grande",
    "set.embed.feed_list_max_mb.d":
      "La lista de eventos más grande que Den lee de una app de una vez. Una respuesta mayor se rechaza y se vuelve a intentar más tarde.",
    "set.embed.paste_max_kb": "Texto máximo escrito en un agente de una vez",
    "set.embed.paste_max_kb.d":
      "El máximo de texto que Den escribe en un agente de una vez: comentarios de Hub, mensajes reenviados y líneas de flujos de apps. El resto se escribe después.",
    "feed.unread": "Sin leer: {n}.",
    "bell.m.appFeed.dropped":
      "Flujo {name} para {agent}: se fueron eventos sin leer porque el flujo guarda como máximo su límite.",
    "feed.problems":
      "Entradas de agents.event_feeds que no se pueden leer: {n}.",
    "feed.failed":
      "No se pudieron leer los flujos de eventos de este proyecto.",
    "feed.st.connecting": "Conectando",
    "feed.st.connected": "Conectado",
    "feed.st.retrying": "Reintentando",
    "feed.st.no_secret": "Su bearer no está en el almacén de secretos",
    "feed.st.over_limit": "No se lee: supera el límite de flujos",
    "feed.st.no_agent": "No se lee: ese agente no está en este proyecto",
    "feed.st.stopped": "Detenido",
    "bell.m.appFeed.no_secret":
      "Flujo {name} para {agent}: su bearer no se puede leer del almacén de secretos. Den sigue intentándolo.",
    "bell.m.appFeed.rejected":
      "Flujo {name} para {agent}: la app rechazó la petición de Den. Den sigue intentándolo.",
    "bell.m.appFeed.too_big":
      "Flujo {name} para {agent}: un evento superó el límite de tamaño. Se avisó al agente de que llegó, sin sus datos.",
    "bell.m.appFeed.over_rate":
      "Flujo {name} para {agent}: supera el límite de ritmo. Sus eventos esperan y se escriben según lo permita el ritmo.",
    "bell.m.appFeed.over_streams":
      "Flujo {name} para {agent}: no se lee, supera el límite de flujos leídos a la vez.",
    "pmcp.row": "{name}: {url}",
    "pmcp.failed": "No se pudieron leer los MCP de este proyecto.",
    "pmcp.edit": "Cambiar",
    "pmcp.editL": "Cambiar {name}",
    "pmcp.remove": "Quitar",
    "pmcp.removeL": "Quitar {name}",
    "pmcp.url": "Dirección",
    "pmcp.bearer": "Bearer",
    "pmcp.bearerKeep": "un nombre de secrets.refs; en blanco lo mantiene",
    "pmcp.noBearer": "Sin bearer",
    "pmcp.save": "Guardar",
    "pmcp.cancel": "Cancelar",
    "pmcp.rmT": "¿Quitar el MCP?",
    "pmcp.rmAsk":
      "¿Quitar {name} de los agentes del proyecto {project}? Pierden sus herramientas en su próximo inicio o reanudación.",
    "pmcp.rmW": "Quitando el MCP…",
    "pmcp.rmS": "Quitado.",
    "pmcp.rmF": "No se pudo quitar el MCP.",
    "ap.do.project_mcp_add":
      "Añadir el MCP {name} ({url}) a los agentes del proyecto {project}",
    "ap.mcp.warn":
      "Esto da a los agentes de {project} herramientas nuevas y envía sus llamadas a {url}.",
    "ap.mcp.server": "MCP: {name} en {url}",
    "ap.mcp.bearer":
      "Bearer: se lee de secrets.refs.{ref} en cada llamada; nunca se escribe en los archivos ni en el entorno del agente.",
    "ap.mcp.noBearer":
      "Sin bearer: sus llamadas no llevan cabecera Authorization.",
    "ap.mcp.next":
      "Los agentes de {project} lo reciben en su próximo inicio o reanudación.",
    "ap.do.project_mcp_remove":
      "Quitar el MCP {name} ({url}) de los agentes del proyecto {project}",
    "ap.do.project_mcp_update":
      "Cambiar el MCP {name} de los agentes del proyecto {project} (ahora {url})",
    "ap.mcp.removeWarn":
      "Los agentes de {project} pierden las herramientas de {name} en su próximo inicio o reanudación.",
    "ap.mcp.urlChange": "MCP {name}: de {from} a {to}",
    "pmode.none": "Usar el de todo Den",
    "pmode.following": "Sigue el de todo Den: {m}",
    "pmode.setHere": "Fijado para este proyecto: {m} (el de todo Den es {dw})",
    "pmode.changeDw": "Cambiar el valor por defecto de todo Den",
    "dwmode.now": "Vigente en todo Den: {m}",
    "dwmode.persona": "el modo propio de cada persona",
    "dwmode.over": "{n} proyectos lo reemplazan:",
    "dwmode.over.one": "{n} proyecto lo reemplaza:",
    "dwmode.overNone": "Ningún proyecto lo reemplaza.",
    "pmode.agent": "{name}: {m}, de {src}",
    "pmode.runsAs":
      "{name}: {m}, de {src}. Funciona en {running} hasta que se reinicie.",
    "pmode.stopped": "detenido",
    "pmode.noAgents": "Aún no hay agentes en este proyecto.",
    "pmode.follow": "Aplicar también a los {n} agentes con su propio ajuste",
    "pmode.follow.one": "Aplicar también al {n} agente con su propio ajuste",
    "pmode.followW": "Haciendo que sigan el proyecto…",
    "pmode.followS": "Ahora siguen el proyecto.",
    "pmode.followF": "No se aplicó. Nada cambió.",
    "pmode.failed": "No se pudo leer el modo de este proyecto.",
    "pm.wsDefault": "Este proyecto inicia los agentes en {m}.",
    "ov.runtime": "runtime: {r}",
    "ov.model": "modelo: {m}",
    "ov.latest": "más reciente",
    "ov.tools": "herramientas propias",
    "pe.what":
      "Una persona es una configuración de agente guardada: un rol, sus instrucciones, un runtime y un modelo predeterminados, y lo que puede hacer sin preguntar. Puedes tener varias con el mismo rol, cada una con su nombre.",
    "pe.preset": "Preajuste del rol",
    "pe.extra": "Comandos permitidos adicionales",
    "pe.extraS": "adicional",
    "pe.extraP":
      "Prefijos de comando simples, uno por línea. Sin patrones ni expresiones regulares. Den los traduce para cada runtime.",
    "pe.allows": "Lo que esto permite en {r}",
    "pe.ns": "no compatible con {r}",
    "pe.nsMode": "{r} aún no acepta un modo de permisos de Den",
    "pe.nsModel": "{r} no acepta un modelo de Den",
    "pe.nsPat": "usa un prefijo simple, no un patrón",
    "pe.nsBad": "no es un prefijo simple",
    "pe.badCmd":
      '"{c}" no es un prefijo de comando simple: usa letras, dígitos, espacios simples y . _ / : = @ % + , -',
    "pe.raw": "Editar la configuración del runtime…",
    "pe.rawLater":
      "Abrir el archivo de configuración del runtime llegará más adelante.",
    "pe.vendor": "específico del proveedor",
    "pe.instr": "Instrucciones",
    "pe.runtime": "Runtime predeterminado",
    "pe.model": "Modelo",
    "pe.ver": "Versión",
    "pe.rtDefault": "el predeterminado del runtime",
    "pe.perms": "Modo de permisos",
    "pe.noneCmd": "ninguno",
    "pe.loading": "Cargando…",
    "pe.loadFail": "No se cargaron las personas.",
    "pe.src.builtin": "integrado",
    "pe.src.distribution": "distribución",
    "pe.src.local": "mío",
    "pe.src.hub": "hub",
    "pe.src.project": "proyecto",
    "pe.src.builtin.p":
      "Viene con Den. Solo lectura aquí; duplícalo para personalizarlo.",
    "pe.src.distribution.p":
      "Viene con tu distribución. Solo lectura aquí; duplícalo para personalizarlo.",
    "pe.src.local.p": "Tuyo, en esta máquina.",
    "pe.src.hub.p": "Compartido a través de Den Hub. Solo lectura aquí.",
    "pe.src.project.p":
      "Del repositorio de este proyecto (.den/personas). Solo lectura aquí; cámbiala en el repositorio.",
    "pe.new": "Nueva persona",
    "pe.dupT": "Duplicar persona",
    "pe.edit": "Editar persona",
    "pe.dup": "Duplicar",
    "pe.editB": "Editar",
    "pe.view": "Ver",
    "pe.save": "Guardar persona",
    "pe.del": "Eliminar",
    "pe.deleted": "{n} eliminado",
    "pe.name": "Nombre",
    "pe.nameP": "p. ej., Rita",
    "pe.role": "Rol",
    "pe.roleHelp":
      "Un rol define la plantilla inicial de esta persona y permite que Den le asigne trabajo. No añade nada oculto a las instrucciones.",
    "pe.desc": "Descripción de una línea",
    "pe.cat": "Categoría",
    "pe.copy": "{n} (copia)",
    "pe.saved": "{n} guardado",
    "pe.ro": "Solo lectura aquí. Duplícalo para tener tu propia copia.",
    "pf.search": "Buscar personas por nombre, rol o descripción",
    "pf.cat": "Categoría",
    "pf.src": "Origen",
    "pf.all": "Todos",
    "pf.none": "Ninguna persona coincide. Quita los filtros o crea uno.",
    "pf.clear": "Quitar filtros",
    "cat.engineering": "Ingeniería",
    "cat.design": "Diseño",
    "cat.product": "Producto",
    "cat.marketing": "Marketing",
    "cat.operations": "Operaciones",
    "rt.installed": "Instalados",
    "rt.missing": "No instalados",
    "rt.notInst": "{r} no instalado",
    "rt.later": "más adelante",
    "rt.fallback":
      "El runtime predeterminado de {p}, {r}, no está instalado aquí, así que se inicia en {f}.",
    "ver.latest": "más reciente",
    "ver.latestP": "Más reciente (sigue la última versión)",
    "ver.newer": "hay una más nueva",
    "ver.newerP":
      "Hay una versión más nueva de este modelo. Esta sigue fijada hasta que la cambies.",
    "ver.newerOf": "Más nueva: {v}",
    "ver.use": "Usar la más reciente",
    "ver.pinned": "fijada {v}",
    "ver.usedLatest": "{n} ahora sigue la versión más reciente",
    "set.agents.personas": "Personas",
    "set.agents.rotation": "Rotación",
    "set.agents.hub": "Hub",
    // The Agents tab (AG-4a-term, agents-page.js).
    "n.agents": "Agentes",
    "n.terminal": "Terminales",
    "n.terminalTip":
      "Tus terminales en una lista, cada una en la carpeta de un proyecto",
    "ag.term.started": "Terminal abierta en {w}",
    "ag.term.failed": "Den no pudo abrir una terminal: {e}",
    "ag.start.lastLines": "Lo que mostró antes de detenerse:",
    "ag.term.ptyFailed":
      "Den no pudo abrir una terminal: esta máquina no le dio un PTY ({e}). Cierra las terminales que ya no uses o ejecuta doctor.",
    "ag.term.noWs": "no hay ningún proyecto activo. Activa uno primero.",
    "ws.termHere": "Nueva terminal",
    // Issue 482: la página Terminales.
    "ws.termHereTip":
      "Abrir una terminal nueva en la carpeta de este proyecto, en Den",
    "tm.count": "{n} terminales",
    "tm.count1": "{n} terminal",
    "tm.running": "En ejecución ({n})",
    "tm.exited": "Terminadas ({n})",
    "tm.lastUsed": "Último uso {when}",
    "tm.restart": "Reiniciar",
    "tm.restartName": "Reiniciar {id} en la misma carpeta",
    "tm.none": "Aún no hay terminales",
    "tm.noneP": "Pulsa Nueva terminal para abrir una en {scope}.",
    "tm.empty":
      "Elige una terminal a la izquierda para abrirla. Abre más para verlas en mosaico (hasta 4).",
    "tm.pick": "Nueva terminal en…",
    "tm.moved": "{n} terminales se movieron a Terminales. No se cerró nada.",
    "tm.moved1": "{n} terminal se movió a Terminales. No se cerró nada.",
    "tm.openList": "Abrir Terminales",
    "tm.dismiss": "Descartar",
    "kind.agent": "Agente",
    "kind.terminal": "Terminal",
    "ag.sub.agents": "{n} agentes",
    "ag.sub.agent": "{n} agente",
    "ag.sub.shells": "{n} shells",
    "ag.sub.shell": "{n} shell",
    "ag.sub.waiting": "{w} en espera",
    "ag.all": "todos los proyectos",
    "ag.waiting": "en espera",
    "ag.waiting.approval": "necesita tu Permitir",
    "ag.waiting.permission": "necesita permiso",
    "ag.waiting.input": "te espera",
    "ag.waiting.asked": "te preguntó",
    "ag.waiting.trust": "En espera: ¿confiar en esta carpeta?",
    "bell.title": "Notificaciones",
    "bell.n": "Notificaciones: {n} sin leer",
    "bell.n.one": "Notificaciones: {n} sin leer",
    "bell.markAll": "Marcar todo como leído",
    "bell.empty": "Nada te necesita ahora mismo.",
    "bell.notShown": "No se muestran: {kinds}.",
    "bell.sep": ", ",
    "bell.settings": "Ajustes de notificaciones",
    "bell.older": "Más de {d} días ({n})",
    "bell.updates": "Novedades ({n})",
    "bell.rep": "{n} más como este",
    "bell.stop": "Dejar de mostrar este tipo",
    "bell.askT": "¿Dejar de mostrar «{kind}»?",
    "bell.askB":
      "Solo este tipo. El registro de actividad lo sigue anotando. Puedes volver a activarlo en Ajustes.",
    "bell.askYes": "Dejar de mostrar",
    "bell.cancel": "Cancelar",
    "bell.undo": "Deshacer",
    "bell.undoMsg": "Ya no se muestra «{kind}».",
    "bell.clearRead": "Borrar las leídas",
    "bell.read": "Marcar como leída",
    "bell.server": "Agente de __DEN_TITLE__",
    "bell.hub": "Hub · {project}",
    "bell.hubAll": "Hub",
    "bell.m.permission": "{name} necesita tu permiso",
    "bell.m.permissionWhat": "{name} necesita tu permiso: {what}",
    "bell.m.input": "{name} te está esperando",
    "bell.m.asked": "{name} preguntó: {text}",
    "bell.m.toLead": "{name} preguntó al líder, {lead}: {text}",
    "bell.m.settled": "{name} retiró su pregunta, resuelta: {reason} ({text})",
    "bell.m.settledYou":
      "Retiraste la pregunta de {name}, resuelta: {reason} ({text})",
    "bell.m.settledLate":
      "La pregunta de {name} se resolvió: {reason}; tu respuesta llegó después y se le pasó ({text})",
    "bell.m.pick": "{n} proyectos necesitan tu elección",
    "bell.pickBody":
      "Den no sabe qué proyecto de Hub les corresponde. Haz clic para elegir. No se guarda nada de ellos hasta entonces.",
    "bell.pickBody.one":
      "Den no sabe qué proyecto de Hub le corresponde. Haz clic para elegir. No se guarda nada de él hasta entonces.",
    "bell.m.pick.one": "{n} proyecto necesita tu elección",
    "bell.m.hostRestarted":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. Agentes reanudados: {names}. Terminales que terminaron: {terminals}.",
    "bell.m.hostRestartedAgents":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. Agentes reanudados: {names}. No había ninguna terminal en marcha.",
    "bell.m.hostRestartedTerminals":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. No había ningún agente en marcha. Terminales que terminaron: {terminals}.",
    "bell.m.hostRestartedNone":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. No había ningún agente ni terminal en marcha.",
    "bell.m.hostRestartedCut":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. Agentes reanudados: {names}. Terminales que terminaron: {terminals}. Interrumpidos a mitad de turno, y avisados de revisar su último paso y seguir: {cut}.",
    "bell.m.hostRestartedAgentsCut":
      "__DEN_TITLE__ reinició su anfitrión de terminales con la versión instalada, así que los agentes y terminales nuevos vuelven a arrancar. Agentes reanudados: {names}. No había ninguna terminal en marcha. Interrumpidos a mitad de turno, y avisados de revisar su último paso y seguir: {cut}.",
    "bell.m.noHub": "{n} agentes empezaron sin Hub",
    "bell.m.restartFailed": "{name} no volvió tras un reinicio: {why}",
    "bell.m.unaskedExit":
      "{name} terminó sin que Den lo pidiera (salida {code}): {why}",
    "bell.m.trust": "{name}: En espera: ¿confiar en esta carpeta?",
    "bell.m.trustDeclined":
      "{name}: No se inició: esta carpeta no es de confianza. Reanuda y elige Yes.",
    "bell.m.policyRan": "{name} lo hizo sin pedirte permiso: {what}",
    "bell.m.heldAllow": "{name} espera tu permiso: {what}",
    "bell.m.gateLapsed":
      'El turno {kind} "{label}" de {name} caducó: no se renovó y pasó su estimación. Empezó el siguiente de la cola.',
    "bell.m.vschedPass": "Corrida programada en {env}: pasaron {n} pruebas.",
    "bell.m.vschedPass.one": "Corrida programada en {env}: pasó {n} prueba.",
    "bell.m.vschedFail":
      "Corrida programada en {env}: fallaron {n} de {total} pruebas.",
    "bell.m.vschedFail.one":
      "Corrida programada en {env}: falló {n} de {total} pruebas.",
    "bell.m.vschedExpire":
      'El permiso de la programación "{name}" vence en {n} días.',
    "bell.m.vschedExpire.one":
      'El permiso de la programación "{name}" vence en {n} día.',
    "bell.m.heldAllowAsk": "Espera tu permiso: {what}",
    "bell.m.shared": "{actor} compartió {title} contigo",
    "bell.m.sharedNote": "{actor} compartió {title} contigo: {note}",
    "bell.m.sharedAgent": "El agente {actor} compartió {title} contigo",
    "bell.m.sharedAgentNote":
      "El agente {actor} compartió {title} contigo: {note}",
    "bell.m.heldLapsed":
      "La solicitud de {name} venció sin respuesta: {what}. No se ejecutó nada; se le pidió al agente que vuelva a pedirlo.",
    "bell.m.heldLapsedAsk":
      "Una solicitud venció sin respuesta: {what}. No se ejecutó nada.",
    "bell.m.heldLost":
      "La solicitud de {name} se perdió en un reinicio: {what}. No se ejecutó nada a partir de ella; se le pidió al agente que vuelva a pedirlo.",
    "bell.m.heldLostAsk":
      "Una solicitud se perdió en un reinicio: {what}. No se ejecutó nada a partir de ella.",
    "bell.m.heldLostAll":
      "Las solicitudes que esperaban tu permiso no se pudieron recuperar tras un reinicio. Se perdieron; los agentes que vuelvan a pedirlo aparecerán aquí.",
    "bell.go.h": "Turnos de prueba pasados de su estimación",
    "bell.go.row": "{who} tiene el turno de prueba {kind}: {label}",
    "bell.go.sub": "Desde {time} · estimación {est} min · {over} min de más",
    "bell.go.end": "Terminar",
    "bell.go.ended":
      "Turno de prueba terminado. Empieza el siguiente en la fila.",
    "bell.ap.h": "Esperan tu permiso",
    "bell.ap.row": "{name} pide: {what}",
    "bell.ap.rowAsk": "Pedido: {what}",
    "bell.ap.waits": "Espera desde hace {ago} · vence {time}",
    "bell.ap.allow": "Permitir",
    "bell.ap.deny": "Denegar",
    "bell.ap.done": "Permitido: {what}",
    "bell.ap.denied": "Denegado: {what}",
    "bell.ap.failed": "No funcionó: {error}",
    "bell.m.ranAway":
      "Mientras __DEN_TITLE__ no estaba, {kept} siguieron y {back} volvieron: {names}",
    "bell.m.ranLoggedOut":
      "Mientras estabas desconectado ({min} min), estos agentes trabajaron: {names}",
    "bell.m.stoppedLoggedOut":
      "Mientras estabas desconectado ({min} min), estos agentes se detuvieron: {names}",
    "bell.m.keepOffer": "Mantener los agentes al cerrar sesión: Aplicar",
    "bell.m.noHub.one": "{n} agente empezó sin Hub",
    "bell.m.compacting":
      "{name} se compacta una y otra vez: {n} veces en {m} minutos",
    "bell.m.notAtPrompt":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: el agente no está en su indicador de entrada",
    "bell.m.notAtPrompt.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: el agente no está en su indicador de entrada",
    "bell.m.held.busy":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: el agente está ocupado con un turno",
    "bell.m.held.busy.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: el agente está ocupado con un turno",
    "bell.m.held.trust":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: hay una pregunta sobre confiar en su carpeta en su pantalla",
    "bell.m.held.trust.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: hay una pregunta sobre confiar en su carpeta en su pantalla",
    "bell.m.held.permission":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: hay una pregunta de permiso en su pantalla",
    "bell.m.held.permission.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: hay una pregunta de permiso en su pantalla",
    "bell.m.held.approval":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: espera a que permitas un cambio",
    "bell.m.held.approval.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: espera a que permitas un cambio",
    "bell.m.held.paused":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: está en pausa tras un bucle de compactación hasta que sigas",
    "bell.m.held.paused.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: está en pausa tras un bucle de compactación hasta que sigas",
    "bell.m.held.stopped":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: el agente no está en marcha",
    "bell.m.held.stopped.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: el agente no está en marcha",
    "bell.m.held.owner":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: Den aún pregunta a Hub quién eres",
    "bell.m.held.owner.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: Den aún pregunta a Hub quién eres",
    "bell.m.held.unread":
      "{name}: {n} mensajes esperan desde hace {m} min. En espera: Den no pudo leer el estado del agente a tiempo",
    "bell.m.held.unread.one":
      "{name}: {n} mensaje espera desde hace {m} min. En espera: Den no pudo leer el estado del agente a tiempo",
    "bell.m.hubNoAnswer":
      "{name}: {n} comentarios de Hub escritos, aún sin respuesta tras {m} min",
    "bell.m.hubNoAnswer.one":
      "{name}: {n} comentario de Hub escrito, aún sin respuesta tras {m} min",
    "bell.m.crashLoop":
      "La app web de __DEN_TITLE__ se detuvo {n} veces en {m} minutos sin un cierre limpio; esperó {s} s antes de volver a arrancar",
    "bell.m.updateOut":
      "Salió __DEN_TITLE__ {v}. Permite la actualización cuando te venga bien (esta instalación usa {have})",
    "bell.m.updateFailed": "__DEN_TITLE__ no pudo actualizarse a {v}: {why}",
    "bell.m.updateWaits":
      "La actualización de __DEN_TITLE__ a {v} espera: el agente de __DEN_TITLE__ espera tu permiso",
    "bell.m.updateWaitsAsked":
      "La actualización de __DEN_TITLE__ a {v} espera: el agente de __DEN_TITLE__ te hizo una pregunta",
    "bell.m.updateWaitsWhat":
      "La actualización de __DEN_TITLE__ a {v} espera: el agente de __DEN_TITLE__ espera tu permiso: {what} (desde {since})",
    "bell.m.updatedSecurity":
      "__DEN_TITLE__ se actualizó por una corrección de seguridad mientras {agent} te esperaba; su pregunta sigue abierta",
    "bell.m.toolsNoteHeld":
      "__DEN_TITLE__ volvió a conectar las herramientas de Hub de {agent}; su nota espera hasta que respondas a {agent} en su terminal",
    "bell.m.toolsListFailed":
      "{agent} no puede usar las herramientas de Hub: no se pudieron listar otra vez después de que __DEN_TITLE__ lo reiniciara una vez. Reinícialo desde Agentes cuando Hub esté arreglado",
    "bell.m.backNoteHeld":
      "__DEN_TITLE__ ha vuelto; su nota para {agent} espera hasta que respondas a {agent} en su terminal",
    "bell.m.restartedWhileWorking":
      "__DEN_TITLE__ se reinició para terminar una actualización mientras {agent} trabajaba",
    "bell.m.updateWaitsAskedWhat":
      "La actualización de __DEN_TITLE__ a {v} espera: el agente de __DEN_TITLE__ te hizo una pregunta: {what} (desde {since})",
    "bell.m.pinNotCommitted":
      "__DEN_TITLE__ {v} funciona aquí, pero su nueva versión fijada no está confirmada en la carpeta de la distribución",
    "bell.m.pinPushed":
      "__DEN_TITLE__ se actualizó a {v}: su versión fijada está confirmada ({sha}) y enviada",
    "bell.m.pinPushFailed":
      "__DEN_TITLE__ {v}: su versión fijada está confirmada ({sha}), pero el envío falló: {why}. __DEN_TITLE__ lo intenta de nuevo en la próxima comprobación de actualizaciones",
    "bell.m.pinCommitFailed":
      "__DEN_TITLE__ {v}: __DEN_TITLE__ no pudo confirmar su versión fijada: {why}. Lo intenta de nuevo en la próxima comprobación de actualizaciones",
    "bell.m.pinPrOpened":
      "__DEN_TITLE__ se actualizó a {v}: su versión fijada está en una solicitud de cambios ({branch})",
    "bell.m.pinPrUnsigned":
      "__DEN_TITLE__ se actualizó a {v}: su versión fijada está en una solicitud de cambios ({branch}), sin enviar a la rama: la rama exige commits firmados y no hay clave de firma de los agentes (doctor dice cómo)",
    "bell.m.pinBranchPushed":
      "__DEN_TITLE__ {v}: la rama {branch} con la versión fijada está enviada; abre una solicitud de cambios para ella ({why})",
    "bell.m.pinHeld":
      "__DEN_TITLE__ {v}: confirmar su versión fijada espera tu permiso",
    "bell.m.pinNotCommittedAllow":
      "__DEN_TITLE__ {v} funciona aquí, pero su nueva versión fijada no está confirmada: el agente de __DEN_TITLE__ espera tu permiso",
    "bell.m.hubCommentsRejected":
      "Los comentarios de Hub no llegan: Hub no aceptó el token de esta instalación (Ajustes › Hub: Volver a conectar)",
    "bell.m.hubCommentsForbidden":
      "Los comentarios de Hub no llegan: Hub rechazó la entrega de comentarios de esta instalación",
    "bell.m.hubCommentsRefused":
      "Los comentarios de Hub no llegan: Hub no tiene entrega de comentarios para esta instalación",
    "bell.m.hubCommentsUnreachable":
      "Los comentarios de Hub no llegan: __DEN_TITLE__ no puede conectar con Hub",
    "bell.m.hubCommentsClosed":
      "Los comentarios de Hub no llegan: Hub cierra una y otra vez el flujo de comentarios",
    "bell.m.hubCommentsSilent":
      "Los comentarios de Hub no llegan: el flujo de comentarios dejó de enviar datos",
    "bell.m.rolledBack":
      "__DEN_TITLE__ {v} no arrancó aquí y volvió a {from}: {why}",
    "bell.m.turn": "{name} terminó su turno",
    "bell.m.said": "{name}: {text}",
    "bell.m.hub": "{name} terminó {n} comentarios de Hub",
    "bell.m.hub.one": "{name} terminó {n} comentario de Hub",
    "bell.m.hubOn": "{name} terminó {n} comentarios de Hub en {artifact}",
    "bell.m.hubOn.one": "{name} terminó {n} comentario de Hub en {artifact}",
    "bell.now": "ahora",
    "bell.min": "{n} min",
    "bell.h": "{n} h",
    "ag.hub.working.one": "Trabajando en {n} comentario de Hub",
    "ag.hub.working": "Trabajando en {n} comentarios de Hub",
    "ag.hub.queued.one": "{n} comentario de Hub lo espera",
    "ag.ctx.tag": "Se compacta una y otra vez",
    "ag.ctx.looping":
      "Se compacta una y otra vez: {n} compactaciones automáticas en los últimos minutos.",
    "ag.ctx.causeFiles":
      "Causa probable: sus archivos de instrucciones ocupan {size}, más del {share}% de su contexto, y se cargan de nuevo tras cada compactación. El más grande es {path} ({big}).",
    "ag.ctx.causeOther":
      "Causa probable: su contexto se vuelve a llenar poco después de cada compactación (salidas de herramientas grandes o archivos leídos enteros).",
    "ag.ctx.held":
      "Las nuevas entregas a este agente esperan hasta que lo despejes.",
    "ag.ctx.clear": "Despejar",
    "ag.ctx.clearHeld": "Reanudar entregas",
    "ag.ctx.clearName": "Despejar la compactación repetida de {id}",
    "ag.ctx.cleared": "{id}: despejado",
    "ag.ins.tag": "Instrucciones grandes",
    "ag.ins.tip":
      "Sus archivos de instrucciones ocupan {size}: más del {share}% de su contexto. El más grande es {path} ({big}).",
    "ag.hub.queued": "{n} comentarios de Hub lo esperan",
    "ag.hub.notAtPrompt":
      "En espera: el agente no está en su indicador de entrada",
    "tx.asked": "Pedido",
    "tx.result": "Resultado",
    "tx.error": "Error",
    "tx.omitted": "{n} líneas anteriores no se muestran",
    "tx.omitted.one": "{n} línea anterior no se muestra",
    "tx.empty": "Nada todavía.",
    "tx.close": "Cerrar",
    "tx.loading": "Cargando…",
    "tx.failed": "No se pudo leer: {err}",
    "hp.title": "Ayudantes ({n})",
    "hp.bar": "Ayudantes: {n}",
    "hp.barRunning": "Ayudantes: {n}, {r} en marcha",
    "hp.titlePlain": "Ayudantes",
    "hp.rowRunning": "{n} ayudantes en marcha",
    "hp.rowRunning.one": "{n} ayudante en marcha",
    "hp.runningN": "{n} en marcha",
    "hp.chip": "{n} ayudantes",
    "hp.chip.one": "{n} ayudante",
    "hp.groupOf": "Ayudantes de {name}",
    "hp.open": "{what}, {status}: abrir su transcripción",
    "hp.dlg": "Ayudantes de {name}",
    "hp.earlier": "Conversaciones anteriores ({n})",
    "hp.none": "Sin ayudantes en esta conversación.",
    "hp.clear": "Borrar terminados",
    "hp.clearTip":
      "Oculta todos los ayudantes terminados de {name} (hechos, fallidos o detenidos). Los que corren se quedan.",
    "hp.clearFailed": "No se pudo borrar: {err}",
    "hp.cleared": "Ver borrados ({n})",
    "hp.allCleared": "Todos los ayudantes terminados están borrados.",
    "hp.unsupported":
      "El runtime de este agente no puede decir qué ayudantes inició.",
    "hp.workflow": "flujo {name}",
    "hp.note":
      "Los ayudantes corren dentro del propio agente: Den los muestra, pero no puede detenerlos ni dirigirlos. Para cambiar lo que hacen, díselo al agente.",
    "hp.st.running": "en marcha",
    "hp.st.idle": "inactivo",
    "hp.st.done": "terminado",
    "hp.st.failed": "falló",
    "hp.st.stopped": "detenido",
    "hub.rail": "Hub",
    "hub.railRejected":
      "Hub no acepta el token de esta instalación. Vuelve a conectar en Ajustes › Hub.",
    "hub.railForbidden":
      "Hub no permite esta instalación. Pídeselo a un administrador de Hub (Ajustes › Hub).",
    "hub.railNoToken":
      "Aún no está conectado a Hub. Conéctalo en Ajustes › Hub.",
    "hub.railUnreachable":
      "Den no puede llegar a Hub ahora mismo. Mira Ajustes › Hub.",
    "hub.railBadConfig":
      "Los ajustes de Hub de Den tienen un problema. Mira Ajustes › Hub.",
    "hub.railBadUrl":
      "La dirección de Hub no es https, así que Den no la abre. Mira Ajustes › Hub.",
    "ag.session": "shell",
    "ag.empty":
      "Elige un agente a la izquierda para abrir su terminal. Abre más para verlos en mosaico (hasta 4).",
    "ag.none.scope": "Aún no hay agentes en {scope}",
    "ag.detach": "Cerrar panel",
    "ag.to": "Para {name} · {ws}",
    "ag.toName": "Para {name}",
    "ag.detachName": "Cerrar el panel de {id} (sigue en marcha)",
    "ag.detached": "Panel de {id} cerrado: sigue en marcha",
    "ag.open": "Abrir",
    "ag.openName": "Abrir {id} en Agentes",
    "ws.openAgents": "Abrir en Agentes →",
    "ag.signin": "Inicia sesión para abrir terminales: ejecuta {cli} web login",
    "ag.revoked": "token revocado",
    "ag.revokedTip":
      "Su token fue revocado (web logout --all): detenlo y reanúdalo, o inícialo de nuevo, para darle uno nuevo",
    "ag.ended":
      "Esta terminal se cerró. Su registro se queda hasta que se reanude o se elimine.",
    "ag.switched": "Cambiado a {p}",
    "ag.exitedLine": "[la terminal se cerró{code}]",
    "ag.refusedUnknown": "el servidor rechazó la terminal",
    "ag.refusedStatus": "el servidor rechazó la terminal ({status})",
    "ag.goWs": "Abrir {ws} en Proyectos",
    "ag.lost": "[desconectado: {why}]",
    "ag.reconnect": "Reconectar",
    "ag.reconnecting": "Reconectando…",
    "ag.reconnectGaveUp":
      "No se pudo reconectar: {n} intentos en {min} minutos",
    "ag.notAnswering": "__DEN_TITLE__ no responde",
    "ag.path.download": "Descargar",
    "ag.path.open": "Abrir en {ed}",
    "ag.path.copy": "Copiar ruta",
    "ag.path.downloading": "Descargando {name}",
    "ag.path.noFile":
      "No se puede descargar {name}: no es un archivo del proyecto ni de las subidas del agente",
    "ag.up.drop": "Suelta para adjuntar a {name}",
    "ag.up.cant": "No se puede adjuntar: {name} no está en marcha",
    "ag.up.cantConn":
      "No se puede adjuntar: {name} aún no está conectado. Inténtalo de nuevo en un momento.",
    "ag.up.miss":
      "Suelta el archivo sobre el panel de un agente para adjuntarlo.",
    "ag.up.sending": "enviando…",
    "ag.up.pct": "{n} %",
    "ag.up.done": "adjuntado",
    "ag.up.attach": "Adjuntar",
    "ag.up.attachName": "Adjuntar un archivo a {id}",
    "ag.up.attachTip":
      "Adjuntar un archivo: va a la máquina del agente y su ruta se escribe aquí",
    "ag.size.follow": "Tamaño de otra vista ({cols}×{rows})",
    "ag.size.take": "Usar este tamaño",
    "ag.noBackend":
      "Los terminales necesitan el módulo PTY opcional (den-pty no está disponible): {cli} doctor explica por qué",
    "ag.hostDown":
      "Den no pudo contactar a tiempo con el host de terminales, así que esta lista puede estar desactualizada. Lo intenta de nuevo cada pocos segundos.",
    "ag.noHost":
      "No hay ningún host de sesiones en marcha: aún no se ha iniciado nada",
    "ag.ws": "Proyecto",
    "ag.pal": "Agentes › {ws} / {name}",
    "tm.pal": "Terminales › {ws} / {name}",
    "ag.palStart": "Iniciar agente…",
    // ON-6: the server agent (server-agent-page.js, the rail, ⌘K).
    "n.serverAgent": "Agente de __DEN_TITLE__",
    "ag.server": "Servidor",
    "pal.askServer": "Preguntar al agente de __DEN_TITLE__",
    "sa.sub.fresh":
      "Vamos a configurar __DEN_TITLE__. Solo lee hasta que permitas un cambio.",
    "sa.sub":
      "Para todo lo del servidor: añadir un repo, arreglar un servicio que falla, cambiar un ajuste o explicar qué está en marcha.",
    "sa.trust": "El agente pregunta si confías en su carpeta, {folder}.",
    "sa.trust.yes": "Confiar",
    "sa.trust.no": "Ahora no",
    "sa.trust.wait":
      "El agente espera hasta que respondas, aquí o en su terminal.",
    "sa.model": "Modelo",
    "sa.login":
      "Si Claude te pide iniciar sesión, hazlo aquí. Después {name} empieza.",
    "sa.readsOnly":
      "Cambia __DEN_TITLE__ con sus propias herramientas y solo hace commit de los archivos de la distribución. Cada cambio te lo pregunta antes, en este navegador.",
    "sa.starting": "Iniciando el agente…",
    "sa.idle": "{name} no está en marcha.",
    "sa.start": "Iniciar",
    "sa.fresh": "Empezar de nuevo",
    "sa.fresh.h": "¿Empezar de nuevo?",
    "sa.fresh.q": "Esto termina la conversación de {name}. ¿Empezar una nueva?",
    "sa.fresh.cancel": "Cancelar",
    "sa.fresh.go": "Empezar de nuevo",
    "sa.fresh.w": "Iniciando un nuevo {name}…",
    "sa.fresh.done": "Listo: un nuevo {name} está en marcha.",
    "sa.fresh.fail": "No se pudo iniciar un nuevo {name}.",
    "sa.failed": "No se inició: {why}. {cli} agents doctor da más detalles.",
    "sa.unread":
      "No se pudo leer el estado del agente. ¿Está en marcha el servidor web?",
    "sa.none.h": "Aún no hay ningún runtime para el agente",
    "sa.none":
      "El agente se ejecuta en una CLI de agente del catálogo de runtimes. Instala una, inicia sesión en ella una vez y vuelve a cargar esta página.",
    "sa.noTools": "aún no puede usar las herramientas de __DEN_TITLE__",
    "sa.manual.h": "O configúralo tú",
    "sa.manual": "Cada paso del agente también es un comando. En un terminal:",
    "sa.runsOn": "Se ejecuta en",
    "sa.openAgents": "Abrir en Agentes",
    "sa.saved": "Guardado. El agente lo usa desde su próximo inicio.",
    "ag.cap":
      "Hasta 4 paneles: se cerró el de {id} para hacer sitio (sigue en marcha)",
    "ag.layout": "Disposición",
    "ag.l.focus": "Enfoque",
    "ag.l.tabs": "Pestañas",
    "ag.l.tile": "Mosaico",
    "ag.l.tip": "{name} ({key})",
    "ag.hint.keys":
      "⌃⇧1 / ⌃⇧2 / ⌃⇧3 cambian la disposición. ⌘ y clic (Ctrl y clic) abre un enlace o una ruta. Alt+↑ / Alt+↓ mueven un agente en su proyecto.",
    "ag.pal.layout": "Disposición: {name}",
    "ag.copied": "Copiado",
    "ag.linkHint": "{key}+clic para abrir",
    "ag.subagents": "subagentes: {model}",
    "ag.subagents.inherit": "el del runtime",
    "ag.subagents.inheritFrom.persona":
      "Den no fija modelo para sus subagentes: subagent_model de su persona es inherit. Decide Claude Code, así que Explore puede usar el modelo del propio agente.",
    "ag.subagents.inheritFrom.org":
      "Den no fija modelo para sus subagentes: agents.subagents.model es inherit. Decide Claude Code, así que Explore puede usar el modelo del propio agente.",
    "ag.subagents.from.persona":
      "Sus subagentes (Explore también) usan {model}: subagent_model de su persona.",
    "ag.subagents.from.org":
      "Sus subagentes (Explore también) usan {model}: agents.subagents.model.",
    "ag.subagents.from.default":
      "Sus subagentes (Explore también) usan {model}: el valor por defecto de Den. Lo cambian agents.subagents.model o subagent_model de una persona.",
    "ag.signIn": "con {label}",
    "ag.signIn.tip":
      "Inicia sesión con {label}, cuyo token está en el almacén de secretos de esta instalación, así que sigue en marcha tras cerrar la sesión.",
    "ag.tabs": "Terminales abiertas",
    "ag.hint.focus":
      "Un clic muestra una terminal. Mayús o ⌘ y clic la añade al lado.",
    "ag.hint.tabs":
      "Un clic abre una terminal en una pestaña. Doble clic en una pestaña para cambiarle el nombre.",
    "ag.hint.tile": "Un clic añade una terminal al mosaico, hasta 4.",
    "ag.renameTip": "Doble clic para cambiar el nombre",
    "ag.renameName": "Cambiar el nombre de {id}",
    "ag.rn.item": "Cambiar el nombre…",
    "ag.rn.title": "Cambiar el nombre de {id}",
    "ag.rn.name": "Nombre",
    "ag.rn.help":
      "Lo muestran su pestaña, su fila y la cabecera del panel; el id {id} no cambia. Los demás agentes lo ven como {peer} desde su próximo inicio o reanudación. Vacío: vuelve a {id}.",
    "ag.rn.go": "Cambiar el nombre",
    "ag.rn.cancel": "Cancelar",
    "ag.job.h": "Hay una tarea en segundo plano en curso",
    "ag.job.q":
      "{id}: una tarea en segundo plano que inició sigue en curso ({min} min), como una ejecución de pruebas. ¿Reiniciar de todos modos? Eso termina la tarea.",
    "ag.job.go": "Reiniciar de todos modos",
    "ag.job.held":
      "{id}: una tarea en segundo plano que inició sigue en curso: aún no se ha reiniciado",
    "ag.mv.item": "Mover a otro proyecto…",
    "ag.ord.up": "Subir",
    "ag.ord.down": "Bajar",
    "ag.ord.top": "Mover al principio",
    "ag.ord.upOne": "Subir {id}",
    "ag.ord.downOne": "Bajar {id}",
    "ag.ord.reorder": "Reordenar",
    "ag.ord.reorderOne": "Reordenar los agentes de {ws}",
    "ag.ord.reorderStopped": "Reordenar los agentes detenidos",
    "ag.ord.done": "Listo",
    "ag.ord.grip": "Arrastra para cambiar su orden en el proyecto",
    "ag.ord.gripOne": "Arrastra para mover {id}",
    "ag.ord.moved": "{name} pasó a la posición {n} de {of}",
    "busy.ordW": "Moviendo {id}…",
    "busy.ordS": "Hecho: {id} se movió.",
    "busy.ordF": "No se pudo mover {id}.",
    "busy.pcW": "Guardando el color del proyecto…",
    "busy.pcS": "Hecho: el color del proyecto está guardado.",
    "busy.pcF": "No se pudo guardar el color del proyecto.",
    "busy.delProjW": "Eliminando {name}…",
    "busy.delProjS": "Se eliminó {name}.",
    "busy.delProjF": "No se pudo eliminar {name}.",
    // Issue 144: el chip de turnos de pruebas en Agentes.
    "gate.chip": "Turno: {kind} · {who} · hasta {at}",
    "gate.chipWaiting": " · {n} en espera",
    "gate.kind.browser": "pruebas de navegador",
    "gate.kind.cpu": "pruebas unitarias",
    "gate.popH": "Pruebas en esta máquina",
    "gate.holds": "Ejecuta {kind}, hasta las {at} más o menos",
    "gate.waits": "Espera para ejecutar {kind}, desde las {at} más o menos",
    "gate.padded": "estimación {est} min; esto suele tardar {usual}",
    "gate.over": "pasada su estimación",
    "gate.none": "Ninguna prueba tiene turno ni espera.",
    "gate.end": "Terminar antes",
    "gate.endT": "¿Terminar este turno antes?",
    "gate.endQ":
      "¿Terminar el turno de {label}? Su ejecución no se detiene; la siguiente puede empezar.",
    "gate.endGo": "Terminar turno",
    "gate.rowHolds": "turno: {kind}",
    "gate.rowWaits": "espera turno: {kind}",
    "gate.priority": "prioridad de versión: {reason}",
    "gate.priorityWaits":
      "prioridad de versión, después de la anterior: {reason}",
    "gate.onBox": "en la máquina de pruebas {box}",
    "gate.anyBox": "aquí o en una máquina de pruebas",
    "gate.boxesH": "Máquinas de pruebas",
    "gate.boxSlots": "{box}: {held} de {n} turnos de navegador en uso",
    "gate.boxHeld": "{box}: omitida, en pausa ({reason})",
    "gate.boxDown": "{box}: omitida, no responde ({reason})",
    "gate.boxLow": "{box}: omitida, poca memoria libre ({reason})",
    "gate.boxMemUnknown":
      "{box}: omitida, no se puede leer su memoria libre ({reason})",
    "gate.boxSkip": "no puede usar {box}: {reason}",
    "gate.boxOff": "{box}: omitida, apagada",
    "gate.boxClosed": "{box}: omitida, fuera de su horario (abre a las {time})",
    "gate.yielded": "Dejó pasar a {to}",
    "gate.class": "Clase: {name}",
    "gate.window": "espera su horario {window}",
    "gate.loadHoldCores":
      "esperando: la carga de esta máquina es {load}, más de {perCore} × {cores} núcleos ({limit}), mientras se ejecuta otra prueba unitaria; empieza cuando baje la carga o termine esa prueba",
    "gate.loadHold":
      "esperando: carga {load} ≥ {limit} mientras una prueba de versión tiene el puesto de navegador",
    "busy.gateEndW": "Terminando el turno de {name}…",
    "busy.gateEndS": "El turno de {name} terminó.",
    "busy.gateEndF": "No se pudo terminar el turno de {name}.",
    "busy.rmSvcW": "Quitando {name}…",
    "busy.rmSvcS": "Se quitó {name}.",
    "busy.rmSvcF": "No se pudo quitar {name}.",
    "busy.addSvcW": "Añadiendo {name}…",
    "busy.addSvcS": "Se añadió {name}.",
    "busy.addSvcF": "No se pudo añadir {name}.",
    "ag.orphan.one":
      "{names} no tiene proyecto: se eliminó. Asígnale uno con ⋯ › Mover a otro proyecto….",
    "ag.orphan.many":
      "{n} agentes no tienen proyecto ({names}): se eliminó. Asigna uno a cada uno con ⋯ › Mover a otro proyecto….",
    "ag.mv.title": "Mover {id}",
    "ag.mv.to": "Al proyecto",
    "ag.mv.helpStopped":
      "Conserva su conversación, carpeta, nombre y servicios. Se reanuda en el nuevo proyecto.",
    "ag.mv.helpRunning":
      "Conserva su conversación, carpeta, nombre y servicios. Den espera a que termine su turno y lo reanuda allí con las herramientas de ese proyecto.",
    "ag.mv.now": "Mover ahora, aunque esté a mitad de un turno",
    "ag.mv.go": "Mover",
    "ag.mv.none": "No hay otro proyecto al que moverlo.",
    "ag.mv.pending": "{id} se moverá a {ws} cuando termine su turno.",
    "ag.mv.done": "{id} se movió a {ws}.",
    "ag.where.logout": "Se detiene al cerrar sesión",
    "ag.where.logoutTip":
      "Se ejecuta en el escritorio, así que cerrar sesión lo termina. Para que los agentes sigan: Ajustes › Mantener los agentes al cerrar sesión, o {cli} service install --mode always (los agentes inician sesión allí con un token de larga duración: {cli} agents token set)",
    "ag.where.bg": "Sin GUI",
    "ag.where.bgTip":
      "Sigue ejecutándose tras cerrar sesión, fuera de la sesión de escritorio: sin el llavero de inicio de sesión ni apps con GUI. 1Password usa el token de la cuenta de servicio, los navegadores van sin interfaz y las carpetas protegidas necesitan Acceso total al disco ({cli} doctor).",
    "ag.rt.ready": "Inicia {name} {version} desde",
    "ag.rt.readyNoVer": "Inicia {name} desde",
    "ag.rt.notFound": "No se encontró {name}.",
    "ag.rt.searched": "Se buscó en:",
    "ag.rt.more": "y {n} más",
    "ag.rt.nowhere": "ningún directorio",
    "ag.rt.refused": "{name} no puede iniciarse: {why}.",
    "ag.rt.fix":
      "Instálalo, o pon su ruta en {key} en {file}, o ejecuta {cmd}.",
    "ag.rt.unknown": "Aquí no hay ningún runtime {id}.",
    "ag.rt.denTools": "Herramientas de Den: próximamente",
    "ag.rt.ownCli":
      "Se ejecuta como su propia CLI en el proyecto: las herramientas y los modos de permiso de Den llegarán más adelante.",
    "ag.rt.notInstalled": "no instalado",
    "ag.rt.needsArgv": "la persona no tiene plantilla argv",
    // issue 479: a quarantined runtime copy is never started.
    "ag.rt.quarantined":
      "{name} no puede iniciarse: macOS puso esta copia en cuarentena, así que Den no la ejecutó y macOS no mostró ningún aviso:",
    "ag.rt.useOther": "Usar otra copia encontrada:",
    "ag.rt.clearSelf":
      "O quítala tú en la máquina de Den: ejecútala una vez desde una terminal allí y permítela cuando macOS lo pregunte. Den nunca quita la cuarentena.",
    "ag.rt.copyPath": "Copiar ruta",
    "ag.rt.openTerminal": "Abrir una terminal allí",
    "ag.rt.copied": "Copiado",
    "ag.rt.copyByHand": "Seleccionada: cópiala con ⌘C o Ctrl+C",
    "ag.rt.openRuntimes": "Abrir Ajustes › Runtimes",
    "ag.rt.checkAgain": "Comprobar de nuevo",
    "ag.rt.notDone": "No funcionó",
    "pj.expand": "Expandir la lista de proyectos",
    "gr.act.autostartOff": "Inicio automático: desactivado (activar)",
    "gr.act.autostartOn": "Inicio automático: activado (desactivar)",
    "gr.act.clone": "Clonar",
    "gr.act.cmd": "Ejecutar {cmd}",
    "gr.act.copy": "Copiar dirección",
    "gr.act.downDeps": "Detener con dependencias",
    "gr.act.editor": "Abrir en el editor",
    "gr.act.logs": "Registros",
    "gr.act.logsPage": "Abrir en Registros",
    "gr.act.open": "Visitar ↗",
    "gr.act.output": "Mostrar el panel de salida",
    "gr.act.recheck": "Volver a comprobar el estado",
    "gr.act.restart": "Reiniciar",
    "gr.act.start": "Iniciar",
    "gr.act.stop": "Detener",
    "gr.act.syncFull": "Sincronizar (detener, pull, preparar)",
    "gr.act.terminal": "Terminal en el repositorio",
    "gr.act.upDeps": "Iniciar con dependencias",
    "gr.act.useLocal": "Usar mi copia local",
    "gr.act.useManaged": "Usar un clon gestionado",
    "gr.add": "Añadir",
    "gr.bar": "Opciones de vista del grafo",
    "gr.cardLabel": "{name} en {repo}, {status}. Abrir detalles.",
    "gr.cardLabelRemote":
      "{name} en {repo}, {status}, se ejecuta en remoto. Abrir detalles.",
    "gr.cards": "Tarjetas",
    "gr.cards.compact": "Compactas",
    "gr.cards.detailed": "Detalladas",
    "gr.checkedN": "{n} servicios comprobados",
    "gr.checkedOne": "{id} comprobado",
    "gr.closeDetails": "Cerrar detalles",
    "gr.collapse": "Contraer",
    "gr.collapseAll": "Contraer todo",
    "gr.confirm": "Confirmar: {label}",
    "gr.copied": "{id} copiado",
    "gr.dependsOn": "Depende de",
    "gr.details": "Detalles",
    "gr.dir.down": "De arriba abajo",
    "gr.dir.right": "De izquierda a derecha",
    "gr.dock": "Acoplar como panel lateral",
    "gr.expand": "Expandir",
    "gr.expandAll": "Expandir todo",
    "gr.find": "Buscar",
    "gr.findPh": "servicio, repositorio…",
    "gr.fit": "Ajustar",
    "gr.group": "Agrupar",
    "gr.group.app": "Aplicación",
    "gr.group.owner": "Propietario del repo",
    "gr.group.org": "Empresa",
    "gr.grp.commands": "Comandos del manifiesto",
    "gr.grp.common": "Más acciones",
    "gr.grp.danger": "Con cuidado",
    "gr.grp.tools": "Herramientas",
    "gr.h.checking": "comprobando…",
    "gr.h.none": "sin comprobación de estado",
    "gr.h.notChecked": "sin comprobar",
    "gr.h.reachable": "accesible",
    "gr.h.unreachable": "inaccesible",
    "gr.inProjects": "{id}: en {list}",
    "gr.k.application": "Aplicación",
    "gr.k.branch": "Rama",
    "gr.k.check": "Comprobación",
    "gr.k.healthCheck": "Comprobación de estado",
    "gr.k.logsFrom": "Registros de",
    "gr.k.manifest": "Manifiesto",
    "gr.k.mode": "Modo",
    "gr.k.onDisk": "En disco",
    "gr.k.opens": "Abre",
    "gr.k.placement": "Ubicación",
    "gr.k.repo": "Repositorio",
    "gr.k.role": "Rol",
    "gr.k.services": "Servicios",
    "gr.k.starts": "Se inicia",
    "gr.k.status": "Estado",
    "gr.layout": "Disposición",
    "gr.lg.click": "haz clic en una tarjeta para ver detalles",
    "gr.lg.cross": "local → remoto",
    "gr.lg.event": "evento",
    "gr.lg.hard": "dependencia fuerte",
    "gr.lg.intra": "dentro de un repositorio",
    "gr.lg.soft": "débil",
    "gr.location": "Ubicación",
    "gr.log.ended": "El flujo de registros terminó.",
    "gr.log.filter": "Filtrar líneas del registro",
    "gr.log.filterPh": "Filtrar líneas",
    "gr.log.pause": "Pausar",
    "gr.log.resume": "Reanudar",
    "gr.log.waiting": "Esperando líneas de registro…",
    "gr.log.wrap": "Ajustar líneas",
    "gr.max": "Maximizar el grafo",
    "gr.maxTip": "Maximizar el grafo (F)",
    "gr.missingTip": "Faltan: {list}",
    "gr.missingWhy": "Declarado, pero no está en este proyecto.",
    "gr.more": "Más",
    "gr.n.loading": "Cargando…",
    "gr.n.noActivity":
      "Aún no hay acciones. Aquí aparecen los inicios, reinicios y sincronizaciones, tuyos y de los agentes.",
    "gr.n.noneDeclared": "ninguno declarado",
    "gr.n.noneFound": "no se encontró ninguno",
    "gr.n.noneRemote": "ninguno aquí: se ejecuta en remoto",
    "gr.n.nothing": "nada",
    "gr.n.nothingHere": "nada en este proyecto",
    "gr.n.ownLog": "el archivo de registro propio del servicio",
    "gr.n.remoteEnv": "el entorno remoto",
    "gr.n.unknown": "desconocido",
    "gr.noElk":
      "No se cargó la biblioteca de disposición del grafo. Vuelve a cargar la página; si sigue igual, reinstala {cli}.",
    "gr.notClonedYet": "aún sin clonar: Sincronizar lo clona",
    "gr.okOf": "{ok}/{n} en buen estado",
    "gr.pinX": "Fijar {s}",
    "gr.pl.allLocal": "todo local",
    "gr.pl.allRemote": "todo remoto",
    "gr.pl.hybrid": "híbrido",
    "gr.pl.hybridList": "híbrido: {list}",
    "gr.pl.local": "local",
    "gr.pl.none": "sin ejecución",
    "gr.pl.remote": "remoto",
    "gr.pl.svcRuns": "{name} {runs}",
    "gr.popout": "Abrir en ventana emergente",
    "gr.project": "Proyecto",
    "gr.refused": "rechazado: {reason}",
    "gr.remoteEnv": "un entorno remoto",
    "gr.remoteNote":
      "Se ejecuta en {env}. Iniciar, detener y los registros ocurren allí, no en esta máquina.",
    "gr.remoteNoteAcct":
      "Se ejecuta en {env} · {account}. Iniciar, detener y los registros ocurren allí, no en esta máquina.",
    "gr.remoteWhy": "se ejecuta en {env}; aquí no hay nada que iniciar",
    "gr.remoteWhyAcct":
      "se ejecuta en {env} ({account}); aquí no hay nada que iniciar",
    "gr.repoDetails": "Detalles del repositorio",
    "gr.repoLabel":
      "{repo}, {status}, {n} servicios, {ok} en buen estado. Abrir detalles.",
    "gr.repos": "{n} repositorios",
    "gr.repos.one": "{n} repositorio",
    "gr.resize": "Arrastra para cambiar el tamaño",
    "gr.restoreTip": "Restaurar (Esc)",
    "gr.role.entry": "punto de entrada",
    "gr.role.infra": "infraestructura",
    "gr.role.service": "servicio",
    "gr.roll.awaiting": "desconocido (aún comprobando)",
    "gr.roll.okExtra": "en buen estado, {extra}",
    "gr.roll.redirect": "{n} con redirección",
    "gr.roll.state": "{state} ({down} caídos)",
    "gr.roll.unchecked": "{n} sin comprobar",
    "gr.roll.unknown": "desconocido (sin comprobar)",
    "gr.roll.unknownWhy": "desconocido ({why})",
    "gr.run": "Ejecutar",
    "gr.runs.local": "local",
    "gr.runs.none": "ninguno",
    "gr.runs.remote": "remoto",
    "gr.sec.about": "Acerca de",
    "gr.sec.aboutRepo": "Acerca de",
    "gr.sec.commands": "Comandos",
    "gr.sec.connections": "Conexiones",
    "gr.sec.health": "Estado",
    "gr.sec.healthRoll": "Estado",
    "gr.sec.missing": "Dependencias que faltan",
    "gr.sec.source": "De dónde viene",
    "gr.services": "{n} servicios",
    "gr.st.down": "caído",
    "gr.st.healthy": "en buen estado",
    "gr.st.unknown": "desconocido",
    "gr.starts.auto": "con el proyecto",
    "gr.starts.demand": "bajo demanda (inicio automático desactivado)",
    "gr.state.degraded": "degradado",
    "gr.state.down": "caído",
    "gr.state.ok": "correcto",
    "gr.state.unknown": "desconocido",
    "gr.tab.activity": "Actividad",
    "gr.tab.config": "Configuración",
    "gr.tab.logs": "Registros",
    "gr.tab.overview": "Resumen",
    "gr.tab.services": "Servicios",
    "gr.tag.entry": "entrada",
    "gr.tag.infra": "infra",
    "gr.tag.missing": "falta",
    "gr.tag.notCloned": "sin clonar",
    "gr.unpinX": "Quitar {s}",
    "gr.usedBy": "Usado por",
    "gr.vp":
      "Grafo de servicios. Arrastra para desplazarte, usa la rueda para moverte y Ctrl o Cmd + rueda para hacer zoom.",
    "gr.who.agent": "agente",
    "gr.who.you": "tú",
    "gr.who.youVia": "tú · {client} (sin verificar)",
    "gr.zoom": "Zoom",
    "gr.zoomIn": "Acercar",
    "gr.zoomOut": "Alejar",
    "gr.zoomReset": "Restablecer el zoom al 100 %",
    "term.input": "Entrada de la terminal",
    "term.tooMuch":
      "Hay demasiada salida para anunciarla; navega por las filas manualmente para leerla",
    "pj.title": "Proyectos",
    "pj.collapse": "Contraer la lista de proyectos",
    "pj.loading": "Cargando…",
    "pj.newPh": "nuevo-proyecto",
    "pj.newLabel": "Nombre del proyecto nuevo",
    "pj.delete": "Eliminar",
    "pj.activeTag": "(activo)",
    "pj.openTerm": "Abrir en la terminal",
    "pj.openEditor": "Abrir en el editor",
    "pj.moreActions": "Más acciones",
    "pj.moreFor": "Más para {ws}",
    "pj.deactivate": "Desactivar",
    "pj.activate": "Activar",
    "pj.rename": "Renombrar",
    "pj.activateFirst": "Activa este proyecto primero",
    "pj.noManaged": "No hay servicios gestionados en este proyecto",
    "pj.active": "activo",
    "pj.makeDefault": "Hacer predeterminado de la CLI",
    "pj.deactivateLc": "desactivar",
    "pj.activateLc": "activar",
    "pj.activateDefault": "activar + hacer predeterminado de la CLI",
    "pj.openGraph": "Abrir en el Grafo →",
    "pj.moreProject": "Más para este proyecto",
    "pj.setup": "Configuración del proyecto",
    "pj.renameDots": "Renombrar…",
    "pj.deleteDots": "Eliminar…",
    "pj.project": "Proyecto",
    "pj.up": "Iniciar",
    "pj.down": "Detener",
    "pj.restart": "Reiniciar",
    "pj.setupBtn": "Preparar",
    "pj.sync": "Sincronizar",
    "pj.addService": "Añadir servicio",
    "pj.find": "Buscar",
    "pj.findPh": "repositorio, servicio…",
    "pj.groupBy": "Agrupar por",
    "pj.group.none": "Ninguno",
    "pj.group.app": "Aplicación",
    "pj.group.owner": "Propietario del repo",
    "pj.group.org": "Empresa",
    "pj.reposIn": "Repositorios de {ws}",
    "pj.th.repo": "Repositorio",
    "pj.th.health": "Estado",
    "pj.th.branch": "Rama",
    "pj.th.mode": "Modo",
    "pj.th.lastRun": "Última prueba",
    "pj.th.actions": "Acciones",
    "pj.addRepo": "Añadir repositorio",
    "addSvc.title": "Añadir servicio: {ws}",
    "addSvc.filter": "Filtrar repositorios",
    "addSvc.filterPh": "Filtrar repositorios…",
    "addSvc.tab.local": "Locales",
    "addSvc.tab.gh": "GitHub",
    "addSvc.sortBy": "Ordenar por",
    "addSvc.sort.name": "Nombre",
    "addSvc.sort.project": "Proyecto",
    "addSvc.loading": "Cargando…",
    "addSvc.noLocal": "No hay repositorios en esta máquina",
    "addSvc.noResults": "Ningún repositorio coincide",
    "addSvc.added": "añadido",
    "addSvc.group.dev": "Gestionados por desarrollo",
    "addSvc.group.managed": "Gestionados por __DEN_TITLE__",
    "addSvc.ghLoading": "Cargando repositorios de GitHub…",
    "addSvc.ghNoMatch": "Ningún repositorio coincide con «{q}»",
    "addSvc.ghNone": "No hay repositorios de GitHub",
    "addSvc.noManifest": "sin manifiesto",
    "addSvc.group.supported": "Listos para __DEN_TITLE__",
    "addSvc.group.unsupported": "Sin __DEN_MANIFEST_YML__",
    "addSvc.refresh": "Actualizar",
    "addSvc.refreshTip": "Volver a cargar la lista de repositorios de GitHub",
    "addSvc.refreshing": "Actualizando…",
    "addSvc.manage": "Gestión",
    "addSvc.mode.dev": "Por desarrollo",
    "addSvc.mode.managed": "Gestionado",
    "addSvc.branch": "Rama",
    "addSvc.newBranch": "Rama nueva",
    "addSvc.optional": "opcional",
    "addSvc.add": "Añadir",
    "addSvc.done": "✓ {name} añadido",
    "addSvc.doneSetup":
      "✓ {name} añadido · la configuración está en marcha (ver Registros)",
    "addSvc.missingDeps": "Faltan dependencias: {deps}",
    "pj.validate.title": "Validar un manifiesto",
    "pj.validate.path": "Ruta o carpeta",
    "pj.validate.pathPh": "/absolute/path/to/repo  o  /path/to/{file}",
    "pj.validate.go": "Validar",
    "pj.validate.paste": "…o pega aquí el contenido de {file}",
    "pj.checking": "comprobando…",
    "pj.noRuntime": "sin ejecución",
    "pj.noRuntimeTip":
      "Este repositorio no ejecuta nada: nada que iniciar ni comprobar. Los agentes pueden trabajar en él.",
    "pj.checkingTip": "esperando la primera comprobación de estado",
    "pj.noUp": "{id} no tiene comando up",
    "pj.start": "Iniciar",
    "pj.startX": "Iniciar {id}",
    "pj.stop": "Detener",
    "pj.stopX": "Detener {id}",
    "pj.restartX": "Reiniciar {id}",
    "pj.logs": "Registros",
    "pj.logsX": "Registros de {id}",
    "pj.useLocalX": "{repo}: usar local",
    "pj.useManagedX": "{repo}: usar gestionado",
    "pj.useLocal": "usar local",
    "pj.useManaged": "usar gestionado",
    "pj.mode.dev-managed": "local",
    "pj.mode.managed": "gestionado",
    "set.ui.justNow": "ahora mismo",
    "set.ui.minAgo": "hace {n} min",
    "set.ui.hAgo": "hace {n} h",
    "set.ui.dAgo": "hace {n} d",
    "set.ui.viaGithubAs": "sesión iniciada con GitHub (@{login})",
    "set.ui.viaGithub": "sesión iniciada con GitHub",
    "set.ui.viaCode": "aprobado con un código",
    "set.ui.viaAgentView": "vista de solo lectura de {agent}",
    "set.ui.viaClaim": "reclamado con un enlace de configuración",
    "set.ui.viaLink": "sesión iniciada con un enlace de un solo uso",
    "set.ui.unknownBrowser": "Navegador desconocido",
    "set.ui.deviceOn": "{browser} en {os}",
    "set.ui.aBrowserOn": "Un navegador en {os}",
    "set.ui.tzBrowser": "La de tu navegador ({zone})",
    "set.ui.created": "creado {ago}",
    "set.ui.fromAt": "desde {from} ({name})",
    "set.ui.lastSeen": "visto por última vez {ago}",
    "set.ui.ownerIs": "Propietario:",
    "set.ui.unlink": "Desvincular",
    "set.ui.noOwner": "Este Den aún no tiene identidad de propietario.",
    "set.ui.linkGithub": "Vincula tu cuenta de GitHub", // words-ok: the en string's own word, translated
    "set.ui.noClient":
      "Vincular necesita un client id de GitHub App y no hay ninguno configurado: define {key} en config/local/user.yml y reinicia el servidor.", // words-ok: the en string's own word, translated
    "set.ui.linkFailed": "No se pudo vincular. Vuelve a intentarlo.",
    "set.ui.noAnswer": "El servidor no respondió. Vuelve a intentarlo.", // words-ok: the en string's own word, translated
    "set.ui.enterCode":
      "Introduce este código en {link} y aprueba la app. No pide ningún permiso.",
    "set.ui.openGithub": "Abrir GitHub",
    "set.ui.waitingGithub": "Esperando a GitHub…",
    "set.ui.ownerSignedIn":
      "El propietario solo se muestra con la sesión iniciada.",
    "set.ui.noDevices":
      "No hay dispositivos vinculados. Aquí aparece cada navegador que inicia sesión con GitHub, se aprueba con un código o abre un enlace de un solo uso.",
    "set.ui.thisDevice": "Este dispositivo",
    "set.ui.revoke": "Revocar",
    "set.ui.signOutAll": "Cerrar sesión en todas partes",
    "set.ui.signOutAllB":
      "Esto desconecta todos los navegadores y teléfonos, también este. Cada uno vuelve a entrar como siempre.",
    "set.ui.signOutRotate":
      "Sustituir también el secreto de inicio. Los agentes en marcha se detienen hasta que se reinicien.",
    "set.ui.signOutAllW": "Desconectando en todas partes…",
    "set.ui.signOutAllF": "No se desconectó",
    "set.ui.signOutAllDone": "Desconectado en todas partes",
    "set.ui.devicesSignedIn":
      "Los dispositivos solo se listan con la sesión iniciada.",
    "set.ui.asked": "lo pidió {ago}",
    "set.ui.appKeyAllow": "Permítelo en el cuadro de diálogo.",
    "set.ui.appKeyAgent": "Agente",
    "set.ui.appKeyOrigin": "Aplicación web",
    "set.ui.appKeyLabel": "Nombre (opcional)",
    "set.ui.appKeyMake": "Crear clave",
    "set.ui.appKeyNoOrigin":
      "Primero añade la aplicación web a la lista de arriba.",
    "set.ui.appKeyNone": "Aún no hay claves de aplicación.",
    "set.ui.appKeyUsed": "último uso {when}",
    "set.ui.appKeyUnused": "nunca usada",
    "set.ui.appKeyRevoked": "revocada {when}",
    "set.ui.appKeyRevoke": "Revocar",
    "set.ui.runnerNone": "Aún no hay tokens de runner.",
    "set.ui.boxName": "Nombre",
    "set.ui.boxSsh": "ssh (usuario@host)",
    "set.ui.boxPort": "Puerto ssh",
    "set.ui.boxKey": "Archivo de clave ssh",
    "set.ui.boxPw": "Servidor de Playwright (ws://)",
    "set.ui.boxSlots": "Turnos de navegador",
    "set.ui.boxHold": "Archivo de pausa (en la máquina)",
    "set.ui.boxScale": "Escala de tiempo",
    "set.ui.boxSave": "Guardar máquina",
    "set.ui.boxMem": "Memoria libre a mantener (MB)",
    "set.ui.boxPwv": "Versión de Playwright en la máquina",
    "set.ui.boxPwsEx": "1.61=ws://box:3931, 1.63=ws://box:3932",
    "set.ui.boxPws": "O Playwright por versión (1.61=ws://…, 1.63=ws://…)",
    "set.ui.boxNone":
      "No hay máquinas de pruebas. Las ejecuciones de navegador usan solo esta máquina.",
    "set.ui.boxSlotsN": "{n} turnos de navegador",
    "set.ui.boxHoldIs": "archivo de pausa {path}",
    "set.ui.boxScaleIs": "tiempo ×{n}",
    "set.ui.boxRemove": "Quitar",
    "set.ui.boxWindow": "Horario (hora de esta máquina)",
    "set.ui.boxRecheck": "Volver a comprobar tras, en segundos",
    "set.ui.boxOn": "Encendida",
    "set.ui.boxWindowIs": "{window}, hora de esta máquina",
    "set.ui.boxIsOff": "apagada",
    "set.ui.boxTurnOn": "Encender",
    "set.ui.boxTurnOff": "Apagar",
    "set.ui.appKeyOnce":
      "Copia ahora esta clave en el backend de la aplicación web. No se vuelve a mostrar.",
    "set.ui.appKeyNew": "Nueva clave de aplicación",
    "set.ui.copy": "Copiar",
    "set.ui.saveOrigins": "Guardar lista",
    "set.ui.approve": "Aprobar",
    "set.ui.deny": "Denegar",
    "set.ui.codeLabel": "Código en su pantalla",
    "set.ui.fromLogin": "del web login ejecutado a las {time}",
    "set.ui.noWaiting":
      "No hay ordenadores en espera. Una página sin iniciar sesión en otro ordenador muestra un código; aparece aquí para aprobarlo.",
    "set.ui.waitingSignedIn":
      "Los dispositivos en espera solo se listan con la sesión iniciada o en esta máquina.",
    "set.ui.testInstallYes": "Esta es una instalación de prueba.",
    "set.ui.testInstallNo":
      "No es una instalación de prueba. Las comprobaciones en vivo no pueden iniciar sesión aquí. Una persona marca una instalación de prueba a mano en la configuración de la distribución (web.test_install: true).",
    "set.ui.testPersonReady": "La persona de prueba está configurada.",
    "set.ui.testPersonMissing": "La persona de prueba aún no está configurada.",
    "set.ui.testPersonSetUp": "Configurar persona de prueba",
    "set.ui.testInstallSignedIn":
      "La instalación de prueba solo se puede leer con la sesión iniciada o en esta máquina.",
    "set.ui.noPairHost":
      "Ningún nombre de host de edge apunta a __DEN_TITLE__, así que no hay dirección que otro dispositivo pueda abrir. Añade uno al bloque edge de la configuración (edge.aliases para un nombre de VPN) y usa el botón de abajo: inicia el edge, o aplica el cambio al que ya está en marcha. {cmd}",
    "set.ui.edgeStart": "Iniciar el edge",
    "set.ui.edgeApply": "Aplicar",
    "set.ui.edgeStarted": "Edge iniciado",
    "set.ui.edgeCurrent": "Edge al día, no se reinició nada",
    "set.ui.edgeRecreated":
      "Edge recreado porque {why}; no se pudo alcanzar durante unos {s} s",
    "set.ui.edgeWhy": "cambió su configuración",
    "set.ui.edgeHost": "Nombre de host de edge",
    "set.ui.pairScan":
      "Escanéalo con el otro dispositivo o abre allí el enlace. Funciona una vez, hasta que caduca (abajo), y deja ese navegador con la sesión iniciada para siempre.",
    "set.ui.expiresIn": "Caduca en {s} s.",
    "set.ui.pairExpired":
      "Este enlace caducó. Vuelve a emparejar para obtener uno nuevo.",
    "set.ui.pairSignedIn": "Emparejar solo funciona con la sesión iniciada.",
    "set.ui.themeUnset": "{name} (sin definir: el propio de Den)",
    "set.ui.notSet": "sin definir",
    "set.ui.terminalTag": "terminal",
    "set.ui.notFound": "no encontrado",
    "set.ui.off": "Desactivado",
    "set.ui.on": "Activado",
    "set.ui.nLines": "{n} líneas",
    "set.ui.portUnset": "Sin definir: se aplica el de la distribución",
    "set.ui.signedIn": "Sesión iniciada",
    "set.ui.signOut": "Cerrar sesión",
    "set.ui.notSignedIn": "Sin sesión iniciada",
    "set.ui.signIn": "Iniciar sesión",
    "set.ui.savedIn": "Guardado en {vault}",
    "set.ui.theVault": "la bóveda",
    "set.ui.savedMemory": "Se guarda en memoria hasta que Den se reinicie",
    "set.ui.notSaved": "Sin guardar",
    "set.ui.forget": "Olvidar",
    "set.ui.none": "ninguno",
    "set.ui.portDefault": "sin definir ({port})",
    "set.ui.envsAll": "sin definir: todos",
    "set.ui.rot.auto": "Automático",
    "set.ui.rot.ask": "Preguntar",
    "set.ui.rot.relaunch": "Relanzar",
    "set.ui.rot.keep": "Seguir",
    "set.ui.rot.org": "configuración de la organización: {v}", // words-ok: the en string's own word, translated
    "set.ui.rot.default": "predeterminado: {v}",
    "set.ui.rot.install": "esta instalación",
    "set.ui.rot.inherit": "heredar ({v})",
    "set.ui.rot.thScope": "Ámbito",
    "set.ui.rot.thFor": "Para",
    "set.ui.rot.gone": "{name} (ya no existe)",
    "set.ui.rot.thSetting": "Ajuste",
    "set.ui.rot.thValue": "Valor",
    "set.ui.rot.remove": "Quitar",
    "set.ui.rot.clear": "Borrar",
    "set.ui.save": "Guardar",
    "set.ui.rot.caption": "Excepciones (gana la más específica)",
    "set.ui.rot.thActions": "Acciones",
    "set.ui.rot.none":
      "Sin excepciones: todos los agentes usan los valores de esta instalación.",
    "set.ui.rot.findAgent": "Escribe para buscar un agente",
    "set.ui.rot.findPersona": "Escribe para buscar una persona",
    "set.ui.rot.findProject": "Escribe para buscar un proyecto",
    "set.ui.rot.findService": "Escribe para buscar un servicio",
    "set.ui.rot.never": "nunca",
    "set.ui.rot.add": "Añadir excepción",
    "set.ui.hub.badConfig": "hub en user.yml no es válido",
    "setc.hub": "Hub",
    "setc.hub.d":
      "Den Hub es donde viven los documentos, maquetas, comentarios y aprobaciones de tu empresa. Conecta esta instalación y cada agente podrá buscar y publicar allí, y recibirá los comentarios y decisiones sobre su trabajo. Consulta docs/hub.md en la documentación de Den.",
    "set.ui.hub.addrNotUrl":
      "Eso no es una dirección web. Empieza por https://",
    "set.ui.hub.addrHttps":
      "La dirección de Hub debe empezar por https:// (http:// solo para esta máquina).",
    "set.ui.hub.save": "Guardar",
    "set.ui.hub.clear": "Borrar",
    "set.ui.hub.saveNote":
      "Guardar la conserva en tu configuración y reinicia Den. Borrar desconecta; los agentes pierden las herramientas de Hub al reiniciarse.",
    "set.ui.hub.empty":
      "Aún no hay Hub. Escribe la dirección del Hub de tu empresa y pulsa Conectar. Guardar solo conserva la dirección.",
    "set.ui.hub.saved":
      "Guardado. Den se reinició con la nueva dirección de Hub.",
    "set.ui.hub.cleared": "Borrado. Den se reinició sin Hub.",
    "set.ui.hub.address": "Dirección de Hub",
    "set.ui.hub.connect": "Conectar",
    "set.ui.hub.connectLinks":
      "Conectar también vincula cada proyecto de aquí con su proyecto de Hub. Cuando Den no sabe cuál corresponde, te pregunta.",
    "set.ui.hub.connectNote":
      "Conectar abre Hub. Inicia sesión allí y aprueba esta instalación; vuelves aquí ya conectado. El token se guarda en el almacén de secretos de esta instalación y nunca se muestra.",
    "set.ui.hub.teams": "un Hub compartido en {host}.",
    "set.ui.hub.ent":
      "tu propio entorno de ejecución aislado, en tu propio dominio o en un subdominio propio de {domain}.",
    "set.ui.hub.talk": "Habla con nosotros",
    "set.ui.hub.connected": "Conectado",
    "set.ui.hub.rejected": "Token no aceptado",
    "set.ui.hub.forbidden": "No permitido",
    "set.ui.hub.unreachable": "No se puede contactar con Hub",
    "set.ui.hub.notConnected": "Sin conectar",
    "set.ui.hub.status": "Estado",
    "set.ui.hub.company": "Empresa",
    "set.ui.hub.role": "Rol",
    "set.ui.hub.signedInAs": "Sesión iniciada como",
    "set.ui.hub.thisInstall": "Esta instalación",
    "set.ui.hub.whyRejected":
      "Hub ya no acepta el token de esta instalación (revocado o caducado). Volver a conectar te hace iniciar sesión de nuevo.",
    "set.ui.hub.whyForbidden":
      "Tu rol en Hub ya no permite conectar instalaciones. Pide a un administrador de Hub que cambie tu rol y luego vuelve a conectar.",
    "set.ui.hub.noAnswer": "Hub no respondió.",
    "set.ui.hub.tools":
      "Los agentes usan las herramientas de Hub sin preguntar",
    "set.ui.hub.toolsOn":
      "Los agentes pueden publicar y comentar en Hub sin preguntar; los cambios tienen versiones y se quedan en el equipo de esta instalación.", // words-ok: the en string's own word, translated
    "set.ui.hub.toolsOff":
      "Los agentes preguntan antes de usar cada herramienta de Hub.",
    "set.ui.hub.disconnect": "Desconectar",
    "set.ui.hub.disconnectWarn":
      "Esto revoca en Hub la clave de Hub de este Den. Los agentes pierden Hub hasta que vuelvas a conectar.",
    "set.ui.cancel": "Cancelar",
    "set.ui.rot.fixConfig":
      "Corrige primero la configuración: la rotación de la organización se lee de ella.", // words-ok: the en string's own word, translated
    "set.ui.rot.loadFailed": "No se cargaron los ajustes de rotación.",
    "set.ui.rot.pickPW": "Elige una persona y un proyecto.",
    "set.ui.countNone": "Ningún ajuste coincide",
    "set.ui.count": "{n} ajustes coinciden",
    "set.ui.count.one": "{n} ajuste coincide",
    "set.ui.scopeDist": "Distribución · solo lectura",
    "set.ui.scopeWs": "Configuración del proyecto · {ws}",
    "set.ui.scopeWsNone": "Configuración del proyecto",
    "set.ui.scopeUser": "Usuario", // words-ok: the en string's own word, translated
    "set.ui.noMatch": "Ningún ajuste coincide con «{q}».",
    "set.ui.clearSearch": "Borrar la búsqueda",
    "set.ui.project": "Proyecto",
    "set.ui.pickProject":
      "Estás viendo Todos los activos: elige el proyecto al que se aplican.",
    "set.ui.noActive": "No hay proyectos activos.",
    "set.ui.swatches": "Los colores del tema",
    "set.ui.inherit": "Predeterminado (heredar)",
    "set.ui.moveUp": "Subir {name}",
    "set.ui.moveDown": "Bajar {name}",
    "set.ui.unpinX": "Quitar {name}",
    "set.ui.noPins": "Nada fijado",
    "set.ui.setByIn": "Lo define la distribución en {file}.",
    "set.ui.setBy": "Lo define la distribución en su configuración.",
    "set.ui.showX": "Mostrar {name}",
    "set.ui.hideX": "Ocultar {name}",
    "set.ui.show": "Mostrar",
    "set.ui.hide": "Ocultar",
    "set.ui.noProject": "Ningún proyecto",
    "set.ui.default": "Predeterminado",
    "set.ui.saved": "✓ Guardado",
    "set.ui.saveFailed": "✗ No se pudo guardar",
    "set.ui.loadFailed": "No se cargaron los ajustes.",
    "set.ui.reload": "Vuelve a cargar para intentarlo de nuevo.",
    "set.ui.matching": "{n} coincidencias",
    "set.ui.from": "desde {from}",
    "set.ui.sub":
      "Se guarda en tus preferencias de __DEN_TITLE__ y se recuerda en todas las páginas",
    "set.ui.search": "Buscar ajustes",
    "set.ui.slashTip": "Pulsa / para buscar",
    "set.ui.cats": "Categorías de ajustes",
    "set.ui.rot.scope.agent": "Agente",
    "set.ui.rot.scope.persona-workspace": "Persona en un proyecto",
    "set.ui.rot.scope.persona": "Persona",
    "set.ui.rot.scope.workspace": "Proyecto",
    "set.ui.rot.scope.service": "Servicio",
    "set.ui.rot.key.after_compactions": "Tras compactaciones",
    "set.ui.rot.key.on_due": "Al tocar",
    "set.ui.rot.key.on_pr_merged": "Al fusionarse su PR",
    "set.ui.rot.pick.agent": "Elige un agente.",
    "set.ui.rot.pick.persona": "Elige una persona.",
    "set.ui.rot.pick.workspace": "Elige un proyecto.",
    "set.ui.rot.pick.service": "Elige un servicio.",
    "setc.appearance": "Apariencia",
    "setc.appearance.d": "El modo sigue al de tu sistema salvo que elijas uno.",
    "setc.editor": "Editor y terminal",
    "setc.editor.d":
      "Dónde ↗ abre un repositorio y >_ abre una terminal en un servicio.",
    "setc.navigation": "Navegación",
    "setc.navigation.d":
      "Oculta las páginas que nunca usas y elige su orden. Los fijados quedan arriba en la barra lateral.",
    "setc.graph": "Grafo",
    "setc.graph.d":
      "Cómo se dispone el grafo y cómo muestra sus proyectos la página Proyectos. Los controles de esas páginas también los cambian.",
    "setc.workspace": "Configuración del proyecto",
    "setc.workspace.d":
      "Ajustes de un proyecto. Siguen al proyecto que ves en la barra superior.",
    "setc.agents": "Agentes",
    "setc.agents.d":
      "Los runtimes en los que se ejecutan los agentes, primero los instalados. Las rutas que defines valen solo para esta máquina: en todas partes (config/local/user.yml) o para un proyecto (config/local/workspaces.yml), que tiene prioridad.",
    "setc.access": "Acceso",
    "setc.access.d":
      "Accede a este Den desde tus otros dispositivos: inicia sesión con GitHub como su propietario o empareja un dispositivo con un enlace de un solo uso. En localhost no se pide nada.",
    "setc.embed": "Incrustación",
    "setc.embed.d":
      "Permite que otras aplicaciones web enlacen a tus agentes. Un enlace rellena el cuadro de mensaje de un agente. No se envía nada hasta que pulses Enviar.",
    "setc.secrets": "Secretos",
    "setc.secrets.d":
      "De dónde obtiene esta máquina las credenciales con las que Den resuelve los secretos. Por máquina (config/local/user.yml); solo se muestra el origen, nunca un secreto.",
    "setc.server": "Servidor", // words-ok: the en string's own word, translated
    "setc.server.d":
      "El servidor web de Den con el que habla esta página. Un reinicio mantiene en marcha los agentes y los servicios.", // words-ok: the en string's own word, translated
    "setc.cli": "Línea de comandos",
    "setc.cli.d":
      "También son tuyos (config/local/user.yml) y se definen desde la línea de comandos: __DEN_CLI__ config <key>=<value>.",
    "setc.distribution": "Distribución",
    "setc.distribution.d":
      "Lo que la distribución define para todos. Aquí es de solo lectura: está en la configuración versionada de la distribución.",
    "set.server.restart.d":
      "Reinicia el servidor web en el mismo puerto. Los agentes, servicios y despliegues siguen en marcha; esta página se reconecta sin moverse. Equivale a __DEN_CLI__ web restart.", // words-ok: the en string's own word, translated
    "set.appearance.mode.d":
      "Sistema sigue el ajuste claro u oscuro de tu ordenador.",
    "set.appearance.mode.o.system": "Sistema",
    "set.appearance.mode.o.dark": "Oscuro",
    "set.appearance.mode.o.light": "Claro",
    "set.appearance.theme.d":
      "Predeterminado de la organización sigue el tema de la distribución. Si eliges un tema por su nombre, se mantiene aunque la distribución cambie el suyo.", // words-ok: the en string's own word, translated
    "set.language.d":
      "El idioma de los textos propios de Den. Los nombres, los registros y la salida de los comandos no cambian. Al cambiarlo se vuelve a cargar la página.",
    "set.time_zone.d":
      "Las fechas y horas de estas páginas se muestran en esta zona. Se guardan igual en cualquier caso.",
    "set.appearance.org-theme.d":
      "El tema que recibe todo el mundo hasta que elige uno (brand.theme).",
    "set.editor.d":
      "__DEN_TITLE__ abre los repositorios en este editor cuando haces clic en ↗.",
    "set.editor.open.d":
      "⌘-clic (Ctrl-clic en Windows y Linux) en una ruta de archivo del panel de un agente la abre aquí, en esa línea. Ninguno copia la ruta en su lugar.",
    "set.editor.open.o.vscode": "VS Code",
    "set.editor.open.o.cursor": "Cursor",
    "set.editor.open.o.zed": "Zed",
    "set.editor.open.o.none": "Ninguno (copiar)",
    "set.editor_overrides.d":
      "Para los repositorios cuyo stack.yml indica un lenguaje, abre este editor en lugar del predeterminado.",
    "set.terminal.d":
      "__DEN_TITLE__ abre una terminal en la carpeta del servicio cuando haces clic en >_.",
    "set.shell.pages.d":
      "Muestra u oculta cada página y muévela dentro de su grupo.",
    "set.shell.projectOrder.d":
      "El orden de los proyectos en el selector de la cabecera y en Gestionar proyectos. De la A a la Z por el nombre que se muestra, salvo que los muevas en Gestionar proyectos. Solo tuyo: nunca se comparte ni se envía a Hub.",
    "set.shell.pins.d":
      "Servicios y repositorios arriba en la barra lateral. Fíjalos desde Servicios, el grafo o la fila de estado.",
    "set.shell.collapsed.d":
      "Solo iconos. El botón propio de la barra lateral, abajo, hace lo mismo.",
    "set.shell.dock.d":
      "La salida de las ejecuciones, al pie de cada página. Desactivado, queda solo su barra: aparece la pestaña de una ejecución, el chip Ejecuciones parpadea y tú lo abres. Arrastra su borde superior para cambiar su tamaño, hasta la mitad de la ventana.",
    "set.graph.workspaces.d":
      "La lista de proyectos de la página Proyectos, abierta o contraída en una franja para que la tabla tenga todo el ancho.",
    "set.graph.workspaces.o.open": "Abierta",
    "set.graph.workspaces.o.collapsed": "Contraída",
    "set.graph.groupBy.d":
      "La tabla de repositorios de la página Proyectos: una sola lista, o agrupada por aplicación (como __DEN_CLI__ apps) o por empresa.",
    "set.graph.groupBy.o.none": "Ninguno",
    "set.graph.groupBy.o.app": "Aplicación",
    "set.graph.groupBy.o.org": "Empresa",
    "set.graph.direction.d":
      "Dispón el grafo de arriba abajo o de izquierda a derecha.",
    "set.graph.direction.o.down": "De arriba abajo",
    "set.graph.direction.o.right": "De izquierda a derecha",
    "set.graph.group.d": "Los marcos exteriores: por empresa o por aplicación.",
    "set.graph.group.o.org": "Por empresa",
    "set.graph.group.o.app": "Por aplicación",
    "set.graph.density.d":
      "Las tarjetas detalladas muestran más; las compactas caben más en pantalla.",
    "set.graph.density.o.detailed": "Detalladas",
    "set.graph.density.o.compact": "Compactas",
    "set.graph.panelWidth.d":
      "El ancho del panel de detalles del grafo, en píxeles (de 360 a 760).",
    "set.workspace.editor.d":
      "Al abrir este proyecto, o uno de sus repositorios sin una excepción por lenguaje, se usa este editor en lugar del predeterminado.",
    "set.workspace.hub.d":
      "El proyecto de Hub en el que los agentes de este proyecto archivan su trabajo de Hub: documentos, maquetas, comentarios. Den nunca vincula solo: Hub sugiere uno con los mismos repositorios o el mismo nombre, y tú lo confirmas. Sin vincular, Hub archiva el trabajo en Sin archivar. __DEN_CLI__ hub link -p <project>",
    "set.agents.layout.d":
      "Enfoque muestra un agente, Pestañas muestra uno con una pestaña para cada uno y Mosaico muestra hasta cuatro en una cuadrícula. El selector de la pestaña Agentes, ⌃⇧1, ⌃⇧2, ⌃⇧3 y ⌘K también lo cambian.",
    "set.agents.layout.o.focus": "Enfoque",
    "set.agents.layout.o.tabs": "Pestañas",
    "set.agents.layout.o.tile": "Mosaico",
    "set.agents.helpers_shown":
      "Mostrar hasta este número de ayudantes bajo un agente",
    "set.agents.helpers_shown.d":
      "El resto, en Mostrar todos. La insignia siempre muestra el total de ayudantes en marcha.",
    "set.agents.helpers_shown.o.1": "1",
    "set.agents.helpers_shown.o.3": "3",
    "set.agents.helpers_shown.o.5": "5",
    "set.agents.helpers_shown.o.10": "10",
    "setc.notifications": "Notificaciones",
    "setc.notifications.d":
      "Qué aparece en la campana y se suma a su insignia. Son decisiones tuyas. Apagado significa sin elemento en la campana y sin insignia. El registro de actividad lo sigue anotando.",
    "set.notifications.waiting": "Un agente te espera",
    "set.notifications.waiting.d":
      "Un agente te espera, o te hizo una pregunta, y no puede continuar.",
    "set.notifications.waiting.warn":
      "Mientras esté apagado, los agentes que te esperan no se mostrarán aquí ni en la insignia.",
    "set.notifications.finished": "Un agente terminó su turno",
    "set.notifications.finished.d":
      "Un agente se detuvo y está libre. Apagado por defecto.",
    "set.notifications.hub": "Respuestas y comentarios en Hub",
    "set.notifications.hub.d":
      "Alguien respondió a un comentario sobre algo que creaste.",
    "set.notifications.pr": "Pull requests",
    "set.notifications.pr.d":
      "Un pull request necesita revisión o cambió de estado.",
    "set.notifications.release": "Versiones y comprobaciones",
    "set.notifications.release.d":
      "Salió una versión, o falló una comprobación.",
    "set.notifications.pick": "Proyectos que necesitan tu elección",
    "set.notifications.pick.d":
      "Den no sabe qué proyecto de Hub corresponde a un proyecto.",
    "set.notifications.shared": "Compartido contigo",
    "set.notifications.shared.d":
      "Un agente compartió contigo un documento o una maqueta.",
    "set.notifications.fold_days": "Plegar elementos de más de",
    "set.notifications.fold_days.d":
      "Lo antiguo pasa a «Más de N días». No se borra nada.",
    "set.notifications.fold_days.o.3": "3 días",
    "set.notifications.fold_days.o.7": "7 días",
    "set.notifications.fold_days.o.14": "14 días",
    "set.notifications.fold_days.o.30": "30 días",
    "set.notifications.phone": "Avisos en este dispositivo por push",
    "set.notifications.phone.d":
      "Abre __DEN_TITLE__ en tu teléfono y activa esto allí: cuando un agente te necesite, el teléfono lo mostrará, aunque __DEN_TITLE__ esté cerrado. Aquí funciona con todas las pestañas cerradas. Cada dispositivo lo activa para sí.",
    "set.notifications.phone.none":
      "Este navegador no puede recibir push. En un iPhone, añade __DEN_TITLE__ a la pantalla de inicio (Compartir y luego Añadir a pantalla de inicio) y ábrelo desde allí.",
    "set.notifications.phone.failed": "No se pudo activar el push aquí.",
    "set.notifications.push_devices": "Dispositivos que reciben push",
    "set.notifications.push_devices.d":
      "Cada dispositivo que activó el push. Envía un aviso de prueba para comprobar que tu teléfono lo recibe: cada dispositivo dice si su servicio de push lo aceptó. Olvida el que ya no uses.",
    "set.notifications.devices.none":
      "Ningún dispositivo recibe push todavía. Abre __DEN_TITLE__ en tu teléfono (Emparejar un dispositivo, en Acceso, inicia sesión en él) y activa allí Avisos en este dispositivo por push.",
    "set.notifications.devices.this": "(este dispositivo)",
    "set.notifications.devices.added": "Añadido {t}",
    "set.notifications.devices.forget": "Olvidar",
    "set.notifications.devices.test": "Enviar un aviso de prueba",
    "set.notifications.test.reached": "Enviado: su servicio de push lo aceptó.",
    "set.notifications.test.gone":
      "Ya no está: este dispositivo ya no recibe push, así que se quitó.",
    "set.notifications.test.refused":
      "No enviado: su servicio de push respondió {status}.",
    "set.notifications.test.noAnswer":
      "No enviado: su servicio de push no respondió a tiempo (Espera del push).",
    "set.notifications.svc.apple": "Push de Apple",
    "set.notifications.svc.google": "Push de Google",
    "set.notifications.svc.mozilla": "Push de Firefox",
    "set.notifications.svc.microsoft": "Push de Microsoft",
    "set.notifications.svc.other": "Otro servicio de push",
    "set.notifications.quiet_from": "Inicio de las horas de silencio",
    "set.notifications.quiet_from.d":
      "Desde esta hora, ningún aviso fuera de la campana hasta que terminen las horas de silencio. La campana lo sigue teniendo todo. En tu zona horaria.",
    "set.notifications.quiet_to": "Fin de las horas de silencio",
    "set.notifications.quiet_to.d":
      "Los avisos fuera de la campana vuelven a esta hora.",
    "set.notifications.quiet.off": "No",
    "set.notifications.quiet.half":
      "Las horas de silencio necesitan un inicio y un fin.",
    "set.notifications.push_timeout": "Espera del push",
    "set.notifications.push_timeout.d":
      "Cuánto espera __DEN_TITLE__ a que un servicio de push acepte un aviso para un dispositivo. Pasado este tiempo, ese aviso se deja; el siguiente lo intenta de nuevo. __DEN_CLI__ config alerts.push_timeout_seconds=30",
    "set.notifications.push_ttl": "Push guardado durante",
    "set.notifications.push_ttl.d":
      "Cuánto guarda un servicio de push un aviso para un dispositivo apagado o sin conexión, en segundos. 86400 es un día; 0 lo descarta si el dispositivo no está encendido ahora. __DEN_CLI__ config alerts.push_ttl_seconds=86400",
    "set.notifications.desktop": "Avisos en el escritorio",
    "set.notifications.desktop.d":
      "Cuando un agente te necesita (un permiso, una pregunta, un Permitir), este navegador muestra una notificación, aunque __DEN_TITLE__ esté en segundo plano. Haz clic para abrir el agente. El navegador pregunta una vez.",
    "set.notifications.desktop.denied":
      "Este navegador bloquea las notificaciones de esta página. Permítelas en la configuración del sitio y activa esto.",
    "set.notifications.desktop.none":
      "Este navegador no puede mostrar notificaciones.",
    "hp.showAll": "Mostrar todos ({n})",
    "set.agents.runtimes.d":
      "El estado y la versión de cada runtime, la ruta en uso y de dónde viene. Definir ruta… ejecuta antes su comando de versión y rechaza una ruta que no sea ese runtime.",
    "set.agents.rotation.d":
      "Cuando la conversación de un agente se ha compactado este número de veces (o se fusionó su pull request), Den lo vuelve a iniciar desde su traspaso: una conversación nueva con el mismo nombre, persona, proyecto y carpeta. Automático pide el traspaso al agente cuando está libre y luego lo relanza solo; Preguntar muestra botones en el agente; Desactivado no hace nada. Las excepciones tienen prioridad sobre el valor de esta instalación: agente, persona en un proyecto, persona, proyecto, servicio. __DEN_CLI__ agents rotate",
    "set.agents.hub.d":
      "Conecta esta instalación al Hub de tu empresa: inicia sesión allí y apruébala. Así cada agente recibe las herramientas de Hub: buscar en Hub y publicar allí documentos y maquetas. Su empresa viene del token de esta instalación, y su proyecto de Hub, de Configuración del proyecto › Proyecto de Hub.",
    "set.agents.hub_github.d":
      "Cuántos repositorios de GitHub de tu empresa puede leer Den Hub, consultado a Hub en directo, con el enlace de GitHub para darle acceso o cambiar sus repositorios.",
    "set.agents.personas.d":
      "Configuraciones de agente desde las que puedes empezar. Las integradas vienen con Den, las de la distribución con tu distribución, y las tuyas están en esta máquina. Ver o Editar, Duplicar, + Nueva persona; solo las tuyas se pueden editar o eliminar.",
    "set.cli.local_dev.d":
      "Desactivado oculta Proyectos y las API de proyectos para ti. __DEN_CLI__ config local_dev=false",
    "set.agents.keep_running.d":
      "Activado (por defecto en una instalación nueva): __DEN_TITLE__ funciona como LaunchDaemon, así que los agentes siguen al cerrar sesión. Allí inician sesión con un token de larga duración de tu almacén de secretos, no con el llavero de inicio: la CLI de tus agentes lo crea cuando inicias sesión en ella, y tú lo pegas en Token de inicio de sesión, abajo. Desactivado: los agentes se detienen al cerrar sesión. __DEN_CLI__ config agents.keep_running_after_logout=true, luego __DEN_CLI__ service install",
    "set.cli.cli_tabs.d":
      "Si up y restart abren pestañas de terminal de forma predeterminada. __DEN_CLI__ config cli_tabs=true",
    "set.cli.log_window_lines.d":
      "Cuántas líneas mantiene cargadas un panel de Registros; la búsqueda en todo el historial no se ve afectada. __DEN_CLI__ config log_window_lines=50000",
    "set.cli.web_port.d":
      "web.port en config/local/user.yml tiene prioridad sobre el de la distribución. Se aplica la próxima vez que se inicie el servidor web.", // words-ok: the en string's own word, translated
    "set.cli.signin.d":
      "Cada navegador inicia sesión una vez, también en esta máquina, y la sesión se mantiene. Aquí, __DEN_CLI__ web up abre un enlace de acceso de un solo uso; un navegador que no ha iniciado sesión puede mirar pero no cambiar nada. Desde otra máquina: Iniciar sesión con GitHub o un enlace de un solo uso (__DEN_CLI__ web login). Ajustes › Acceso lista los navegadores con la sesión iniciada.", // words-ok: "iniciar sesión" is how Spanish says sign in
    "set.cli.sudo.d":
      "Solo se usa cuando un comando que ejecuta Den necesita sudo, y solo se pide entonces. No es un inicio de sesión: nada más lo necesita.",
    "set.cli.op_token.d":
      "De dónde viene el token de la cuenta de servicio de 1Password de esta máquina, para un Den que se ejecuta como servicio. Define secrets.onepassword.token en config/local/user.yml: keychain:<service>, file:<path> o env:<VAR>. El token nunca se muestra.", // words-ok: the en string's own word, translated
    "set.access.owner.d":
      "La cuenta de GitHub a la que pertenece este Den. Vincularla solo guarda su id (el token se descarta), y desde entonces esa cuenta puede iniciar sesión desde cualquier dispositivo. __DEN_CLI__ web owner link hace lo mismo desde la línea de comandos.", // words-ok: the en string's own word, translated
    "set.access.devices.d":
      "Los navegadores con la sesión iniciada en este Den. Revocar cierra uno al instante. __DEN_CLI__ web logout --all los cierra todos.",
    "set.access.waiting.d":
      "Ordenadores cuya página sin iniciar sesión muestra un código. Escribe el código que muestra la pantalla de ese ordenador para aprobarlo, y su página inicia sesión sola; una solicitud dura 10 minutos. __DEN_CLI__ web approve --list los muestra.",
    "set.embed.url_max.d":
      "La dirección web más larga que puede llevar un enlace a un agente para su cuadro de mensaje. Si es más larga, se abre una página que lo indica.",
    "set.embed.app_keys.d":
      "Una clave para el backend propio de una aplicación web en esta computadora: puede pasar los mensajes de su persona a un agente, que se escriben cuando termina su turno, y leer el estado de ese agente. Nada más. Permites cada clave, se muestra una vez y puedes revocarla aquí.",
    "set.embed.app_key_audit.d":
      "Las lecturas de estado de una clave de aplicación se anotan en el registro de actividad como una línea cada tantos segundos, con cuántas hubo, para que una aplicación web que consulta a menudo no lo llene.",
    "set.embed.origins.d":
      "La dirección de cada aplicación web, exacta, una por línea: https://app.example.com. Solo estas pueden mostrar un panel de agente dentro de sus páginas, y solo después de que lo permitas. Ningún otro sitio puede mostrar una página de este Den dentro de la suya.",
    "set.embed.key_minutes.d":
      "Cuánto tiempo puede enviar un panel de agente incrustado antes de volver a pedir permiso.",
    "set.embed.context_max_kb.d":
      "La página más grande que otra aplicación web puede compartir con un agente. Si es mayor, se rechaza y el panel explica por qué.",
    "set.access.machine_name.d":
      "Cómo llama a esta máquina la página sin iniciar sesión («se ejecuta en <name>»), para que quien esté en otro ordenador sepa dónde ejecutar un comando. Vacío: su nombre de host corto.",
    "set.access.pair.d":
      "Sin GitHub, o sin conexión: un enlace de un solo uso y un código QR para un nombre de host de edge (__DEN_CLI__ web login --host <name>).",
    "set.access.test_install.d":
      "Si esta instalación está marcada como de prueba: web.test_install en la configuración de la distribución, puesto a mano. Solo entonces las comprobaciones en vivo pueden iniciar sesión, como una persona de prueba (nunca tú, nunca un agente). Configurar persona de prueba la crea una vez, aquí en tu navegador.",
    "set.distribution.brand.d":
      "brand.name: el nombre en las páginas, el banner de la CLI y la ayuda.",
    "set.distribution.github_org.d":
      "github_org: la organización cuyos repositorios clona y lista Den.", // words-ok: the en string's own word, translated
    "set.distribution.hub_github.d":
      "Cuántos repositorios de GitHub de tu empresa puede leer Den Hub, consultado a Hub en directo. Den Hub solo lee un repositorio a través de la instalación de la GitHub App de tu empresa; el botón abre GitHub para instalarla o cambiar sus repositorios. Cuando vuelves, Den envía otra vez sus proyectos a Hub y los repositorios se vinculan solos.",
    "set.distribution.orgs.d":
      "orgs: nombres visibles de las organizaciones de GitHub a las que pertenecen los repositorios.", // words-ok: the en string's own word, translated
    "set.distribution.web_port.d":
      "web.port: el puerto en el que escucha la interfaz web, salvo que el tuyo lo sustituya.",
    "set.distribution.environments.d":
      "environments: los entornos que ofrece el menú Entorno.",
    "set.distribution.domain.d":
      "edge.domain: los servicios se sirven en https://<service>.<domain>.",
    "set.workspace.name.d":
      "El nombre que Den muestra para este proyecto en la cabecera, las listas y las páginas. Si está vinculado a un proyecto de Hub, es el nombre de Hub. El slug nunca cambia.",
    "set.ui.rt.toolsComing": "Herramientas de Den: próximamente",
    "set.ui.rt.installed": "instalado",
    "set.ui.rt.notInstalled": "No instalado",
    "set.ui.rt.src.workspace": "proyecto",
    "set.ui.rt.src.setting": "global",
    "set.ui.rt.src.login-shell": "detectado · shell de inicio",
    "set.ui.rt.src.PATH": "detectado · PATH",
    "set.ui.rt.src.well-known": "detectado · carpeta de instalación",
    "set.ui.rt.src.interactive-shell": "detectado · shell interactivo",
    "set.ui.rt.setPath": "Definir ruta…",
    "set.ui.rt.quarantined": "en cuarentena, no se ejecutó",
    "set.ui.rt.alsoFound": "También encontrado:",
    "set.ui.rt.versionUnknown": "versión desconocida",
    "set.ui.rt.useThis": "Usar este",
    "set.ui.rt.useThisFor": "Usar {path} para {name}",
    "set.ui.rt.clear": "Quitar",
    "set.ui.rt.pathToIn": "Ruta de {name} para {ws}",
    "set.ui.rt.pathToAll": "Ruta de {name} (todos los proyectos)",
    "set.ui.rt.save": "Guardar",
    "set.ui.rt.cancel": "Cancelar",
    "set.ui.rt.pathsFor": "Rutas para",
    "set.ui.rt.everyProject": "todos los proyectos (user.yml)",
    "set.ui.rt.fixConfig":
      "Corrige primero la configuración: los motores se leen de ella.",
    "set.ui.rt.noLoad": "Los motores no se cargaron.",
    // issue 171: the Edge page.
    "edge.reading": "Leyendo el edge…",
    "edge.tls.implicit":
      "implícito: edge.tls no está definido (mkcert con una CA local, obsoleto)",
    "edge.tls.legacy": "tomado de las claves antiguas (caroot / issue_cert)",
    "edge.tls.set": "definido en edge.tls",
    "edge.cert.files": "Nombres que deben cubrir los certificados incluidos",
    "edge.cert.names": "Nombres del certificado",
    "edge.cert.planned": "Nombres del certificado (previstos)",
    "edge.none": "No hay ningún edge configurado.",
    "edge.ports.httpOnly": ":{http} (solo http)",
    "edge.ports.none": "no publicados",
    "edge.trust.fronted": "no hace falta: hay un proxy delante",
    "edge.trust.unknown": "desconocida",
    "edge.trust.yes": "de confianza",
    "edge.trust.no": "sin confianza",
    "edge.k.container": "Contenedor",
    "edge.k.ports": "Puertos",
    "edge.k.trust": "Confianza en la CA",
    "edge.k.cert": "Certificado",
    "edge.up": "activo",
    "edge.down": "detenido",
    "edge.network": "red",
    "edge.trust.httpOnly": "solo http: sin CA",
    "edge.trust.proxy":
      "el proxy de delante gestiona la confianza del navegador",
    "edge.trust.noCa": "sin CA definida",
    "edge.cert.issued": "emitido",
    "edge.cert.notIssued": "sin emitir",
    "edge.cert.httpOnly": "solo http: sin certificado",
    "edge.cert.fromFiles": "de la configuración incluida",
    "edge.cert.n": "{n} nombres",
    "edge.cert.n.one": "{n} nombre",
    "edge.src.included": "archivo dinámico incluido",
    "edge.src.stack": "escrito por stack up",
    "edge.routes": "Rutas",
    "edge.col.name": "Nombre",
    "edge.col.upstream": "Destino",
    "edge.col.source": "Origen",
    "edge.routes.none": "No hay rutas.",
    "edge.notRead": "no se pudo leer ({error})",
    "edge.routes.note":
      "Primero las rutas propias de Den, luego los routers de los archivos dinámicos incluidos (edge include), cada uno con su archivo, y al final los routers que escribieron los stacks (stack).",
    "edge.domains": "Dominios",
    "edge.cert.none":
      "Ninguno: los certificados están en la configuración incluida.",
    "edge.notConfigured": "Sin configurar",
    "edge.unreachable": "inaccesible",
    // Issue 455: Den's address when another server holds its port.
    "edgeAddr.busy.checkW": "Comprobando la dirección de __DEN_TITLE__…",
    "edgeAddr.busy.checkS": "Comprobado",
    "edgeAddr.busy.checkF": "La comprobación no terminó.",
    "edgeAddr.busy.takeW": "Tomando el puerto para el proxy de __DEN_TITLE__…",
    "edgeAddr.busy.takeS": "Proxy de __DEN_TITLE__ iniciado",
    "edgeAddr.busy.takeF": "El proxy de __DEN_TITLE__ no se inició.",
    "edgeAddr.banner.title": "__DEN_TITLE__ está en {address} por ahora.",
    "edgeAddr.banner.held":
      "El puerto {port} lo ocupa {owner} ({name}), así que {host} va a {owner}.",
    "edgeAddr.banner.heldBare":
      "El puerto {port} lo ocupa {owner}, así que {host} va a {owner}.",
    "edgeAddr.banner.unknown":
      "El puerto {port} lo usa algo que __DEN_TITLE__ no sabe nombrar, así que {host} va allí.",
    "edgeAddr.banner.none": "Aún no se puede llegar: nada responde en {host}.",
    "edgeAddr.banner.fix": "Arréglalo en Edge",
    "edgeAddr.banner.dismiss": "Descartar",
    "edgeAddr.card.title":
      "El proxy de __DEN_TITLE__ no está en marcha: el puerto {port} está en uso",
    "edgeAddr.card.titleNone":
      "La dirección de __DEN_TITLE__ todavía no responde",
    "edgeAddr.card.held":
      "Lo ocupa {owner}, {kind} {name} (no __DEN_TITLE__). __DEN_TITLE__ sirve en {address} en su lugar. Comprobado {time}.",
    "edgeAddr.card.heldBare":
      "Lo ocupa {owner} (no __DEN_TITLE__). __DEN_TITLE__ sirve en {address} en su lugar. Comprobado {time}.",
    "edgeAddr.card.unknown":
      "Lo ocupa algo que __DEN_TITLE__ no sabe nombrar. __DEN_TITLE__ sirve en {address} en su lugar. Comprobado {time}.",
    "edgeAddr.card.none":
      "Aún no se puede llegar: nada responde en {wanted}. __DEN_TITLE__ sirve en {address} en su lugar. Comprobado {time}.",
    "edgeAddr.sub.held": "no está en marcha: el puerto {port} está en uso",
    "edgeAddr.sub.none": "aún no se puede llegar",
    "edgeAddr.kind.container": "contenedor de Docker",
    "edgeAddr.kind.process": "proceso",
    "edgeAddr.what": "¿Qué quieres hacer?",
    "edgeAddr.opt.proxy": "Añadir __DEN_TITLE__ a ese proxy",
    "edgeAddr.opt.free": "Liberar el puerto {port}",
    "edgeAddr.opt.takeOver": "Tomar el control",
    "edgeAddr.proxy.body":
      "Tu proxy sigue a cargo del puerto {port} y envía {host} a __DEN_TITLE__. __DEN_TITLE__ no cambia nada en tu otro proyecto; pegas esto donde está la configuración de tu proxy.",
    "edgeAddr.proxy.kinds": "Proxy",
    "edgeAddr.copy": "Copiar",
    "edgeAddr.copied": "Copiado",
    "edgeAddr.proxy.after":
      "Cuando recargues ese proxy, __DEN_TITLE__ comprueba que {wanted} llega a __DEN_TITLE__ y cambia sus enlaces a esa dirección. El proxy propio de __DEN_TITLE__ queda apagado (edge.publish: false, ajustado por ti).",
    "edgeAddr.check": "Comprobar de nuevo",
    "edgeAddr.checking": "Comprobando…",
    "edgeAddr.check.still": "Todavía no: sigue respondiendo como {owner}.",
    "edgeAddr.check.stillUnknown": "Todavía no: sigue sin ser __DEN_TITLE__.",
    "edgeAddr.check.done": "Hecho. __DEN_TITLE__ está ahora en {wanted}.",
    "edgeAddr.check.failed": "La comprobación no terminó: {error}",
    "edgeAddr.free.container":
      "Detén el contenedor {name} en Docker, o sácalo del puerto {port}. Luego pulsa Comprobar de nuevo; __DEN_TITLE__ arranca su propio proxy.",
    "edgeAddr.free.process":
      "Detén {owner} (proceso {name}), o sácalo del puerto {port}. Luego pulsa Comprobar de nuevo; __DEN_TITLE__ arranca su propio proxy.",
    "edgeAddr.free.unknown":
      "Detén lo que usa el puerto {port}, o sácalo de ese puerto. Luego pulsa Comprobar de nuevo; __DEN_TITLE__ arranca su propio proxy.",
    "edgeAddr.free.takeOver":
      "Es un proxy antiguo de __DEN_TITLE__ ({name}). Tomar el control lo detiene y arranca el de __DEN_TITLE__.",
    "edgeAddr.now": "Ahora",
    "edgeAddr.k.container": "Contenedor",
    "edgeAddr.k.ports": "Puertos",
    "edgeAddr.k.address": "Dirección de __DEN_TITLE__",
    "edgeAddr.k.wanted": "Dirección deseada",
    "edgeAddr.container.notCreated": "no creado",
    "edgeAddr.port.heldBy": "{port} ocupado por {owner}",
    "edgeAddr.port.held": "{port} en uso",
    "edgeAddr.port.free": "{port} libre",
    "edgeAddr.checked.den": "comprobado: este __DEN_TITLE__",
    "edgeAddr.checked.notDen": "no es __DEN_TITLE__",
    "edgeAddr.answers.as": "responde como {owner}",
    "edgeAddr.answers.notDen": "no es __DEN_TITLE__",
    "edgeAddr.answers.nothing": "nada responde",
    // issue 171: values the pages show (value-words.js, log-history.ts).
    "val.docker.created": "creado",
    "val.docker.running": "en marcha",
    "val.docker.paused": "en pausa",
    "val.docker.restarting": "reiniciándose",
    "val.docker.removing": "eliminándose",
    "val.docker.exited": "detenido",
    "val.docker.dead": "inservible (no se puede reiniciar)",
    "val.docker.absent": "no existe",
    "val.tls.none": "ninguno",
    "val.tls.files": "archivos",
    "val.gh.success": "correcto",
    "val.gh.failure": "fallido",
    "val.gh.error": "error",
    "val.gh.cancelled": "cancelado",
    "val.gh.timed_out": "tiempo agotado",
    "val.gh.inactive": "inactivo",
    "val.gh.in_progress": "en curso",
    "val.gh.queued": "en cola",
    "val.gh.pending": "pendiente",
    "val.gh.waiting": "en espera",
    "val.gh.requested": "solicitado",
    "val.gh.skipped": "omitido",
    "val.gh.action_required": "requiere acción",
    "val.gh.neutral": "neutral",
    "val.gh.stale": "obsoleto",
    "val.gh.startup_failure": "no pudo iniciarse",
    "val.perf.httpReqs": "Peticiones HTTP",
    "val.perf.iterations": "Iteraciones",
    "val.perf.vus": "Clientes virtuales (VU)",
    "val.perf.httpAvg": "HTTP media",
    "val.perf.httpP50": "HTTP p50",
    "val.perf.httpP95": "HTTP p95",
    "val.perf.httpP99": "HTTP p99",
    "val.perf.httpMax": "HTTP máx.",
    "val.perf.reqRate": "Peticiones / s",
    "val.perf.iterRate": "Iteraciones / s",
    "val.perf.failRate": "Tasa de fallos",
    "val.h.twice": "{why}, dos veces seguidas",
    "val.h.timeout": "tiempo agotado",
    "val.h.noAnswer": "sin respuesta en {s} s",
    "val.h.dns": "nombre no encontrado (DNS)",
    "val.h.noRoute": "sin ruta (404)",
    "val.h.fallback": "no es este servicio (localhost respondió con un error)",
    "val.h.killed": "detenido por {signal}",
    "val.h.exit": "la comprobación falló (código de salida {code})",
    "val.h.refused": "conexión rechazada",
    "val.h.reset": "conexión cortada",
    "val.h.unreachable": "sin respuesta",
    "val.h.tls": "certificado no aceptado",
    "val.h.dockerUnknown": "Docker no respondió",
    "val.h.noContainer": "no hay contenedor {name}",
    "val.h.unhealthy": "{name}: no pasa su comprobación de estado",
    "val.h.starting": "{name}: iniciándose",
    "val.h.healthy": "{name}: en buen estado",
    "val.h.container": "{name}: {state}",
    "lg.why.badName": "no es un nombre válido de repo o servicio",
    "lg.why.notLocal": "por ahora solo en local, no en {env}",
    "lg.why.noProject": "no se sabe en qué proyecto está {name}",
    "lg.why.noSource":
      "{name} no tiene un contenedor en marcha ni un archivo de registro",
    "lg.why.noSnapshot": "no se pudo copiar el registro del contenedor",
    // issue 171: the Environments page.
    "env.recheck": "Volver a comprobar",
    "env.checking": "comprobando…",
    "env.note.a": "Las comprobaciones de salud de",
    "env.note.b":
      "de cada repo, en todos los entornos. ↗ abre el servicio en una pestaña nueva. beta y prod solo se comprueban.",
    "env.loading": "Cargando…",
    "env.open.title": "Abrir {what} en una pestaña nueva: {url}",
    "env.open": "Abrir {what} en una pestaña nueva",
    "env.run.title": "La ejecución del despliegue en GitHub",
    "env.run": "ejecución",
    "env.timedOut": "se agotó el tiempo tras {s} s",
    "env.up": "activo",
    "env.down": "caído",
    "env.service": "Servicio",
    "env.none": "Ningún servicio a la vista tiene aún un __DEN_MANIFEST_YML__.",
    "env.noCompany": "sin empresa",
    "env.repoOn": "{repo} en {env}",
    "env.checkingN": "comprobando {n} entornos…",
    "env.checkingN.one": "comprobando {n} entorno…",
    "env.failingSoFar": "{n} con fallos por ahora",
    "env.checked": "comprobado a las {time}",
    "env.failing": "{n} con fallos",
    "env.nothingFailing": "nada falla",
    // issue 171: the Logs page.
    "lg.streams": "flujos",
    "lg.cols.title": "En columnas",
    "lg.cols": "columnas",
    "lg.rows.title": "Apilados",
    "lg.rows": "filas",
    "lg.search.ph": "Buscar en todos los registros…",
    "lg.search.title":
      "Buscar en TODO el historial de registros de cada servicio en marcha (desde que arrancó el contenedor)",
    "lg.search": "buscar",
    "lg.empty":
      "No hay registros abiertos. Abre uno desde la tarjeta de un servicio o la barra de arriba.",
    "lg.ownLog":
      "Registro propio de __DEN_TITLE__ (ciclo de vida + peticiones)",
    "lg.earlier": "⟰ anteriores",
    "lg.earlier.title":
      "Cargar historial anterior (hasta el arranque del contenedor)",
    "lg.filter": "filtrar…",
    "lg.filter.clear": "Quitar filtro",
    "lg.close": "✕ Cerrar",
    "lg.paused":
      "líneas en directo en pausa en esta vista (ventana llena mientras ves el historial)",
    "lg.loading": "… cargando",
    "lg.hist.unavailable": "historial no disponible: {reason}",
    "lg.hist.start": "inicio del contenedor",
    "lg.hist.full":
      "ventana de historial llena ({n} líneas) — sube log_window_lines o usa la búsqueda",
    "lg.hist.full.one":
      "ventana de historial llena ({n} línea) — sube log_window_lines o usa la búsqueda",
    "lg.hist.failed": "no se pudo cargar el historial: {error}",
    "lg.empty.click":
      "No hay registros abiertos. Haz clic en el nombre de un servicio de arriba para abrir uno.",
    "lg.search.pane": 'búsqueda: "{q}"',
    "lg.search.matches": "{n} coincidencias (haz clic para abrir el registro)",
    "lg.search.matches.one":
      "{n} coincidencia (haz clic para abrir el registro)",
    "lg.search.matchesMore":
      "{n}+ coincidencias (haz clic para abrir el registro)",
    "lg.search.matchesMore.one":
      "{n}+ coincidencia (haz clic para abrir el registro)",
    "lg.search.none":
      'no hay coincidencias para "{q}" en el historial de ningún servicio',
    "lg.aws.expired": "El acceso a AWS ha caducado",
    "lg.aws.reauth": "Volver a autenticar",
    "lg.aws.retry": "Reintentar",
    "lg.aws.failed": "no se pudo iniciar sesión",
    "lg.aws.connErr": "error de conexión",
    // issue 171: the Services page.
    "svc.loading": "Cargando servicios…",
    "svc.ws.none": "Aún no hay servicios.",
    "svc.ws.devManaged": "gestionado en desarrollo · {path}",
    "svc.ws.managed": "gestionado · {branch}",
    "svc.ws.remove": "Quitar",
    "svc.ws.selectRepo": "Elige un repo…",
    "svc.ws.added": "(añadido)",
    "svc.ws.nameRequired": "Falta el nombre",
    "svc.ws.created": '✓ Creado "{name}"',
    "svc.ws.keepDefault": "No se puede eliminar default",
    "svc.ws.deleted": '✓ Eliminado "{name}"',
    "svc.ws.pickRepo": "Elige un repo",
    "svc.ws.addedRepo": "✓ Añadido {repo}",
    "svc.loadingShort": "Cargando…",
    "svc.loadFailed": "No se pudieron cargar los servicios",
    "svc.none": "No hay servicios registrados.",
    "svc.none.how": "Usa {cmd} para añadir un repo.",
    "svc.pin": "Fijar {id}",
    "svc.unpin": "Dejar de fijar {id}",
    "svc.logs": "registros",
    "svc.notCloned.note": "aún sin clonar — usa Sincronizar en Proyectos",
    "svc.sub.note": "lo gestiona su sistema",
    "svc.noCmds": "no hay comandos para este entorno",
    "svc.noRuntime": "sin ejecución",
    "svc.runsNothing.note":
      "no ejecuta nada: nada que iniciar ni comprobar; los agentes pueden trabajar en él",
    "svc.runsNothing.title":
      "Este repositorio no ejecuta nada (configuración, documentación, reglas o CI compartida). No tiene servicios, así que nada se inicia ni se comprueba.",
    "svc.notCloned.title": "Aún sin clonar",
    "svc.notCloned": "sin clonar",
    "svc.layers.title": "Capas del manifiesto aplicadas",
    "svc.layers": "manifiesto: {layers}",
    "svc.shared":
      "Compartido: aparece una vez por todos los proyectos a la vista que lo definen",
    "svc.app.single": "Aplicaciones de un solo repo",
    "svc.app.single.d": "Cada repo es su propia aplicación.",
    "svc.app.none": "Fuera de una aplicación",
    "svc.app.none.d": "A la vista, pero en ninguna aplicación.",
    "svc.owner": "Propietario",
    "svc.done": "✓ Hecho en {time}",
    "svc.failed": "✗ Falló en {time}",
    "svc.closed": "Conexión cerrada",
    "svc.openTab": "Abrir {url} en una pestaña nueva",
    // issue 171: the Tests page's report pane.
    "perf.noMetrics": "No se registraron métricas.",
    "perf.noValues": "No se registraron valores",
    "perf.noData": "No se registraron datos.",
    "perf.pane.journeys": "Salida de los recorridos",
    "perf.pane.journeys.empty":
      "Ejecuta los recorridos para ver su salida; los informes de cada ejecución quedan en reports/journeys/",
    "perf.pane.security": "Salida del análisis de seguridad",
    "perf.pane.security.empty":
      "Ejecuta los análisis de seguridad para ver su salida; los informes de ZAP quedan en reports/security/",
    "perf.pane.suites": "Salida de las suites",
    "perf.pane.suites.empty": "Ejecuta las suites del repo para ver su salida",
    "perf.pane.playwright": "Informe de Playwright",
    "perf.pane.playwright.empty":
      "Ejecuta las pruebas para ver el informe de Playwright",
    "perf.pane.perf": "Informe de rendimiento",
    "perf.pane.perf.empty":
      "Ejecuta las pruebas de rendimiento para ver el informe",
    "perf.col.metric": "Métrica",
    "perf.col.expression": "Expresión",
    "perf.col.actual": "Real",
    "perf.col.status": "Estado",
    "perf.passed": "superado",
    "perf.failed": "fallido",
    "perf.noThresholds": "No hay umbrales configurados.",
    "perf.col.check": "Comprobación",
    "perf.col.passes": "Aciertos",
    "perf.col.fails": "Fallos",
    "perf.col.passRate": "Tasa de acierto",
    "perf.noChecks": "No se registraron comprobaciones.",
    "perf.col.scenario": "Escenario",
    "perf.col.executor": "Ejecutor",
    "perf.col.details": "Detalles",
    "perf.noScenarios": "No se registraron escenarios.",
    "perf.col.values": "Valores",
    "perf.pass": "ok",
    "perf.fail": "fallo",
    "perf.noCustom": "No se registraron métricas propias.",
    "perf.summary": "Resumen",
    "perf.latency": "Latencia",
    "perf.throughput": "Rendimiento y errores",
    "perf.thresholds": "Umbrales",
    "perf.scenarios": "Escenarios",
    "perf.checks": "Comprobaciones",
    "perf.custom": "Métricas propias",
    "perf.modules": "Módulos: {n}",
    "perf.started": "Inicio: {at}",
    "perf.finished": "Fin: {at}",
    // issue 171: the Tests page.
    "tst.openApp": "Abrir la app",
    "tst.openApp.link": "abrir app",
    "tst.idle": "inactivo",
    "tst.layout.top.title": "Controles arriba",
    "tst.layout.top": "arriba",
    "tst.layout.side.title": "Controles a la izquierda",
    "tst.layout.side": "lado",
    "tst.run": "Ejecutar",
    "tst.p.browser": "navegador",
    "tst.p.api": "api",
    "tst.p.smoke": "smoke",
    "tst.p.perf": "rendimiento",
    "tst.p.journeys": "recorridos",
    "tst.p.security": "seguridad",
    "tst.p.suites": "suites",
    "tst.allModules": "Todos los módulos",
    "tst.modules": "{n} módulos",
    "tst.modules.one": "{n} módulo",
    "tst.apiUrl": "url de la api",
    "tst.apiUrl.ph": "Opcional; en blanco usa el valor del repo o del entorno",
    "tst.localCheckout": "usar la copia local",
    "tst.scan": "análisis",
    "tst.scan.baseline": "baseline: pasivo, local + beta",
    "tst.scan.api": "api: OpenAPI, activo, solo local",
    "tst.scan.full": "full: ataques activos, solo local",
    "tst.view.rendered": "Informe",
    "tst.view.raw": "Salida sin formato",
    "tst.openTab": "Abrir en una pestaña nueva",
    "tst.noSource":
      "No se detectó ningún repo de origen para este tipo — añade uno a tu proyecto o a register-repos.",
    "tst.source": "origen:",
    "tst.unknown": "(desconocido)",
    "tst.noBranch": "(sin rama)",
    "tst.running": "ejecutando…",
    "tst.passedIn": "✓ Superado en {d}",
    "tst.failedIn": "✗ Falló en {d}",
    "tst.passed": "superado ({d})",
    "tst.failed": "falló ({d})",
    "tst.perfUnavailable":
      "No hay informe de rendimiento estructurado. Se muestra la salida sin formato.",
    "tst.error": "error",
    "tst.rawEmpty": "Aquí aparecerá la salida de rendimiento sin formato.",
    "tst.risk.high": "Alto",
    "tst.risk.medium": "Medio",
    "tst.risk.low": "Bajo",
    "tst.risk.info": "Info",
    "tst.sec.head": "análisis {mode} · {env} · {at}",
    "tst.sec.new": "Nuevos",
    "tst.sec.failed": "el análisis falló: {error}",
    "tst.sec.report": "informe",
    "tst.sec.newOne": "nuevo",
    "tst.perfLoadFailed":
      "No se pudo cargar el informe de rendimiento ({status})",
    "tst.svc.none": "No hay servicios registrados para {env}.",
    "tst.svc.how": "Añade un bloque {block} a {file}.",
    "tst.svc.noCaps": "no hay acciones para este entorno",
    "tst.detach": "Desconectar",
    "tst.stop": "Detener",
    "tst.detached": "Desconectado",
    "tst.stopped": "Detenido",
    "tst.runningCmd": "ejecutando {what}…",
    // issue 171: the Release page.
    "rel.deployTo": "desplegar en:",
    "rel.target": "Destino del despliegue",
    "rel.refresh.title": "Volver a comprobar lo desplegado",
    "rel.refresh": "Actualizar",
    "rel.idle": "inactivo",
    "rel.waves.title": "Editar el reparto en oleadas",
    "rel.waves": "Oleadas…",
    "rel.deployAll": "Desplegar todo →",
    "rel.readOnly.title":
      "Los despliegues están desactivados. Pon release.deploy: true en __DEN_CONFIG_FILE__ para activarlos.",
    "rel.readOnly": "solo lectura",
    "rel.loading": "Cargando lo desplegado",
    "rel.loading.sub":
      "Comprobando cada repo con GitHub — puede tardar un minuto.",
    "rel.close": "Cerrar",
    "rel.col.repo": "Repo",
    "rel.col.deployedAt": "Desplegado",
    "rel.col.deployer": "Quién desplegó",
    "rel.col.source": "Origen",
    "rel.col.deployed": "Desplegado",
    "rel.col.branch": "Rama",
    "rel.col.status": "Estado",
    "rel.col.deploy": "Desplegar",
    "rel.col.run": "Ejecución",
    "rel.noEnv": "no hay ningún entorno de despliegue configurado",
    "rel.refreshing": "actualizando…",
    "rel.checking": "comprobando lo desplegado…",
    "rel.error": "error: {error}",
    "rel.updated": "{n} repos · actualizado a las {time}",
    "rel.updated.one": "{n} repo · actualizado a las {time}",
    "rel.loadFailed": "no se pudo cargar el estado",
    "rel.rechecking": "Volviendo a comprobar {env}",
    "rel.checkingEnv": "Comprobando {env}",
    "rel.comparing":
      "Comparando cada repo con GitHub — puede tardar un minuto.",
    "rel.none":
      "No hay repos que comprobar. Añade al {file} de un repo un bloque {block} que diga de dónde se lee el commit desplegado de cada entorno.",
    "rel.via": "vía {source}",
    "rel.srcBranch": "rama desde la que se despliega este entorno",
    "rel.ghEnv": "Entorno de GitHub",
    "rel.automated": "automático",
    "rel.viewOnGh": "Ver a {who} en GitHub",
    "rel.openWorkflow": "Abrir {workflow} de {repo} en GitHub",
    "rel.wave": "oleada",
    "rel.deploy": "Desplegar →",
    "rel.run.success": "correcto",
    "rel.run.failed": "fallido",
    "rel.run.skipped": "omitido",
    "rel.run.dispatching": "lanzando…",
    "rel.run.queued": "en cola",
    "rel.run.running": "en marcha",
    "rel.noDate": "el servicio indica su commit, no cuándo se desplegó",
    "rel.never": "nunca",
    "rel.dep.title": "Desplegar {repo} → {env}",
    "rel.dep.ref": "Rama / ref",
    "rel.cancel": "Cancelar",
    "rel.dep.go": "Desplegar",
    "rel.hot.drift": "(lo desplegado está {status})",
    "rel.hot":
      "{hotfix}: se despliega la rama {branch}, que no es main, en {prod}{drift}. Esto se salta la norma de solo main en prod — sigue solo si es una corrección urgente.",
    "rel.hot.word": "HOTFIX",
    "rel.prodWord": "PRODUCCIÓN",
    "rel.prodDeploy": "Un despliegue en producción.",
    "rel.typeProd": "Escribe {word} para confirmar",
    "rel.typeBranch":
      "Escribe el nombre de la rama {branch} para confirmar el hotfix",
    "rel.deployHotfix": "Desplegar hotfix →",
    "rel.plan.wave": "Oleada {wave} · {n} repos",
    "rel.plan.wave.one": "Oleada {wave} · {n} repo",
    "rel.all.mainOnly":
      "Desplegar todo en prod solo admite main. Estos usan otra rama: {repos}. Corrige la configuración o usa un hotfix en un repo.",
    "rel.all.prod":
      "Se despliega main de {n} repos en PRODUCCIÓN en {waves} oleadas. Cada oleada debe salir bien antes de la siguiente.",
    "rel.all.prod.one":
      "Se despliega main de {n} repo en PRODUCCIÓN en {waves} oleadas. Cada oleada debe salir bien antes de la siguiente.",
    "rel.all.title": "Desplegar todo → {env}",
    "rel.all.none": "No hay repos activados.",
    "rel.all.hint":
      "Los backends (oleadas más bajas) van primero; la siguiente oleada empieza solo cuando la anterior sale bien (20 s entre lanzamientos).",
    "rel.wave.on": "activo",
    "rel.wave.title": "Reparto en oleadas",
    "rel.wave.col": "Oleada",
    "rel.wave.workflow": "Workflow",
    "rel.wave.enabled": "Activo",
    "rel.wave.hint":
      "Se guarda en tu {mine} (sin commit); el valor compartido de {shared} no cambia. Las oleadas más bajas se despliegan primero.",
    "rel.wave.save": "Guardar (solo para mí)",
    "rel.wave.saveFailed": "No se pudo guardar: {error}",
    "rel.all.label": "todo → {env}",
    "rel.tab": "despliegue {label}",
    "rel.requesting": "solicitando el despliegue {label}",
    "rel.starting": "iniciando {label}…",
    "rel.requestId": "(id de la petición {id})",
    "rel.notStarted": "el despliegue no empezó",
    "rel.startFailed": "No se pudo iniciar el despliegue: {error}",
    "rel.attaching": "conectando con el despliegue…",
    "rel.finished": "despliegue terminado",
    "rel.disconnected":
      "conexión perdida — vuelve a abrir Versiones para reconectar",
    "rel.finishedRechecking": "despliegue terminado — volviendo a comprobar…",
    "rel.busy.any": "Hay una ejecución de CD en curso — espera a que termine",
    "rel.busy.this": "Ya se está desplegando este repo",
    "rel.busy.ext": "Ya hay una ejecución de CD de {repo} → {env} en curso",
    "rel.busy.extUnknown":
      "Hay una ejecución de CD de {repo} en curso; no se sabe su entorno de destino, así que no se puede volver a desplegar",
    // issue 171: a release status line (release-service.ts).
    "rel.st.noBranch": "no se pudo leer la rama {branch}",
    "rel.st.noSource": "? no hay fuente de versión para {env} en {file}",
    "rel.st.versionErr": "✗ endpoint de versión: {error}",
    "rel.st.noRun":
      "? no hay ninguna ejecución de despliegue correcta en {branch}",
    "rel.st.deploymentsErr": "✗ error de la API de despliegues",
    "rel.st.noDeploy":
      "? no hay ningún despliegue correcto de {workflow} en {env}",
    "rel.st.lastFailed":
      "? último despliegue de CD: {state} (ninguno salió bien)",
    "rel.st.runConcl": "✗ ejecución de despliegue: {state} — NO se desplegó",
    "rel.st.newer": "⚠ despliegue más reciente: {state} @ {at}",
    "rel.st.upToDate": "✓ al día",
    "rel.st.compareErr": "✗ desfase (error de la API de comparación)",
    "rel.st.behind": "✗ {n} commits por detrás de {branch}",
    "rel.st.behind.one": "✗ {n} commit por detrás de {branch}",
    "rel.st.off": "⚠ fuera de {branch} ({branch} +{ahead}/-{behind})",
    "rel.st.ahead": "⚠ {n} commits por delante de {branch}",
    "rel.st.ahead.one": "⚠ {n} commit por delante de {branch}",
    "rel.st.drift": "✗ desfase (status={status})",
    "rel.src.version": "endpoint de versión",
    "rel.src.run": "ejecución del workflow",
    "rel.src.deployment": "despliegue de GitHub",
    // issue 171: the View note (view-scope.js, Environments and Release).
    "view.all": "todos los proyectos activos",
    "view.one": "el proyecto {name}",
    "view.note":
      "Muestra {what}, como la Vista de la barra superior. Cámbialo allí.",
  };
})((window.denMessages = window.denMessages || {}));
