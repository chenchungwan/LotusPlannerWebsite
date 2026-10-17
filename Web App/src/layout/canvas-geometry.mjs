export const MIN_WIDGET_SIZE = Object.freeze({ width: 200, height: 200 });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const validCanvas = canvas => canvas && finite(canvas.width) && finite(canvas.height) && canvas.width > 0 && canvas.height > 0;
const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => finite(rect[key])) && rect.width > 0 && rect.height > 0;

export function rectsOverlap(a, b) {
    return Boolean(validRect(a) && validRect(b) && a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y);
}

export function canPlace(rect, others, canvas, excludeId) {
    if (!validCanvas(canvas) || !validRect(rect) || rect.width < MIN_WIDGET_SIZE.width || rect.height < MIN_WIDGET_SIZE.height ||
        rect.x < 0 || rect.y < 0 || rect.x + rect.width > canvas.width || rect.y + rect.height > canvas.height) return false;
    return !(others || []).some(other => (excludeId === undefined || other.id !== excludeId) && rectsOverlap(rect, other));
}

export function constrainRect(rect, canvas, minSize = MIN_WIDGET_SIZE) {
    if (!validCanvas(canvas)) throw new TypeError('A positive canvas size is required.');
    const minWidth = Math.min(canvas.width, finite(minSize.width) && minSize.width > 0 ? minSize.width : MIN_WIDGET_SIZE.width);
    const minHeight = Math.min(canvas.height, finite(minSize.height) && minSize.height > 0 ? minSize.height : MIN_WIDGET_SIZE.height);
    const width = clamp(finite(rect.width) ? rect.width : minWidth, minWidth, canvas.width);
    const height = clamp(finite(rect.height) ? rect.height : minHeight, minHeight, canvas.height);
    return {
        ...rect,
        x: clamp(finite(rect.x) ? rect.x : 0, 0, canvas.width - width),
        y: clamp(finite(rect.y) ? rect.y : 0, 0, canvas.height - height),
        width, height,
    };
}

export function moveRect(start, dx, dy, canvas) {
    return constrainRect({ ...start, x: start.x + (finite(dx) ? dx : 0), y: start.y + (finite(dy) ? dy : 0) }, canvas);
}

export function resizeRect(start, corner, dx, dy, canvas) {
    const aliases = { 'top-left': 'nw', 'top-right': 'ne', 'bottom-left': 'sw', 'bottom-right': 'se' };
    const direction = aliases[corner] || corner;
    if (!['nw', 'ne', 'sw', 'se'].includes(direction)) throw new TypeError('Choose a valid resize corner.');
    const rect = constrainRect(start, canvas);
    const minWidth = Math.min(MIN_WIDGET_SIZE.width, canvas.width);
    const minHeight = Math.min(MIN_WIDGET_SIZE.height, canvas.height);
    const deltaX = finite(dx) ? dx : 0;
    const deltaY = finite(dy) ? dy : 0;
    if (direction.includes('w')) {
        const right = rect.x + rect.width;
        rect.x = clamp(rect.x + deltaX, 0, right - minWidth);
        rect.width = right - rect.x;
    } else {
        rect.width = clamp(rect.width + deltaX, minWidth, canvas.width - rect.x);
    }
    if (direction.includes('n')) {
        const bottom = rect.y + rect.height;
        rect.y = clamp(rect.y + deltaY, 0, bottom - minHeight);
        rect.height = bottom - rect.y;
    } else {
        rect.height = clamp(rect.height + deltaY, minHeight, canvas.height - rect.y);
    }
    return rect;
}

/** Find a free rectangle at exact coordinates or existing edges, without a snap grid. */
export function findOpenPosition(size, widgets, canvas, preferred) {
    if (!validCanvas(canvas) || !size || !finite(size.width) || !finite(size.height)) return null;
    const width = Math.max(MIN_WIDGET_SIZE.width, size.width);
    const height = Math.max(MIN_WIDGET_SIZE.height, size.height);
    if (width > canvas.width || height > canvas.height) return null;
    const others = widgets || [];
    if (preferred && finite(preferred.x) && finite(preferred.y)) {
        const candidate = { x: preferred.x, y: preferred.y, width, height };
        if (canPlace(candidate, others, canvas)) return candidate;
    }
    const xs = new Set([0, canvas.width - width]);
    const ys = new Set([0, canvas.height - height]);
    others.filter(validRect).forEach(rect => {
        xs.add(rect.x + rect.width);
        xs.add(rect.x - width);
        ys.add(rect.y + rect.height);
        ys.add(rect.y - height);
    });
    const xCandidates = [...xs].filter(x => x >= 0 && x + width <= canvas.width).sort((a, b) => a - b);
    const yCandidates = [...ys].filter(y => y >= 0 && y + height <= canvas.height).sort((a, b) => a - b);
    for (const y of yCandidates) {
        for (const x of xCandidates) {
            const candidate = { x, y, width, height };
            if (canPlace(candidate, others, canvas)) return candidate;
        }
    }
    return null;
}
