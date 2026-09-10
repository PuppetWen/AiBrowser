'use strict';

const stage = document.getElementById('pet-stage');
const hitbox = document.getElementById('pet-hitbox');
const status = document.getElementById('pet-status');
let snapshot = null;
let handle = null;
let activeAbortController = null;
let loadEpoch = 0;
let currentPetId = '';
let currentPhase = 'waiting';
let leftDragging = false;
let rightDragging = false;
let lastPointer = null;
let dragEndedAt = 0;
const loadedVendors = new Map();
const debugState = {
  modelReady: false,
  modelError: '',
  phase: currentPhase,
  petId: '',
  motionMode: 'by-state',
  orbitEvents: 0,
  wheelEvents: 0,
  configEvents: 0,
  visualScale: 1,
  visualPosition: null,
};

const PET_HOST_SCALE = 1.6;
const PET_VIEWPORT_OVERSCAN = 1.75;
const PET_HOST_WIDTH = 640;
const PET_HOST_HEIGHT = 864;

function applyVisualLayout() {
  const config = snapshot?.config;
  const desktop = snapshot?.desktopBounds;
  if (!config?.position || !desktop) return;
  const width = Math.round(400 * config.scale);
  const height = Math.round(540 * config.scale);
  const offsetX = Math.round((PET_HOST_WIDTH - width) / 2);
  const offsetY = Math.round((PET_HOST_HEIGHT - height) / 2);
  const hostX = Math.round(config.position.x - desktop.x - offsetX);
  const hostY = Math.round(config.position.y - desktop.y - offsetY);
  stage.style.setProperty('--pet-host-x', `${hostX}px`);
  stage.style.setProperty('--pet-host-y', `${hostY}px`);
  hitbox.style.setProperty('--pet-input-x', `${Math.round(config.position.x - desktop.x)}px`);
  hitbox.style.setProperty('--pet-input-y', `${Math.round(config.position.y - desktop.y)}px`);
  hitbox.style.width = `${width}px`;
  hitbox.style.height = `${height}px`;
  debugState.visualPosition = { ...config.position };
}

function applyVisualScale(scale) {
  const normalized = Math.max(0.25, Math.min(PET_HOST_SCALE, Number(scale) || 1));
  stage.style.setProperty('--pet-visual-scale', String(normalized / PET_HOST_SCALE * PET_VIEWPORT_OVERSCAN));
  debugState.visualScale = normalized;
  applyVisualLayout();
}

function reportState(extra = {}) {
  Object.assign(debugState, extra);
  window.desktopPet.rendererState({ ...debugState });
}

function showStatus(message) {
  status.textContent = message;
  status.hidden = false;
}

function hideStatus() {
  status.hidden = true;
}

function injectScript(src) {
  if (loadedVendors.has(src)) return loadedVendors.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`无法加载 3D 运行时：${src}`));
    document.head.appendChild(script);
  });
  loadedVendors.set(src, promise);
  return promise;
}

function motionPolicy(config) {
  return {
    mode: config.mode,
    assignments: config.assignments || {},
  };
}

async function mountPet() {
  const epoch = ++loadEpoch;
  activeAbortController?.abort();
  const abortController = new AbortController();
  activeAbortController = abortController;
  handle?.dispose();
  handle = null;
  stage.replaceChildren();
  debugState.modelReady = false;
  debugState.modelError = '';
  const config = snapshot?.config;
  const pet = snapshot?.pets?.find((item) => item.id === config?.petId);
  if (!config || !pet) {
    showStatus('未找到可用的 3D 宠物');
    reportState({ modelError: 'pet-missing' });
    return;
  }
  currentPetId = pet.id;
  reportState({ petId: pet.id, motionMode: config.mode, modelReady: false, modelError: '' });
  showStatus(`正在加载 ${pet.displayName}…`);
  try {
    await injectScript(pet.vendorScript);
    if (epoch !== loadEpoch) return;
    const vendor = pet.runtime.modelKind === 'humanoid'
      ? window.__dshPetMmdHumanoid
      : window.__dshPetMmdPmx;
    if (!vendor?.mount) throw new Error('3D 运行时未注册');
    const mounted = await vendor.mount(stage, pet.runtime, currentPhase, {
      onVisualReady() {
        if (epoch !== loadEpoch) return;
        hideStatus();
      },
    }, abortController.signal);
    if (epoch !== loadEpoch) {
      mounted.dispose();
      return;
    }
    handle = mounted;
    handle.setMotionPolicy(motionPolicy(config));
    hideStatus();
    reportState({ modelReady: true, modelError: '' });
  } catch (error) {
    if (epoch !== loadEpoch || abortController.signal.aborted) return;
    const message = String(error?.message || error || '未知错误');
    showStatus(`3D 宠物加载失败：${message}`);
    reportState({ modelReady: false, modelError: message });
  }
}

