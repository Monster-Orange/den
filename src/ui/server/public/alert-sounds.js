export const ALERT_SOUNDS = {
  needs: { notes: [660, 880], seconds: 0.14, gain: 0.2 },
  finished: { notes: [523], seconds: 0.22, gain: 0.08 },
};

let audio = null;

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
