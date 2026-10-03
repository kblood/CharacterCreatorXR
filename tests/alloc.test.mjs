// SPDX-License-Identifier: GPL-3.0-or-later
// Allocation / time regression guard for the IK solver: runs tools/bench_ik.mjs in a child process (its own
// heap and JIT state) and checks the bytes allocated per solve. The pre-rewrite solver allocated ~153 KB per
// solve; the pooled rewrite ~4 KB (residual double boxing in the JIT, see docs/IK.md "Performance").
// Node numbers are not representative of a headset; this only catches regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bench = fileURLToPath(new URL('../tools/bench_ik.mjs', import.meta.url));

test('IK solve allocates < 16 KB per frame and stays finite in time (child process bench)', () => {
  const out = execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=128', '--max-semi-space-size=128', bench, '--json', '--frames', '1200'], { encoding: 'utf8', timeout: 120000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.ok(Number.isFinite(r.msPerSolve) && r.msPerSolve > 0, `ms ${r.msPerSolve}`);
  const bytes = r.sampledBytesPerSolve ?? r.bytesPerSolve;
  assert.ok(bytes != null, 'allocation measured');
  assert.ok(bytes < 16384, `allocated ${bytes} B per solve`);
});