function applyConfig(config) {
  if (!snapshot) return;
  const previousPetId = snapshot.config?.petId;
  snapshot.config = config;
  debugState.configEvents += 1;
  applyVisualScale(config.scale);
  reportState({ motionMode: config.mode });
  if (previousPetId !== config.petId || currentPetId !== config.petId) {
    void mountPet();
    return;
  }
  handle?.setMotionPolicy(motionPolicy(config));
}

hitbox.addEventListener('pointerdown', (event) => {
  if (snapshot?.selftest && event.isTrusted) return;
  if (event.button === 0) {
    leftDragging = true;
    document.body.classList.add('dragging');
    void window.desktopPet.beginDrag({ screenX: event.screenX, screenY: event.screenY });
  } else if (event.button === 2) {
    rightDragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
  } else {
    return;
  }
  try { hitbox.setPointerCapture(event.pointerId); } catch (_) {}
  event.preventDefault();
});

hitbox.addEventListener('pointermove', (event) => {
  if (rightDragging && lastPointer) {
    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
    handle?.orbit(dx, dy);
    debugState.orbitEvents += 1;
    reportState();
  }
});

function finishPointer(event) {
  if (leftDragging) void window.desktopPet.endDrag();
  if (leftDragging) {
    dragEndedAt = performance.now();
  }
  leftDragging = false;
  rightDragging = false;
  lastPointer = null;
  document.body.classList.remove('dragging');
  try { hitbox.releasePointerCapture(event.pointerId); } catch (_) {}
}

hitbox.addEventListener('pointerup', finishPointer);
hitbox.addEventListener('pointercancel', finishPointer);
hitbox.addEventListener('contextmenu', (event) => event.preventDefault());
hitbox.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (snapshot?.selftest && event.isTrusted) return;
  if (leftDragging || performance.now() - dragEndedAt < 180) return;
  debugState.wheelEvents += 1;
  reportState();
  void window.desktopPet.scale(event.deltaY);
}, { passive: false });

window.desktopPet.onEvent((event) => {
  if (event?.type === 'desktop-bounds' && event.desktopBounds && snapshot) {
    snapshot.desktopBounds = event.desktopBounds;
    snapshot.config = {
      ...snapshot.config,
      position: event.position || snapshot.config.position,
      scale: event.scale || snapshot.config.scale,
    };
    leftDragging = false;
    rightDragging = false;
    lastPointer = null;
    document.body.classList.remove('dragging');
    window.scrollTo(0, 0);
    applyVisualScale(snapshot.config.scale);
    reportState();
  } else if (event?.type === 'phase') {
    currentPhase = event.phase || 'idle';
    debugState.phase = currentPhase;
    handle?.setPhase(currentPhase);
    reportState();
  } else if (event?.type === 'config' && event.config) {
    applyConfig(event.config);
  } else if (event?.type === 'scale') {
    snapshot.config = { ...snapshot.config, scale: event.scale, position: event.position || snapshot.config.position };
    applyVisualScale(event.scale);
    reportState();
  } else if (event?.type === 'position' && event.position) {
    snapshot.config = { ...snapshot.config, scale: event.scale || snapshot.config.scale, position: event.position };
    applyVisualLayout();
    reportState();
  }
});

window.__petDebugSnapshot = () => {
  const inputRect = hitbox.getBoundingClientRect();
  return {
    ...debugState,
    hasHandle: Boolean(handle),
    currentPetId,
    canvasTransform: getComputedStyle(stage.querySelector('canvas') || stage).transform,
    stageTransform: getComputedStyle(stage).transform,
    inputBounds: {
      x: Math.round(inputRect.x),
      y: Math.round(inputRect.y),
      width: Math.round(inputRect.width),
      height: Math.round(inputRect.height),
    },
  };
};

window.addEventListener('beforeunload', () => {
  ++loadEpoch;
  activeAbortController?.abort();
  handle?.dispose();
  handle = null;
});

void window.desktopPet.snapshot().then((value) => {
  snapshot = value;
  currentPhase = value.phase || 'waiting';
  debugState.phase = currentPhase;
  applyVisualScale(value.config?.scale);
  return mountPet();
}).catch((error) => {
  const message = String(error?.message || error || '初始化失败');
  showStatus(message);
  reportState({ modelError: message });
});
