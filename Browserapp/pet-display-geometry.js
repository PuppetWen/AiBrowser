'use strict';

function validRectangle(rect) {
  return rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0;
}

function desktopBoundsForDisplays(displays) {
  const bounds = displays.map((display) => display.bounds).filter(validRectangle);
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((rect) => rect.x));
  const y = Math.min(...bounds.map((rect) => rect.y));
  return {
    x, y,
    width: Math.max(...bounds.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...bounds.map((rect) => rect.y + rect.height)) - y,
  };
}

// Only used after a display change. Ordinary dragging may still cross display
// edges; a removed monitor or smaller remote desktop must leave the pet usable.
function recoverPetDisplayPosition(position, size, displays, overscan = 1) {
  const areas = displays.map((display) => validRectangle(display.workArea) ? display.workArea : display.bounds)
    .filter(validRectangle);
  if (!areas.length) return position;
  const current = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? position : { x: areas[0].x, y: areas[0].y };
  const centerX = current.x + size.width / 2;
  const centerY = current.y + size.height / 2;
  const ranked = areas.map((area) => {
    const overlapWidth = Math.max(0, Math.min(current.x + size.width, area.x + area.width) - Math.max(current.x, area.x));
    const overlapHeight = Math.max(0, Math.min(current.y + size.height, area.y + area.height) - Math.max(current.y, area.y));
    const dx = Math.max(area.x - centerX, 0, centerX - area.x - area.width);
    const dy = Math.max(area.y - centerY, 0, centerY - area.y - area.height);
    return { area, overlap: overlapWidth * overlapHeight, distance: dx * dx + dy * dy };
  }).sort((left, right) => right.overlap - left.overlap || left.distance - right.distance);
  const { area } = ranked[0];
  const fitAxis = (value, start, length, visualSize) => {
    if (visualSize >= length) return Math.round(start + (length - visualSize) / 2);
    // Keep the existing overscan when it fits, without sacrificing the visible
    // model on small screens or changing its user-selected scale.
    const margin = Math.min(visualSize * Math.max(0, overscan - 1) / 2, (length - visualSize) / 2);
    return Math.round(Math.min(start + length - visualSize - margin, Math.max(start + margin, value)));
  };
  return {
    x: fitAxis(current.x, area.x, area.width, size.width),
    y: fitAxis(current.y, area.y, area.height, size.height),
  };
}

module.exports = { desktopBoundsForDisplays, recoverPetDisplayPosition };
