let ctx: AudioContext | null = null;

/** Distinct success (rising two-tone) and denial (low double buzz) sounds. Silent if audio is unavailable. */
export function beep(kind: 'grant' | 'deny', muted = false): void {
  if (muted || typeof AudioContext === 'undefined') return;
  try {
    ctx ??= new AudioContext();
    const notes: [number, number, number][] = kind === 'grant' ? [[880, 0, 0.12], [1320, 0.13, 0.16]] : [[200, 0, 0.18], [160, 0.22, 0.28]];
    for (const [freq, start, dur] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'grant' ? 'sine' : 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur + 0.02);
    }
  } catch {
    /* audio is a nicety, never a dependency */
  }
}
