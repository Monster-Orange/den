/**
 * Issue 963: what each gate setting means, in plain words, for `gate
 * settings` (the Settings page's rows carry their own). One line each, in
 * every language Den speaks.
 */
import type { UiLanguage } from "./browser-container.js";

export type GateSettingKey =
  | "cpu_slots"
  | "cpu_slots_beside_browser"
  | "cpu_slots_beside_release_browser"
  | "local_browser_slots"
  | "cpu_hold_load"
  | "max_start_load"
  | "max_start_wait_minutes"
  | "reap_grace_seconds"
  | "overrun_margin_minutes"
  | "remote_renew_seconds"
  | "remote_lapse_seconds"
  | "remote_max_slots"
  | "remote_max_asks"
  | "priority_max"
  | "priority_pass_limit_minutes"
  | "priority_agents"
  | "priority_runners"
  | "claim_minutes"
  | "mcp_renew_minutes"
  | "mcp_lapse_minutes"
  | "mcp_grace_minutes"
  | "waiter_return_minutes"
  | "box_check_timeout_seconds"
  | "box_recheck_seconds"
  | "browser_requires_container"
  | "class_order"
  | "class_map"
  | "class_windows"
  | "browser_box_default"
  | "browser_host_only"
  | "route_agents"
  | "route_commands";

export const GATE_MEANINGS: Record<
  UiLanguage,
  Record<GateSettingKey, string>
