import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_WIDGET_SIZE, rectsOverlap, canPlace, constrainRect, resizeRect, moveRect, findOpenPosition } from '../src/layout/canvas-geometry.mjs';

const canvas = { width: 1000, height: 800 };

test('overlap rejects shared area while allowing touching edges and corners', () => {
    const first = { x: 0, y: 0, width: 200, height: 200 };
    assert.equal(rectsOverlap(first, { x: 200, y: 0, width: 200, height: 200 }), false);
    assert.equal(rectsOverlap(first, { x: 0, y: 200, width: 200, height: 200 }), false);
    assert.equal(rectsOverlap(first, { x: 200, y: 200, width: 200, height: 200 }), false);
    assert.equal(rectsOverlap(first, { x: 199.75, y: 20, width: 200, height: 200 }), true);
    assert.equal(rectsOverlap(first, { x: 10, y: 10, width: 20, height: 20 }), true);
    assert.equal(rectsOverlap(first, { x: 0, y: 0, width: 0, height: 200 }), false);
});

test('placement enforces minimum size, finite coordinates, bounds and optional self exclusion', () => {
    assert.deepEqual(MIN_WIDGET_SIZE, { width: 200, height: 200 });
    const others = [{ id: 'one', x: 0, y: 0, width: 200, height: 200 }];
    assert.equal(canPlace({ x: 0, y: 0, width: 200, height: 200 }, others, canvas), false);
    assert.equal(canPlace({ x: 0, y: 0, width: 200, height: 200 }, others, canvas, 'one'), true);
    assert.equal(canPlace({ x: 200, y: 0, width: 800, height: 800 }, others, canvas), true);
    for (const rect of [
        { x: -0.1, y: 0, width: 200, height: 200 },
        { x: 0, y: -1, width: 200, height: 200 },
        { x: 800.1, y: 0, width: 200, height: 200 },
        { x: 0, y: 601, width: 200, height: 200 },
        { x: 0, y: 0, width: 199, height: 200 },
        { x: 0, y: 0, width: 200, height: 199 },
        { x: Infinity, y: 0, width: 200, height: 200 },
        { x: 0, y: NaN, width: 200, height: 200 },
    ]) assert.equal(canPlace(rect, [], canvas), false);
});

test('constraining and moving keep exact freeform coordinates and clamp at each canvas edge', () => {
    const rect = { id: 'one', x: 300.25, y: 200.5, width: 350, height: 250 };
    assert.deepEqual(moveRect(rect, 7.125, 3.75, canvas), { ...rect, x: 307.375, y: 204.25 });
    assert.deepEqual(moveRect(rect, -1000, -1000, canvas), { ...rect, x: 0, y: 0 });
    assert.deepEqual(moveRect(rect, 1000, 1000, canvas), { ...rect, x: 650, y: 550 });
    assert.deepEqual(constrainRect({ x: -2, y: 999, width: 5000, height: 10 }, canvas), { x: 0, y: 600, width: 1000, height: 200 });
    assert.deepEqual(constrainRect({ x: 20, y: 20, width: 20, height: 20 }, canvas, { width: 250, height: 240 }),
        { x: 20, y: 20, width: 250, height: 240 });
    assert.deepEqual(rect, { id: 'one', x: 300.25, y: 200.5, width: 350, height: 250 });
});

test('each resize corner keeps the opposite corner fixed while clamping to minimum size', () => {
    const bounds = { width: 600, height: 500 };
    const start = { id: 'one', x: 100, y: 100, width: 300, height: 300 };
    const cases = [
        ['nw', 1000, 1000, { x: 200, y: 200, width: 200, height: 200 }],
        ['ne', -1000, 1000, { x: 100, y: 200, width: 200, height: 200 }],
        ['sw', 1000, -1000, { x: 200, y: 100, width: 200, height: 200 }],
        ['se', -1000, -1000, { x: 100, y: 100, width: 200, height: 200 }],
    ];
    for (const [corner, dx, dy, expected] of cases) assert.deepEqual(resizeRect(start, corner, dx, dy, bounds), { id: 'one', ...expected });
    assert.deepEqual(resizeRect(start, 'top-left', 10.5, 20.25, bounds),
        { id: 'one', x: 110.5, y: 120.25, width: 289.5, height: 279.75 });
    assert.throws(() => resizeRect(start, 'middle', 0, 0, bounds), /corner/);
});

test('all resize corners stop at canvas boundaries', () => {
    const bounds = { width: 600, height: 500 };
    const start = { x: 100, y: 100, width: 300, height: 300 };
    for (const [corner, dx, dy, expected] of [
        ['nw', -1000, -1000, { x: 0, y: 0, width: 400, height: 400 }],
        ['ne', 1000, -1000, { x: 100, y: 0, width: 500, height: 400 }],
        ['sw', -1000, 1000, { x: 0, y: 100, width: 400, height: 400 }],
        ['se', 1000, 1000, { x: 100, y: 100, width: 500, height: 400 }],
    ]) assert.deepEqual(resizeRect(start, corner, dx, dy, bounds), expected);
});

test('open-position search keeps valid preferred coordinates and finds exact unsnapped edges', () => {
    assert.deepEqual(findOpenPosition({ width: 240, height: 260 }, [], canvas, { x: 31.125, y: 67.875 }),
        { x: 31.125, y: 67.875, width: 240, height: 260 });
    const occupied = [{ id: 'one', x: 0, y: 0, width: 313.25, height: 800 }];
    const result = findOpenPosition({ width: 240, height: 260 }, occupied, canvas, { x: 20, y: 20 });
    assert.deepEqual(result, { x: 313.25, y: 0, width: 240, height: 260 });
    assert.equal(canPlace(result, occupied, canvas), true);
    assert.deepEqual(findOpenPosition({ width: 200, height: 200 }, [
        { x: 0, y: 0, width: 1000, height: 333.5 },
        { x: 0, y: 533.5, width: 1000, height: 266.5 },
    ], canvas), { x: 0, y: 333.5, width: 200, height: 200 });
});

test('impossible placements return null without shrinking or moving existing widgets', () => {
    const occupied = [{ id: 'full', x: 0, y: 0, width: 1000, height: 800 }];
    const before = structuredClone(occupied);
    assert.equal(findOpenPosition({ width: 200, height: 200 }, occupied, canvas), null);
    assert.equal(findOpenPosition({ width: 1001, height: 200 }, [], canvas), null);
    assert.equal(findOpenPosition({ width: 200, height: 200 }, [], { width: 199, height: 800 }), null);
    assert.equal(findOpenPosition({ width: NaN, height: 200 }, [], canvas), null);
    assert.deepEqual(occupied, before);
    const tinyCanvas = { width: 150, height: 160 };
    const tiny = constrainRect({ x: 100, y: 100, width: 300, height: 300 }, tinyCanvas);
    assert.deepEqual(tiny, { x: 0, y: 0, width: 150, height: 160 });
    assert.equal(canPlace(tiny, [], tinyCanvas), false);
});
