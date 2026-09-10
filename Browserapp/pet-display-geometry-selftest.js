'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { petWindowSize } = require('./pet-config');
const { desktopBoundsForDisplays, recoverPetDisplayPosition } = require('./pet-display-geometry');

const display = (x, y, width, height, workHeight = height) => ({
  bounds: { x, y, width, height }, workArea: { x, y, width, height: workHeight },
});
const primary = display(0, 0, 1920, 1080, 1040);
const left = display(-1600, -200, 1600, 1000, 960);
assert.deepStrictEqual(desktopBoundsForDisplays([primary, left]), { x: -1600, y: -200, width: 3520, height: 1280 });
assert.equal(desktopBoundsForDisplays([]), null);
console.log('PASS multi-monitor desktop bounds preserve negative coordinates');

const size = petWindowSize(1);
const remoteDisplay = display(0, 0, 1280, 720, 680);
const recovered = recoverPetDisplayPosition({ x: 1840, y: 960 }, size, [remoteDisplay], 1.75);
assert(recovered.x >= 0 && recovered.y >= 0);
assert(recovered.x + size.width <= remoteDisplay.workArea.width);
assert(recovered.y + size.height <= remoteDisplay.workArea.height);
assert.deepStrictEqual(recoverPetDisplayPosition({ x: 600, y: 300 }, size, [primary], 1.75), { x: 600, y: 298 });
assert.deepStrictEqual(recoverPetDisplayPosition({ x: 600, y: 250 }, size, [primary], 1.75), { x: 600, y: 250 });
const removedMonitor = recoverPetDisplayPosition({ x: -1100, y: 0 }, size, [primary], 1.75);
assert(removedMonitor.x >= 0 && removedMonitor.y >= 0);
const remainingMonitor = recoverPetDisplayPosition({ x: -1100, y: 0 }, size, [primary, left], 1.75);
assert(remainingMonitor.x < 0, 'a still-connected monitor retains its pet');
const tinyDisplay = display(0, 0, 320, 240);
assert.deepStrictEqual(recoverPetDisplayPosition({ x: 3000, y: 3000 }, size, [tinyDisplay], 1.75), { x: -40, y: -150 });
console.log('PASS remote resolution shrink and monitor removal recover the pet without changing its scale');

// Exercise the production subscription/lifecycle code with synthetic displays;
// no app process, monitor configuration, or real settings are changed.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const first = source.indexOf('function refreshPetDesktopGeometry(win)');
const last = source.indexOf('function updatePetInputPassthrough()', first);
assert(first >= 0 && last > first);
const screen = new EventEmitter();
let displays = [primary];
screen.getAllDisplays = () => displays;
const win = new EventEmitter();
let bounds = { ...primary.bounds };
let resizeCount = 0;
win.isDestroyed = () => false;
win.getBounds = () => ({ ...bounds });
win.setBounds = (next, animate) => { bounds = { ...next }; resizeCount += 1; assert.equal(animate, false); };
const events = [];
const clearedTimers = [];
let dragStops = 0;
let inputUpdates = 0;
const context = vm.createContext({
  screen, console, petWindow: win, desktopBoundsForDisplays, recoverPetDisplayPosition, petWindowSize,
  PET_VIEWPORT_OVERSCAN: 1.75,
  petScalePersistTimer: 1234, petScaleCenterAnchor: { x: 1800, y: 1000 },
  localSettingsCache: { pet: { scale: 1, position: { x: 1840, y: 960 } } },
  clearTimeout: (timer) => clearedTimers.push(timer),
  stopPetDragTracking: () => { dragStops += 1; },
  sendPetEvent: (event) => events.push(JSON.parse(JSON.stringify(event))),
  updatePetInputPassthrough: () => { inputUpdates += 1; },
  saveLocalSettings: () => { throw new Error('display changes must not write settings'); },
});
vm.runInContext(source.slice(first, last), context);
context.watchPetDisplayChanges(win);
displays = [remoteDisplay];
screen.emit('display-metrics-changed', {}, remoteDisplay, ['bounds', 'scaleFactor']);
assert.deepStrictEqual(bounds, remoteDisplay.bounds);
assert.deepStrictEqual(events[0], { type: 'desktop-bounds', desktopBounds: remoteDisplay.bounds, position: recovered, scale: 1 });
assert.equal(context.petScaleCenterAnchor, null);
assert.equal(context.petScalePersistTimer, null);
assert.deepStrictEqual(clearedTimers, [1234]);
assert.equal(dragStops, 1);
assert.equal(inputUpdates, 1);
assert.equal(resizeCount, 1);
screen.emit('display-metrics-changed', {}, remoteDisplay, ['scaleFactor']);
assert.equal(events.length, 2, 'DPI changes refresh renderer coordinates even when DIP bounds stay the same');
assert.equal(resizeCount, 1, 'unchanged native bounds do not force a resize');
screen.emit('display-metrics-changed', {}, remoteDisplay, ['colorDepth']);
assert.equal(events.length, 2);
displays = [primary, left];
screen.emit('display-added', {}, left);
assert.deepStrictEqual(bounds, { x: -1600, y: -200, width: 3520, height: 1280 });
displays = [primary];
screen.emit('display-removed', {}, left);
assert.deepStrictEqual(bounds, primary.bounds);
console.log('PASS production screen events refresh host/renderer geometry and cancel stale gesture state');

const priorCount = events.length;
win.emit('closed');
for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) {
  assert.equal(screen.listenerCount(name), 0, `${name} listener is removed on close`);
  screen.emit(name, {}, primary, ['bounds']);
}
assert.equal(events.length, priorCount);
console.log('PASS closing the pet removes every display listener');
