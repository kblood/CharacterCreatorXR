// Regenerates tests/fixtures/rest_heads.json from the synced sidecar (assets/base_body.joints.json), so the
// node tests do not need the 20 MB of synced assets. Run after `npm run sync` when the upstream rig changes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headsFromSidecar } from '../vendor/cc/animation/rig.js';
import { sliderInfluences, defaultValues, SEXES } from '../vendor/cc/character.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = JSON.parse(readFileSync(join(root, 'assets/base_body.joints.json'), 'utf8'));
const round = heads => Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, v.map(x => +x.toFixed(5))]));
const r = round(headsFromSidecar(sidecar, {}));
// the app's default bodies (defaultValues(): binary sex, male by default)
const bodies = {};
for (const [sex, g] of Object.entries(SEXES)) bodies[sex] = round(headsFromSidecar(sidecar, sliderInfluences({ ...defaultValues(), gender: g })));
mkdirSync(join(root, 'tests/fixtures'), { recursive: true });
writeFileSync(join(root, 'tests/fixtures/rest_heads.json'), JSON.stringify({
  note: 'Rest joint heads (character frame, metres) of the neutral CharacterCreator body (heads; the default male/female bodies in bodies), derived from base_body.joints.json by rig.headsFromSidecar. Regenerate: node tools/make_fixtures.mjs',
  heads: r,
  bodies,
}));
console.log(`rest_heads.json: ${Object.keys(r).length} joints; bodies: ${Object.keys(bodies).join(', ')}`);
