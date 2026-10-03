#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Stages a flat, self-contained static site into build/site/ (or --out <dir>) - LOCAL ONLY.
// This script never uploads or contacts any server; copy the folder to a static HTTPS host yourself.
//
//   node tools/stage_site.mjs [--out <dir>] [--with-dev]
//
// Contents: index.html, src/ (without src/dev unless --with-dev), assets/, vendor/, fixtures/ (replay demo:
// ?replay=fixtures/replay_walk.json) and MANIFEST.json (path, size, sha256). Run `npm run sync` first.
// WebXR needs a secure context: serve it over HTTPS (or http://localhost).
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const out = resolve(root, outArg || 'build/site');
const withDev = argv.includes('--with-dev');

for (const need of ['assets/base_body.glb', 'vendor/cc/character.js']) {
  if (!existsSync(join(root, need))) { console.error(`stage: ${need} missing - run "npm run sync" first.`); process.exit(2); }
}

// safety: only ever clear a folder that is empty or was staged by this script, and never the project itself
if (root.startsWith(out) || (existsSync(out) && readdirSync(out).length && !existsSync(join(out, 'MANIFEST.json')))) {
  console.error(`stage: ${out} is not empty and was not created by stage_site - refusing to overwrite it.`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = [];
function copy(srcRel, dstRel = srcRel) {
  const s = join(root, srcRel), d = join(out, dstRel);
  mkdirSync(dirname(d), { recursive: true });
  copyFileSync(s, d);
  const buf = readFileSync(d);
  files.push({ path: dstRel.split(sep).join('/'), size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
}
function copyDir(rel, skip = () => false) {
  for (const name of readdirSync(join(root, rel))) {
    const r = join(rel, name);
    if (skip(r.split(sep).join('/'))) continue;
    if (statSync(join(root, r)).isDirectory()) copyDir(r, skip); else copy(r);
  }
}

copy('index.html');
copyDir('src', p => !withDev && p === 'src/dev');
copyDir('assets');
copyDir('vendor');
if (existsSync(join(root, 'tests/fixtures/replay_walk.json'))) copy('tests/fixtures/replay_walk.json', 'fixtures/replay_walk.json');

const total = files.reduce((a, f) => a + f.size, 0);
writeFileSync(join(out, 'MANIFEST.json'), JSON.stringify({ staged: new Date().toISOString(), withDev, files }, null, 1));
console.log(`staged ${files.length} files (${(total / 1048576).toFixed(1)} MB) -> ${relative(root, out) || '.'}`);
console.log('Nothing was uploaded. Serve the folder over HTTPS (WebXR requires a secure context).');
if (!withDev) console.log('Note: ?emulate is not available in the staged site (src/dev excluded; use --with-dev).');
