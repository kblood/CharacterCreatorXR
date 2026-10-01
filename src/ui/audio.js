// Optional UI click sound (WebAudio, synthesized: no audio files). The AudioContext is created / resumed on the
// first user gesture (the Enter VR click or a desktop click); before that, clicks are silent.
export function createClicker() {
  let ctx = null;
  const ensure = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { ctx = null; }
    return ctx;
  };
  return {
    unlock: ensure,
    /** kind: 'click' | 'toggle' | 'error' | 'shutter' */
    play(kind = 'click', gain = 0.12) {
      const c = ensure();
      if (!c || c.state !== 'running') return false;
      const t = c.currentTime, g = c.createGain(), o = c.createOscillator();
      const f = kind === 'error' ? 220 : kind === 'toggle' ? 1180 : kind === 'shutter' ? 2400 : 880;
      o.type = kind === 'shutter' ? 'square' : 'triangle';
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.05);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'shutter' ? 0.12 : 0.06));
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.15);
      return true;
    },
  };
}
