#!/usr/bin/env node
// Copies the built CharacterCreator assets and the shared web modules into this project.
//
//   node tools/sync_assets.mjs [--source|--src <dir>] [--commit <sha>] [--dry] [--no-anim]
//
// Source: --source / --src, else $CC_SRC, else the sibling folder ../CharacterCreator (relative to this repo).
// The source may be a plain export of a commit instead of a checkout (recommended while someone else is working in
// the repo):  git -C ../CharacterCreator archive <sha> output web | tar -x -C <tmpdir>
// then pass --source <tmpdir> --commit <sha> (an export has no .git, so the commit is recorded from --commit).
// The CharacterCreator repo is only READ. Everything written here is a synced copy:
//   assets/     output/base_body.glb, base_body.joints.json, hair*.glb + hair.json, clothing*.glb + clothing.json,
//               body_colliders.json, asset_licenses.json, output/animations/*.json (skip with --no-anim)
//   vendor/cc/  web/character.js, clothing.js, clothing_rules.js, materials.js, humanoid.js, eyelife.js, breastphysics.js,
//               animation/*.js, cloth/*.js
// Both folders are git-ignored; vendor/cc/SYNCED.json records what was copied (size + sha256, source commit if
// the source is a git checkout). Never edit files in vendor/cc/: the next sync overwrites them.
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const dry = argv.includes('--dry');
const withAnim = !argv.includes('--no-anim');
const commitArg = arg('--commit');
const src = resolve(arg('--source') || arg('--src') || process.env.CC_SRC || join(root, '..', 'CharacterCreator'));

if (!existsSync(join(src, 'web', 'character.js')) || !existsSync(join(src, 'output'))) {
  console.error(`sync: ${src} does not look like the CharacterCreator repo (web/character.js, output/ missing).`);
  console.error('Pass --source <path> or set CC_SRC.');
  process.exit(2);
}

const OUT_ASSETS = join(root, 'assets');
const OUT_VENDOR = join(root, 'vendor', 'cc');

// Required files fail the sync when missing; optional ones are copied when present.
const ASSET_RULES = [
  { re: /^base_body\.glb$/, required: true },
  { re: /^base_body\.joints\.json$/, required: true },
  { re: /^hair\.json$/ },
  { re: /^hair_[\w-]+\.glb$/ },
  { re: /^clothing\.json$/ },
  { re: /^clothing_[\w-]+\.glb$/ },
  { re: /^body_colliders\.json$/ },
  { re: /^asset_licenses\.json$/ },
];
const WEB_FILES = ['character.js', 'clothing.js', 'clothing_rules.js', 'materials.js', 'humanoid.js', 'eyelife.js', 'breastphysics.js'];
const WEB_DIRS = ['animation', 'cloth'];

const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const copied = [];
function copy(from, to) {
  const st = statSync(from);
  copied.push({ file: relative(root, to).replace(/\\/g, '/'), bytes: st.size, sha256: sha(from) });
  if (dry) return;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// ---- assets ----
const outFiles = readdirSync(join(src, 'output')).filter(f => statSync(join(src, 'output', f)).isFile());
for (const rule of ASSET_RULES) {
  const hits = outFiles.filter(f => rule.re.test(f));
  if (!hits.length && rule.required) { console.error(`sync: required asset missing: output/${rule.re.source}`); process.exit(1); }
  for (const f of hits) copy(join(src, 'output', f), join(OUT_ASSETS, f));
}
if (withAnim && existsSync(join(src, 'output', 'animations'))) {
  for (const f of readdirSync(join(src, 'output', 'animations')).filter(f => f.endsWith('.json'))) {
    copy(join(src, 'output', 'animations', f), join(OUT_ASSETS, 'animations', f));
  }
}

// ---- shared web modules (keep their relative layout: humanoid.js imports ./animation/...) ----
if (!dry && existsSync(OUT_VENDOR)) rmSync(OUT_VENDOR, { recursive: true, force: true });   // drop files deleted upstream
for (const f of WEB_FILES) {
  const p = join(src, 'web', f);
  if (existsSync(p)) copy(p, join(OUT_VENDOR, f));
  else console.warn(`sync: web/${f} not found upstream (skipped)`);
}
for (const d of WEB_DIRS) {
  const dir = join(src, 'web', d);
  if (!existsSync(dir)) { console.warn(`sync: web/${d}/ not found upstream (skipped)`); continue; }
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))) copy(join(dir, f), join(OUT_VENDOR, d, f));
}
// Any other plain module in web/ that the synced files import (future splits, e.g. a sex/breast helper).
const importsOf = file => [...readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map(m => m[1]);
const queue = copied.filter(c => c.file.startsWith('vendor/cc/')).map(c => join(root, c.file));
const seen = new Set(queue.map(q => resolve(q)));
while (!dry && queue.length) {
  const f = queue.pop();
  for (const spec of importsOf(f)) {
    const target = resolve(dirname(f), spec);
    if (seen.has(target) || existsSync(target)) { seen.add(target); continue; }
    const upstream = join(src, 'web', relative(OUT_VENDOR, target));
    if (existsSync(upstream)) { copy(upstream, target); seen.add(target); queue.push(target); }
    else console.warn(`sync: ${relative(root, f)} imports ${spec}, not found upstream`);
  }
}

// ---- manifest ----
// The source commit is read from .git/HEAD as a plain file: the sync never runs git in the source repo.
let commit = commitArg || null;
if (!commit) try {
  const head = readFileSync(join(src, '.git', 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    const loose = join(src, '.git', ...ref.split('/'));
    if (existsSync(loose)) commit = readFileSync(loose, 'utf8').trim();
    else {
      const packed = readFileSync(join(src, '.git', 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(` ${ref}`));
      commit = packed ? packed.split(' ')[0] : `${ref} (unresolved)`;
    }
  } else commit = head;
} catch { /* not a git checkout: fine */ }
const manifest = {
  note: 'SYNCED COPIES from the CharacterCreator repo (tools/sync_assets.mjs). Do not edit; re-run the sync instead. '
    + 'sourceCommit is the checked-out commit (or --commit for an exported tree); a checkout may contain uncommitted changes on top of it.',
  sourceKind: existsSync(join(src, '.git')) ? 'checkout' : 'export',
  syncedAt: new Date().toISOString(), sourceCommit: commit,
  files: copied,
};
if (!dry) {
  mkdirSync(OUT_VENDOR, { recursive: true });
  writeFileSync(join(OUT_VENDOR, 'SYNCED.json'), JSON.stringify(manifest, null, 1));
  writeFileSync(join(OUT_ASSETS, 'SYNCED.txt'), 'Synced copies of CharacterCreator/output (tools/sync_assets.mjs). Do not edit.\n');
}
const mb = copied.reduce((s, c) => s + c.bytes, 0) / 1e6;
console.log(`sync: ${copied.length} files, ${mb.toFixed(2)} MB ${dry ? '(dry run)' : 'copied'}; source commit ${commit ?? 'n/a'}`);
