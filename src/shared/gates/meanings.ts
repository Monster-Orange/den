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
  | "box_check_timeout_seconds"
  | "box_recheck_seconds"
  | "browser_requires_container"
  | "class_order"
  | "class_map"
  | "class_windows"
  | "browser_box_default"
  | "browser_host_only";

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
    box_check_timeout_seconds:
      "Seconds Den waits for a test box to answer (no answer: skipped)",
    box_recheck_seconds:
      "Seconds a held or silent test box is passed over before it is checked again",
    browser_requires_container:
      "Whether browser runs must run in a container (1: yes; 0: no)",
    class_order: "Priority classes, highest first (empty: first come for all)",
    class_map: "Which projects and labels go in which class",
    class_windows:
      "When each class's long runs may start ahead of a higher class",
    browser_box_default:
      "Where a browser run with no --box goes (any: the first free slot here or on a test box; local: here only)",
    browser_host_only:
      "Projects and label patterns whose browser runs stay on this machine",
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
    box_check_timeout_seconds:
      "Segundos que Den espera la respuesta de una máquina de pruebas (sin respuesta: se salta)",
    box_recheck_seconds:
      "Segundos que se omite una máquina de pruebas ocupada o muda antes de volver a comprobarla",
    browser_requires_container:
      "Si las pruebas de navegador deben ir en un contenedor (1: sí; 0: no)",
    class_order:
      "Clases de prioridad, la más alta primero (vacío: por orden de llegada)",
    class_map: "Qué proyectos y etiquetas van en cada clase",
    class_windows:
      "Cuándo las ejecuciones largas de cada clase pueden empezar antes que una clase más alta",
    browser_box_default:
      "Adónde va una prueba de navegador sin --box (any: el primer turno libre aquí o en una máquina de pruebas; local: solo aquí)",
    browser_host_only:
      "Proyectos y patrones de etiqueta cuyas pruebas de navegador se quedan en esta máquina",
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
    box_check_timeout_seconds:
      "Den がテスト用マシンの返事を待つ時間（秒、返事がなければ飛ばす）",
    box_recheck_seconds:
      "使用中か返事のないテスト用マシンを次に確かめるまで飛ばす時間（秒）",
    browser_requires_container:
      "ブラウザテストをコンテナで動かす必要があるか（1: はい、0: いいえ）",
    class_order: "優先クラス、高い順（空: すべて先着順）",
    class_map: "どのプロジェクトとラベルがどのクラスに入るか",
    class_windows: "各クラスの長い実行が上のクラスより先に始められる時間帯",
    browser_box_default:
      "--box のないブラウザテストの行き先（any: ここかテスト用マシンの先に空いた枠、local: ここだけ）",
    browser_host_only:
      "ブラウザテストをこのマシンに残すプロジェクトとラベルのパターン",
  },
};

/** Issue 963: the warning before release priority is turned off. */
export const PRIORITY_OFF_WARNING: Record<UiLanguage, string> = {
  en: "priority_max 0 turns release priority off for every repo on this machine: a release run then waits behind plain runs. To go ahead, run it again with --yes.",
  es: "priority_max 0 desactiva la prioridad de versión para todos los repositorios de esta máquina: una ejecución de versión espera entonces detrás de las normales. Para seguir, ejecútalo de nuevo con --yes.",
  ja: "priority_max 0 は、このマシンのすべてのリポジトリでリリース優先をオフにします。リリース実行は通常の実行の後ろで待つことになります。続けるには --yes を付けてもう一度実行してください。",
};
