/**
 * UK-2: the working pop-up's shared words (Settled 9), in every language
 * the kit speaks. Each product registers its own actions' words (working,
 * success, failure) with registerActions; a product may add or override a
 * shared key through configureBusy({ words }).
 */
export const BUSY_WORDS = {
  en: {
    wait: "Waiting for {who}…",
    still: "Still working ({s} s). You can leave this open.",
    still_running: "Still running. Check the page, then check again.",
    done: "Done",
    close: "Close",
    retry: "Try again",
    check: "Check again",
    report: "Report",
    details: "Details",
    log: "Open the log",
    noans_t: "No answer from {who} yet.",
    noans_b: "It may still finish. Check the page before you try again.",
    noans_unknown:
      "{who} has no record of this request any more. Check the page before you try again.",
    err_code: "{who} answered with an error ({code}).",
    network: "Couldn't reach {who}.",
  },
  es: {
    wait: "Esperando a {who}…",
    still: "Sigue trabajando ({s} s). Puedes dejar esto abierto.",
    still_running: "Sigue en curso. Revisa la página y vuelve a comprobar.",
    done: "Listo",
    close: "Cerrar",
    retry: "Intentar de nuevo",
    check: "Volver a comprobar",
    report: "Informar",
    details: "Detalles",
    log: "Abrir el registro",
    noans_t: "{who} aún no responde.",
    noans_b:
      "Puede que aún termine. Revisa la página antes de intentarlo de nuevo.",
    noans_unknown:
      "{who} ya no tiene registro de esta solicitud. Revisa la página antes de intentarlo de nuevo.",
    err_code: "{who} respondió con un error ({code}).",
    network: "No se pudo contactar con {who}.",
  },
  ja: {
    wait: "{who} の応答を待っています…",
    still: "処理中です({s} 秒)。このまま開いておけます。",
    still_running:
      "まだ処理中です。ページを確認してから、もう一度確認してください。",
    done: "完了",
    close: "閉じる",
    retry: "もう一度試す",
    check: "もう一度確認",
    report: "報告",
    details: "詳細",
    log: "ログを開く",
    noans_t: "{who} からまだ応答がありません。",
    noans_b:
      "まだ完了する可能性があります。もう一度試す前にページを確認してください。",
    noans_unknown:
      "{who} にこのリクエストの記録がもうありません。もう一度試す前にページを確認してください。",
    err_code: "{who} がエラーを返しました({code})。",
    network: "{who} に接続できませんでした。",
  },
};
