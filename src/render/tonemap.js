// SPDX-License-Identifier: GPL-3.0-or-later
// Pure colour helpers for read-back pixels (src/render/snapshot.js). Unit-tested.

/** Khronos PBR Neutral tone mapping (same constants as three.js' NeutralToneMapping), in place on [r,g,b]. */
export function neutralToneMap(c, exposure = 1) {
  let r = c[0] * exposure, g = c[1] * exposure, b = c[2] * exposure;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, g, b);
  const start = 0.76, desat = 0.15;
  if (peak >= start) {
    const d = 1 - start, newPeak = 1 - (d * d) / (peak + d - start);
    const k = newPeak / peak;
    r *= k; g *= k; b *= k;
    const t = 1 - 1 / (desat * (peak - newPeak) + 1);
    r += (newPeak - r) * t; g += (newPeak - g) * t; b += (newPeak - b) * t;
  }
  c[0] = r; c[1] = g; c[2] = b;
  return c;
}
/** sRGB transfer function (linear 0..1 -> encoded 0..1). */
export const linearToSRGB = u => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
