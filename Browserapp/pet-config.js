'use strict';

const PET_PHASES = Object.freeze([
  { id: 'idle', label: '空闲' },
  { id: 'waiting', label: '加载 / 等待' },
  { id: 'thinking', label: 'Agent 思考' },
  { id: 'tool', label: 'Agent 工具 / RPA' },
  { id: 'review', label: '浏览器运行' },
  { id: 'done', label: '完成' },
  { id: 'failed', label: '失败 / 关闭' },
]);

const PET_MOTION_MODES = Object.freeze([
  { id: 'by-state', label: '按状态' },
  { id: 'all-shuffle', label: '任意状态随机循环' },
  { id: 'all-random-once', label: '任意状态随机' },
]);

// The ids and ordering intentionally match the dsh-pet motion policy. The
// closing/failed entry reuses the authored Loli Requiem clip as its own action.
const PET_MOTIONS = Object.freeze([
  { id: 'idle:iris-out', phase: 'idle', index: 0, label: 'Iris Out' },
  { id: 'idle:cat-sway', phase: 'idle', index: 1, label: '猫猫摇' },
  { id: 'waiting:fvn', phase: 'waiting', index: 0, label: 'FVN' },
  { id: 'waiting:say-so', phase: 'waiting', index: 1, label: 'Say So' },
  { id: 'thinking:loli-requiem', phase: 'thinking', index: 0, label: 'Loli Requiem' },
  { id: 'tool:produce-101', phase: 'tool', index: 0, label: 'Produce 101', maxEndFrame: 450 },
  { id: 'tool:shinjuku', phase: 'tool', index: 1, label: 'Shinjuku', maxEndFrame: 450 },
  { id: 'review:duck-dance', phase: 'review', index: 0, label: '鸭子舞', maxEndFrame: 450 },
  { id: 'done:wild-disco', phase: 'done', index: 0, label: 'Wild Disco' },
  { id: 'done:pubg-166', phase: 'done', index: 1, label: 'PUBG 166' },
  { id: 'done:sticker-meme', phase: 'done', index: 2, label: 'Sticker Meme' },
  { id: 'failed:loli-requiem', phase: 'failed', index: 0, label: 'Loli Requiem（失败/关闭）' },
]);

const DEFAULT_ASSIGNMENTS = Object.freeze(Object.fromEntries(PET_PHASES.map(({ id }) => [
  id,
  PET_MOTIONS.filter((motion) => motion.phase === id).map((motion) => motion.id),
])));

const DEFAULT_PET_CONFIG = Object.freeze({
  enabled: true,
  petId: 'mmd-bianca',
  mode: 'by-state',
  assignments: DEFAULT_ASSIGNMENTS,
  scale: 1,
  position: null,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizePetConfig(value = {}, petIds = []) {
  const source = value && typeof value === 'object' ? value : {};
  const validPetIds = new Set(Array.isArray(petIds) ? petIds.map(String) : []);
  const requestedPetId = String(source.petId || DEFAULT_PET_CONFIG.petId);
  const petId = validPetIds.size === 0 || validPetIds.has(requestedPetId)
    ? requestedPetId
    : (validPetIds.has(DEFAULT_PET_CONFIG.petId) ? DEFAULT_PET_CONFIG.petId : [...validPetIds][0]);
  const validMotionIds = new Set(PET_MOTIONS.map((motion) => motion.id));
  const assignments = {};
  for (const { id } of PET_PHASES) {
    const requested = Array.isArray(source.assignments?.[id])
      ? source.assignments[id].map(String).filter((motionId) => validMotionIds.has(motionId))
      : [];
    assignments[id] = [...new Set(requested.length ? requested : DEFAULT_ASSIGNMENTS[id])];
  }
  const rawScale = Number(source.scale);
  const requestedMode = ({
    phase: 'by-state',
    'ordered-random': 'by-state',
    shuffle: 'all-shuffle',
    random: 'all-random-once',
  })[source.mode] || source.mode;
  const position = source.position && Number.isFinite(Number(source.position.x)) && Number.isFinite(Number(source.position.y))
    ? { x: Math.round(Number(source.position.x)), y: Math.round(Number(source.position.y)) }
    : null;
  return {
    enabled: source.enabled !== false,
    petId,
    mode: PET_MOTION_MODES.some(({ id }) => id === requestedMode)
      ? requestedMode
      : 'by-state',
    assignments,
    scale: clamp(Number.isFinite(rawScale) ? rawScale : DEFAULT_PET_CONFIG.scale, 0.25, 1.6),
    position,
  };
}

function petWindowSize(scale) {
  const normalized = clamp(Number(scale) || 1, 0.25, 1.6);
  return {
    width: Math.round(400 * normalized),
    height: Math.round(540 * normalized),
  };
}

module.exports = {
  PET_PHASES,
  PET_MOTION_MODES,
  PET_MOTIONS,
  DEFAULT_ASSIGNMENTS,
  DEFAULT_PET_CONFIG,
  normalizePetConfig,
  petWindowSize,
};
