'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PET_PHASES,
  PET_MOTION_MODES,
  PET_MOTIONS,
  DEFAULT_PET_CONFIG,
  normalizePetConfig,
  petWindowSize,
} = require('./pet-config');

const root = __dirname;
const assets = path.join(root, 'assets', 'pets');
const petIds = fs.readdirSync(assets).filter((name) => fs.existsSync(path.join(assets, name, 'pet.json'))).sort();
assert.deepStrictEqual(petIds, [
  'mmd-bianca', 'mmd-bianca-saint', 'mmd-emden', 'mmd-lilith', 'mmd-odette',
  'mmd-qingxiao', 'mmd-robin', 'mmd-thoth-black', 'mmd-thoth-white',
]);
assert.strictEqual(PET_PHASES.length, 7);
assert.deepStrictEqual(PET_MOTION_MODES.map(({ id }) => id), ['by-state', 'all-shuffle', 'all-random-once']);
assert.deepStrictEqual(PET_MOTION_MODES.map(({ label }) => label), ['按状态', '任意状态随机循环', '任意状态随机']);
assert.strictEqual(PET_MOTIONS.length, 12);
assert.strictEqual(new Set(PET_MOTIONS.map((motion) => motion.id)).size, 12);

for (const petId of petIds) {
  const petRoot = path.join(assets, petId);
  const manifest = JSON.parse(fs.readFileSync(path.join(petRoot, 'pet.json'), 'utf8'));
  assert.strictEqual(manifest.renderer, 'mmd3d');
  const localAsset = (relative) => {
    assert.ok(!path.isAbsolute(relative) && !/^https?:/i.test(relative), `${petId}: asset must be local: ${relative}`);
    const resolved = path.resolve(petRoot, relative);
    assert.ok(resolved.startsWith(path.resolve(petRoot) + path.sep), `${petId}: asset escaped pet folder: ${relative}`);
    assert.ok(fs.existsSync(resolved), `${petId}: asset exists: ${relative}`);
  };
  localAsset(manifest.mmd3d.model);
  for (const file of manifest.mmd3d.files || []) localAsset(file);
  for (const motion of PET_MOTIONS) {
    const clip = manifest.mmd3d.motionSets?.[motion.phase]?.[motion.index];
    assert.ok(clip, `${petId}: ${motion.id}`);
    for (const file of clip.files) localAsset(file);
    if (motion.maxEndFrame) assert.ok(Math.min(clip.endFrame, motion.maxEndFrame) <= 450, `${motion.id}: 15 second trim`);
  }
  if (manifest.mmd3d.model.endsWith('.pmx')) assert.strictEqual(manifest.mmd3d.physics, true, `${petId}: PMX physics`);
  if (manifest.mmd3d.model.endsWith('.glb')) assert.ok(manifest.mmd3d.secondaryMotion, `${petId}: humanoid secondary motion`);
}

for (const runtime of ['mmd-pmx-vendor.js', 'mmd-humanoid-vendor.js', 'mmd-bullet.wasm']) {
  assert.ok(fs.statSync(path.join(root, 'pet-runtime', runtime)).size > 1000, `${runtime}: bundled`);
}
for (const vendorFile of ['mmd-pmx-vendor.js', 'mmd-humanoid-vendor.js']) {
  const vendor = fs.readFileSync(path.join(root, 'pet-runtime', vendorFile), 'utf8');
  assert.ok(vendor.includes('mode===`all-shuffle`'), `${vendorFile}: all-motion shuffled loop policy`);
  assert.ok(vendor.includes('mode===`all-random-once`'), `${vendorFile}: all-motion random-once policy`);
  assert.ok(vendor.includes('mode:`by-state`'), `${vendorFile}: by-state policy`);
  assert.ok(vendor.includes('mode!==`by-state`'), `${vendorFile}: non-state modes use all motions`);
  assert.ok(vendor.includes('return e?void 0:'), `${vendorFile}: random-once does not continue after completion`);
  assert.ok(vendor.includes('_stabilizePetVisuals(),c.render()'), `${vendorFile}: visual stability guard`);
  assert.ok(!vendor.includes('setMoving(e){'), `${vendorFile}: render loop stays live while moving`);
  assert.ok(!vendor.includes('t.isHat&&'), `${vendorFile}: no hat-specific material override`);
  assert.ok(vendor.includes('overrideMaterialSideOrientation=2'), `${vendorFile}: double-sided mesh guard`);
  assert.ok(vendor.includes('(t.viewportOverscan??1)'), `${vendorFile}: expanded camera framing`);
}
const pmxVendor = fs.readFileSync(path.join(root, 'pet-runtime', 'mmd-pmx-vendor.js'), 'utf8');
assert.ok(pmxVendor.includes('./pet-runtime/mmd-bullet.wasm'));
assert.ok(!pmxVendor.includes('/api/pet/runtime/mmd-bullet.wasm'));
const petHtml = fs.readFileSync(path.join(root, 'pet.html'), 'utf8');
assert.ok(petHtml.includes("connect-src 'self' file: data: blob:"), 'pet CSP only permits local data connections');
assert.ok(!petHtml.includes('https:'), 'pet document does not permit remote resources');