> = {
  en: {
    cpu_slots: "Unit test runs at once on this machine",
    cpu_slots_beside_browser:
      "Unit test runs beside a browser run (0: a browser run runs alone)",
    cpu_slots_beside_release_browser:
      "Unit test runs beside a release browser run (0: it runs alone)",
    local_browser_slots: "Browser test runs at once on this machine",
    cpu_hold_load:
      "Machine load at which unit test runs wait while a release browser run holds (0: off)",
    max_start_load:
      "Machine load (5-minute) at or over which no gate run starts its command; it waits (0: off)",
    max_start_wait_minutes:
      "Minutes a run waits for the load before it starts anyway, recorded as busy (0: no limit)",
    reap_grace_seconds:
      "Seconds between stopping what an ended run left behind and killing it",
    overrun_margin_minutes:
      "Minutes past its estimate before a run is flagged (never stopped)",
    remote_renew_seconds: "Seconds between a CI runner's renewals of its slot",
    remote_lapse_seconds:
      "Seconds without a renewal before a CI runner loses its slot",
    remote_max_slots: "Slots one CI runner may hold or wait for",
    remote_max_asks: "Asks one CI runner may have waiting for an answer",
    priority_max:
      "Release runs ahead of plain runs, per kind (default 1; 0 turns release priority off)",
    priority_pass_limit_minutes:
      "Minutes a waiting release run is protected from another release run (0: never)",
    priority_agents:
      "Who may ask for release priority (1: agents and people; 0: people only)",
    priority_runners:
      "Whether CI runners may ask for release priority (1: yes; 0: no)",
    claim_minutes:
      "Minutes an agent has to claim a slot it waited for, then it goes back in line",
    mcp_renew_minutes:
      "Minutes between an agent's renewals of the slot it holds",
    mcp_lapse_minutes:
      "Minutes without a renewal, past its estimate and grace, before an agent's slot goes to the next",
    mcp_grace_minutes:
      "Minutes past its estimate an unrenewed agent slot still holds",
    waiter_return_minutes:
      "Minutes a waiting run keeps its place in line after it ends, such as in a restart (0: it loses its place at once)",
    box_check_timeout_seconds:
      "Seconds Den waits for a test box to answer (no answer: skipped)",
    box_recheck_seconds:
      "Seconds a held or silent test box is passed over before it is checked again",
    browser_requires_container:
      "Whether browser runs must run in a container (2: yes, and a run may not just say it starts its own; 1: yes; 0: no)",
    class_order: "Priority classes, highest first (empty: first come for all)",
    class_map: "Which projects and labels go in which class",
    class_windows:
      "When each class's long runs may start ahead of a higher class",
    browser_box_default:
      "Where a browser run with no --box goes (any: the first free slot here or on a test box; local: here only)",
    browser_host_only:
      "Projects and label patterns whose browser runs stay on this machine",
    route_agents:
      "Agents' test, typecheck and browser runs go through the gate (1 yes, 0 no: they run as written and are counted)",
    route_commands:
      "The programs Den's agent hook sends through the gate, comma-separated",
  },
  es: {
    cpu_slots: "Ejecuciones de pruebas unitarias a la vez en esta máquina",
    cpu_slots_beside_browser:
      "Pruebas unitarias junto a una de navegador (0: la de navegador va sola)",
    cpu_slots_beside_release_browser:
      "Pruebas unitarias junto a una de navegador de versión (0: va sola)",
    local_browser_slots:
      "Ejecuciones de pruebas de navegador a la vez en esta máquina",
    cpu_hold_load:
      "Carga de la máquina a la que las pruebas unitarias esperan mientras corre una de navegador de versión (0: apagado)",
    max_start_load:
      "Carga de la máquina (5 minutos) a partir de la cual ninguna ejecución empieza su comando; espera (0: desactivado)",
    max_start_wait_minutes:
      "Minutos que una ejecución espera a que baje la carga antes de empezar igualmente, anotada como ocupada (0: sin límite)",
    reap_grace_seconds:
      "Segundos entre detener lo que dejó una ejecución terminada y forzar su cierre",
    overrun_margin_minutes:
      "Minutos pasada su estimación antes de marcar una ejecución (nunca se detiene)",
    remote_renew_seconds:
      "Segundos entre las renovaciones de su turno de un runner de CI",
    remote_lapse_seconds:
      "Segundos sin renovar antes de que un runner de CI pierda su turno",
    remote_max_slots: "Turnos que un runner de CI puede tener o esperar",
    remote_max_asks:
      "Peticiones de un runner de CI que pueden esperar respuesta",
    priority_max:
      "Ejecuciones de versión por delante de las normales, por tipo (por defecto 1; 0 desactiva la prioridad de versión)",
    priority_pass_limit_minutes:
      "Minutos que una ejecución de versión en espera está protegida de otra (0: nunca)",
    priority_agents:
      "Quién puede pedir prioridad de versión (1: agentes y personas; 0: solo personas)",
    priority_runners:
      "Si los runners de CI pueden pedir prioridad de versión (1: sí; 0: no)",
    claim_minutes:
      "Minutos que tiene un agente para tomar el turno que esperaba; si no, vuelve a la cola",
    mcp_renew_minutes:
      "Minutos entre las renovaciones de un agente del turno que tiene",
    mcp_lapse_minutes:
      "Minutos sin renovar, pasada su estimación y el margen, antes de que el turno de un agente pase al siguiente",
    mcp_grace_minutes:
      "Minutos pasada su estimación que aún dura un turno de agente sin renovar",
    waiter_return_minutes:
      "Minutos que una ejecución en espera conserva su lugar en la fila después de terminar, por ejemplo en un reinicio (0: lo pierde al instante)",
    box_check_timeout_seconds:
      "Segundos que Den espera la respuesta de una máquina de pruebas (sin respuesta: se salta)",
    box_recheck_seconds:
      "Segundos que se omite una máquina de pruebas ocupada o muda antes de volver a comprobarla",
    browser_requires_container:
      "Si las pruebas de navegador deben ir en un contenedor (2: sí, y una ejecución no puede solo decir que inicia el suyo; 1: sí; 0: no)",
    class_order:
      "Clases de prioridad, la más alta primero (vacío: por orden de llegada)",
    class_map: "Qué proyectos y etiquetas van en cada clase",
    class_windows:
      "Cuándo las ejecuciones largas de cada clase pueden empezar antes que una clase más alta",
    browser_box_default:
      "Adónde va una prueba de navegador sin --box (any: el primer turno libre aquí o en una máquina de pruebas; local: solo aquí)",
    browser_host_only:
      "Proyectos y patrones de etiqueta cuyas pruebas de navegador se quedan en esta máquina",
    route_agents:
      "Las pruebas, comprobaciones de tipos y pruebas de navegador de los agentes pasan por la cola (1 sí, 0 no: se ejecutan tal cual y se cuentan)",
    route_commands:
      "Los programas que el hook de agentes de Den manda a la cola, separados por comas",
  },
  ja: {
    cpu_slots: "このマシンで同時に動くユニットテストの数",
    cpu_slots_beside_browser:
      "ブラウザテストと並んで動くユニットテストの数（0: ブラウザテストは単独）",
    cpu_slots_beside_release_browser:
      "リリースのブラウザテストと並んで動くユニットテストの数（0: 単独）",
    local_browser_slots: "このマシンで同時に動くブラウザテストの数",
    cpu_hold_load:
      "リリースのブラウザテスト中、ユニットテストを待たせるマシン負荷 (0: オフ)",
    max_start_load:
      "この負荷 (5 分平均) 以上ではゲートの実行はコマンドを始めずに待ちます (0: オフ)",
    max_start_wait_minutes:
      "負荷が下がるのを待つ分数。過ぎると混雑中として記録して開始します (0: 制限なし)",
    reap_grace_seconds:
      "終了した実行が残したプロセスを止めてから強制終了するまでの秒数",
    overrun_margin_minutes:
      "見積もりを何分過ぎたら印を付けるか（止めはしない）",
    remote_renew_seconds: "CI ランナーが枠を更新する間隔（秒）",
    remote_lapse_seconds: "更新がないまま何秒で CI ランナーが枠を失うか",
    remote_max_slots: "1 つの CI ランナーが持つか待てる枠の数",
    remote_max_asks: "1 つの CI ランナーが返事を待てる依頼の数",
    priority_max:
      "種類ごとに通常の実行より先に進むリリース実行の数（既定 1、0 でリリース優先がオフ）",
    priority_pass_limit_minutes:
      "待っているリリース実行が別のリリース実行に追い越されない時間（分、0: なし）",
    priority_agents:
      "リリース優先を頼めるのは誰か（1: エージェントと人、0: 人だけ）",
    priority_runners:
      "CI ランナーがリリース優先を頼めるか（1: はい、0: いいえ）",
    claim_minutes:
      "待っていた枠をエージェントが受け取るまでの時間（分）。過ぎると列に戻る",
    mcp_renew_minutes: "エージェントが持っている枠を更新する間隔（分）",
    mcp_lapse_minutes:
      "見積もりと猶予を過ぎて更新がないまま何分でエージェントの枠が次に移るか",
    mcp_grace_minutes:
      "更新のないエージェントの枠が見積もりを過ぎても保たれる時間（分）",
    waiter_return_minutes:
      "待っている実行が再起動などで終わったあと、列の順番を何分保つか（0: すぐに失う）",
    box_check_timeout_seconds:
      "Den がテスト用マシンの返事を待つ時間（秒、返事がなければ飛ばす）",
    box_recheck_seconds:
      "使用中か返事のないテスト用マシンを次に確かめるまで飛ばす時間（秒）",
    browser_requires_container:
      "ブラウザテストをコンテナで動かす必要があるか（2: はい、実行が自分で起動すると言うだけでは不可、1: はい、0: いいえ）",
    class_order: "優先クラス、高い順（空: すべて先着順）",
    class_map: "どのプロジェクトとラベルがどのクラスに入るか",
    class_windows: "各クラスの長い実行が上のクラスより先に始められる時間帯",
    browser_box_default:
      "--box のないブラウザテストの行き先（any: ここかテスト用マシンの先に空いた枠、local: ここだけ）",
    browser_host_only:
      "ブラウザテストをこのマシンに残すプロジェクトとラベルのパターン",
    route_agents:
      "エージェントのテスト、型チェック、ブラウザテストを順番待ちに通す（1 はい、0 いいえ: そのまま実行して数える）",
    route_commands:
      "Den のエージェント用フックが順番待ちに通すプログラム（カンマ区切り）",
  },
};

