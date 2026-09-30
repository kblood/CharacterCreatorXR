// Replay (?replay=fixture.json) and recording of tracking records (src/xr/tracking.js format). A fixture is
// { version: 1, name, note, frames: [record, ...] } with record.t in seconds. The player interpolates positions
// and slerps rotations between frames, so a fixture recorded at any rate plays at any frame rate. Finger data
// travels as gamepad/joint snapshots, so the same finger input layer runs on replays. Also used by the node
// regression tests (tests/replay.test.mjs).
import { qSlerp, vLerp } from './ik/qx.js';

const lerpPose = (a, b, u) => (a && b ? { pos: vLerp(a.pos, b.pos, u), quat: qSlerp(a.quat, b.quat, u) } : (u < 0.5 ? a : b));

export function sampleFixture(fx, t, loop = true) {
  const F = fx.frames;
  if (!F?.length) return null;
  const T = F[F.length - 1].t;
  if (loop && T > 0) t = ((t % T) + T) % T;
  let i = 0;
  while (i + 1 < F.length && F[i + 1].t <= t) i++;
  const a = F[i], b = F[Math.min(i + 1, F.length - 1)];
  const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const hands = {};
  for (const s of ['left', 'right']) {
    const ha = a.hands?.[s], hb = b.hands?.[s];
    if (ha?.valid && hb?.valid) hands[s] = { ...lerpPose(ha, hb, u), valid: true, kind: ha.kind };
    else hands[s] = (u < 0.5 ? ha : hb) || { valid: false };
  }
  // snapshots are discrete (buttons/joints): take the nearer frame, but interpolate joint positions
  const nearer = u < 0.5 ? a : b;
  const snaps = (nearer.snaps || []).map(sn => {
    const other = (u < 0.5 ? b : a).snaps?.find(x => x.handedness === sn.handedness);
    if (!sn.joints || !other?.joints) return sn;
    const w = u < 0.5 ? u : 1 - u, joints = {};
    for (const k of Object.keys(sn.joints)) joints[k] = other.joints[k] ? vLerp(sn.joints[k], other.joints[k], w) : sn.joints[k];
    return { ...sn, joints };
  });
  return { t, head: lerpPose(a.head, b.head, u), eyes: null, hands, snaps, sources: nearer.sources || [], desktopCurls: nearer.desktopCurls };
}

export function createRecorder({ maxSeconds = 60 } = {}) {
  let frames = [], on = false, t0 = 0;
  const round = v => (Array.isArray(v) ? v.map(round) : typeof v === 'number' ? +v.toFixed(5) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
  return {
    get recording() { return on; },
    get frames() { return frames.length; },
    start() { frames = []; on = true; t0 = null; },
    stop() { on = false; },
    push(rec) {
      if (!on || !rec) return;
      if (t0 == null) t0 = rec.t;
      const t = rec.t - t0;
      if (t > maxSeconds) { on = false; return; }
      const { eyes, ...r } = rec;
      frames.push(round({ ...r, t }));
    },
    fixture(name = 'recording') {
      return { version: 1, name, note: 'recorded with CharacterCreator XR (tracking records, src/xr/tracking.js)', frames };
    },
  };
}