const normalized = normalizePetConfig({
  enabled: true,
  petId: 'missing',
  mode: 'all-random-once',
  scale: 99,
  assignments: { idle: ['tool:produce-101', 'tool:produce-101'] },
}, petIds);
assert.strictEqual(normalized.petId, DEFAULT_PET_CONFIG.petId);
assert.strictEqual(normalized.mode, 'all-random-once');
assert.strictEqual(normalized.scale, 1.6);
assert.deepStrictEqual(normalized.assignments.idle, ['tool:produce-101']);
assert.deepStrictEqual(petWindowSize(1), { width: 400, height: 540 });
assert.deepStrictEqual(petWindowSize(0.25), { width: 100, height: 135 });
assert.strictEqual(normalizePetConfig({ mode: 'shuffle' }, petIds).mode, 'all-shuffle');
assert.strictEqual(normalizePetConfig({ mode: 'ordered-random' }, petIds).mode, 'by-state');
assert.strictEqual(normalizePetConfig({ mode: 'all-shuffle', scale: -1 }, petIds).scale, 0.25);

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
for (const required of [
  "transparent: true", "alwaysOnTop: true", "win.setAlwaysOnTop(true, 'screen-saver', 1)",
  "skipTaskbar: true", "registerTrustedIpc('pet:settings:set'", "setVisibleOnAllWorkspaces",
  'screen.getCursorScreenPoint()',
  'setIgnoreMouseEvents(ignored, { forward: false })',
  'viewportOverscan: PET_VIEWPORT_OVERSCAN',
  'const PET_VIEWPORT_OVERSCAN = 1.75',
]) assert.ok(mainSource.includes(required), required);
const inputPassthroughSource = mainSource.slice(
  mainSource.indexOf('function updatePetInputPassthrough()'),
  mainSource.indexOf('function startPetInputPassthrough()')
);
assert.ok(inputPassthroughSource.includes('petWindowSize(localSettingsCache.pet.scale)'), 'input uses initial pet bounds');
assert.ok(!inputPassthroughSource.includes('PET_VIEWPORT_OVERSCAN'), 'expanded action area remains click-through');

const petRendererSource = fs.readFileSync(path.join(root, 'pet-renderer.js'), 'utf8');
const petCssSource = fs.readFileSync(path.join(root, 'pet.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(!petRendererSource.includes('setMoving?.'), 'dragging must not pause the WebGL renderer');
assert.ok(petRendererSource.includes("event?.type === 'scale'"), 'renderer receives live scale targets');
assert.ok(petRendererSource.includes('const PET_VIEWPORT_OVERSCAN = 1.75'), 'renderer expands action viewport');
assert.ok(petCssSource.includes('transition: transform 180ms'), 'model scaling is GPU-composited');
assert.ok(petCssSource.includes('overflow: visible'), 'expanded action viewport is not clipped');
assert.ok(petCssSource.includes('contain: layout style size'), 'stage does not apply paint containment');
assert.ok(!petCssSource.includes('contain: strict'), 'stage does not clip overflowing action frames');
assert.ok(petCssSource.includes('body { cursor: default; }'), 'desktop passthrough keeps the system cursor');
assert.ok(petCssSource.includes('#pet-hitbox'), 'input cursor is restricted to the initial pet bounds');
assert.ok(petCssSource.includes('pointer-events: none'), 'render stage does not intercept desktop input');
assert.ok(!petCssSource.includes('body { cursor: grab; }'), 'whole desktop never receives the pet cursor');
for (const label of ['按状态', '任意状态随机循环', '任意状态随机']) assert.ok(indexSource.includes(label), label);
assert.ok(!indexSource.includes('有序随机循环从随机起点'), 'settings do not include mode behavior descriptions');

const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
for (const required of ['pet-motion-multiselect', "getElementById('pet-motion-mode')", '每个状态至少保留一个动作']) {
  assert.ok(rendererSource.includes(required), required);
}

console.log(`pet-selftest: ok (${petIds.length} pets, ${PET_MOTIONS.length} motions)`);