/** Issue 963: the warning before release priority is turned off. */
export const PRIORITY_OFF_WARNING: Record<UiLanguage, string> = {
  en: "priority_max 0 turns release priority off for every repo on this machine: a release run then waits behind plain runs. To go ahead, run it again with --yes.",
  es: "priority_max 0 desactiva la prioridad de versión para todos los repositorios de esta máquina: una ejecución de versión espera entonces detrás de las normales. Para seguir, ejecútalo de nuevo con --yes.",
  ja: "priority_max 0 は、このマシンのすべてのリポジトリでリリース優先をオフにします。リリース実行は通常の実行の後ろで待つことになります。続けるには --yes を付けてもう一度実行してください。",
};

/** Issue 963: `gate status`'s last line while release priority is off. */
export const PRIORITY_OFF_STATUS: Record<UiLanguage, string> = {
  en: "release priority: off (priority_max 0)",
  es: "prioridad de versión: desactivada (priority_max 0)",
  ja: "リリース優先: オフ (priority_max 0)",
};

/** Issue 963: a release ask while release priority is off. */
export const PRIORITY_OFF_RUN: Record<UiLanguage, string> = {
  en: "taken as an ordinary run: release priority is off on this machine (priority_max 0)",
  es: "se toma como una ejecución normal: la prioridad de versión está desactivada en esta máquina (priority_max 0)",
  ja: "通常の実行として扱います: このマシンではリリース優先がオフです (priority_max 0)",
};

