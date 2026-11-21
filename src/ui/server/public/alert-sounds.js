/**
 * Issue 774: the two short sounds an open Den tab plays with an alert,
 * when the person turned Sounds on (Settings › Notifications): one for
 * "needs you", a softer one for "finished". They ship with Den: made
 * here with the browser's Web Audio, no file to fetch. A browser plays
 * sound only after the person has used the page once, so the first
 * click or key on the page wakes the audio (primeAlertSounds). Only an
 * open tab plays them: a closed tab or a phone uses its own alert sound.
 */

/** Each sound: its notes (Hz), how long each lasts (s), and its loudness. */
export const ALERT_SOUNDS = {
  needs: { notes: [660, 880], seconds: 0.14, gain: 0.2 },
  finished: { notes: [523], seconds: 0.22, gain: 0.08 },
};

let audio = null;

/** The page's one audio context, or null where there is none. */
function context(win) {
  if (audio) return audio;
  const AC = win.AudioContext || win.webkitAudioContext;
  if (typeof AC !== "function") return null;
  try {
    audio = new AC();
  } catch {
    audio = null;
  }
  return audio;
}

/** Wake the audio on the person's next click or key (a browser's rule). */
export function primeAlertSounds(win = window) {
  const wake = () => {
    try {
      const c = context(win);
      if (c?.state === "suspended") void c.resume();
    } catch {
      /* no sound */
    }
  };
  for (const ev of ["pointerdown", "keydown"])
    win.addEventListener?.(ev, wake, { once: true, capture: true });
}

/** Play sound `kind` ("needs" or "finished"); false when it can't. */
export function playAlertSound(win, kind) {
  const s = ALERT_SOUNDS[kind];
  const c = s && context(win);
  if (!c) return false;
  try {
    if (c.state === "suspended") void c.resume();
    let t = c.currentTime + 0.01;
    for (const hz of s.notes) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(s.gain, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + s.seconds);
      osc.connect(g).connect(c.destination);
      osc.start(t);
      osc.stop(t + s.seconds + 0.02);
      t += s.seconds;
    }
    return true;
  } catch {
    return false;
  }
}