/**
 * Issue 867: the lines about a place kept for a waiting run whose run is
 * gone (a restart): taken back, let go, and kept until when.
 */
export const KEPT_PLACE_WORDS: Record<
  UiLanguage,
  {
    back: (id: string, asked: string) => string;
    letGo: (asked: string, at: string, minutes: number) => string;
    kept: (until: string) => string;
  }
> = {
  en: {
    back: (id, asked) => `back in your place (${id}), asked at ${asked}`,
    letGo: (asked, at, m) =>
      `your earlier place (asked ${asked}) was let go at ${at}: its run was gone for ${m} min`,
    kept: (until) => `run gone, place kept until ${until}`,
  },
  es: {
    back: (id, asked) => `de vuelta en tu lugar (${id}), pedido a las ${asked}`,
    letGo: (asked, at, m) =>
      `tu lugar anterior (pedido a las ${asked}) se liberó a las ${at}: su ejecución estuvo ausente ${m} min`,
    kept: (until) => `ejecución ausente, lugar guardado hasta las ${until}`,
  },
  ja: {
    back: (id, asked) => `元の順番に戻りました (${id})、${asked} に依頼`,
    letGo: (asked, at, m) =>
      `以前の順番（${asked} に依頼）は ${at} に手放されました: 実行が ${m} 分なかったため`,
    kept: (until) => `実行なし、${until} まで順番を保持`,
  },
};

/** Issue 1132: a run held by the start ceiling, for gate status and run. */
export const START_HOLD_WORDS: Record<
  UiLanguage,
  (load: number, limit: number) => string
> = {
  en: (load, limit) => `waiting for the load (${load}) to drop under ${limit}`,
  es: (load, limit) => `esperando a que la carga (${load}) baje de ${limit}`,
  ja: (load, limit) =>
    `負荷 (${load}) が ${limit} 未満に下がるのを待っています`,
};

/** Issue 1132: what was stopped of an ended run, for gate status. */
export const LEFTOVER_WORDS: Record<
  UiLanguage,
  (n: number, label: string, cmd: string) => string
> = {
  en: (n, label, cmd) =>
    `stopped ${n} leftover process${n === 1 ? "" : "es"} of ${label} (${cmd})`,
  es: (n, label, cmd) =>
    `${n === 1 ? "se detuvo 1 proceso sobrante" : `se detuvieron ${n} procesos sobrantes`} de ${label} (${cmd})`,
  ja: (n, label, cmd) =>
    `${label} (${cmd}) の残りのプロセス ${n} 個を止めました`,
};
