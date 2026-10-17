import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceholder, LOG_TYPES } from '../src/components/placeholders.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.attributes = new Map(); this.dataset = {}; this.className = ''; this.value = ''; this.scrollTop = 0;
    }
    set textContent(value) { this.value = String(value); this.replaceChildren(); }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { throw new Error('Placeholders must use text nodes, never interpreted HTML.'); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) { children.forEach(child => { child.remove(); child.parentNode = this; this.children.push(child); }); }
    replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...children); }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
}

function setup(t) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}
function nodes(root, predicate) { return [root, ...root.children.flatMap(child => nodes(child, predicate))].filter(predicate); }
function byClass(root, className) { return nodes(root, node => node.className.split(/\s+/).includes(className)); }
const context = (extra = {}) => ({ day: new Date(2026, 9, 17), customLogs: [], ...extra });
const text = component => component.element.textContent;

test('all placeholder types announce coming soon, follow the selected day, and use unique headings', t => {
    setup(t);
    const headings = new Set();
    for (const type of ['journal', 'logs-group', 'log', 'goals', 'weight-graph', 'journal']) {
        const component = createPlaceholder({ id: 'same-runtime-id', type });
        component.update(context());
        assert.match(component.element.className, /planner-widget/);
        assert.match(component.element.className, new RegExp('placeholder-' + type));
        assert.match(text(component), /Coming soon/);
        const heading = nodes(component.element, node => node.tagName === 'H2')[0];
        assert.equal(component.element.getAttribute('aria-labelledby'), heading.id);
        assert.equal(headings.has(heading.id), false); headings.add(heading.id);
        const date = byClass(component.element, 'placeholder-date')[0];
        assert.equal(date.getAttribute('datetime'), '2026-10-17');
        const before = date.textContent;
        component.update(context({ day: new Date(2026, 9, 18) }));
        assert.equal(date.getAttribute('datetime'), '2026-10-18');
        assert.notEqual(date.textContent, before);
        assert.equal(nodes(component.element, node => ['INPUT', 'TEXTAREA', 'BUTTON'].includes(node.tagName)).length, 0);
    }
});

test('log groups contain all six built-ins and every unique custom definition with empty values', t => {
    setup(t);
    assert.deepEqual(LOG_TYPES.map(log => log.id), ['sleep', 'weight', 'workout', 'workout-streak', 'food', 'water']);
    const definitions = Array.from({ length: 15 }, (_, index) => ({ id: 'custom-' + index, name: 'My log ' + index }));
    definitions.push({ id: 'custom-0', name: 'Duplicate' }, { id: 'sleep', name: 'Custom sleep log' }, { id: '', name: 'Invalid' }, null);
    const options = { customLogs: [{ id: 'local', name: '<img src=x onerror=alert(1)>' }, { id: 'custom-0', name: 'Saved custom name' }] };
    const before = JSON.stringify([definitions, options]);
    const component = createPlaceholder({ id: 'logs', type: 'logs-group', options });
    component.update(context({ customLogs: definitions }));
    const cards = byClass(component.element, 'placeholder-log-card');
    assert.equal(cards.length, 23);
    assert.equal(new Set(cards.map(card => card.dataset.logType)).size, 23);
    for (const log of LOG_TYPES) assert.equal(cards.some(card => card.dataset.logType === log.id), true);
    assert.equal(cards.some(card => card.dataset.logType === 'custom:sleep' && /Custom sleep log/.test(card.textContent)), true);
    const values = byClass(component.element, 'placeholder-log-value');
    assert.equal(values.every(value => value.textContent === '—' && value.getAttribute('aria-label') === 'No data'), true);
    assert.match(text(component), /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(text(component), /Duplicate|Invalid/);
    assert.equal(JSON.stringify([definitions, options]), before);
});

test('individual custom logs use current names, permit repeated instances, and honor title overrides', t => {
    setup(t);
    const component = createPlaceholder({ id: 'custom', type: 'log', options: {
        logType: 'custom', customLogId: 'mood', customLogName: 'Old name',
    } });
    component.update(context({ customLogs: [{ id: 'mood', name: 'Mood' }] }));
    assert.match(text(component), /Mood/); assert.doesNotMatch(text(component), /Old name/);
    component.update(context({ customLogs: [{ id: 'mood', name: 'Daily reflection' }] }));
    assert.match(text(component), /Daily reflection/); assert.doesNotMatch(text(component), /Mood/);
    const second = createPlaceholder({ id: 'custom-copy', type: 'log', options: {
        logType: 'custom', customLogId: 'mood', customLogName: 'Fallback', title: 'My title',
    } });
    second.update(context({ customLogs: [{ id: 'mood', name: 'Mood' }] }));
    assert.match(text(second), /My title/); assert.doesNotMatch(text(second), /Fallback|Mood/);
    assert.notEqual(component.element.getAttribute('aria-labelledby'), second.element.getAttribute('aria-labelledby'));
    const fallback = createPlaceholder({ id: 'unavailable', type: 'log', options: { logType: 'custom', customLogId: 'missing', customLogName: 'A custom log' } });
    fallback.update(context()); assert.match(text(fallback), /A custom log/);
});

test('journal provides blank writing guides without editable content or sample entries', t => {
    setup(t);
    const component = createPlaceholder({ id: 'journal', type: 'journal' }); component.update(context());
    assert.equal(byClass(component.element, 'placeholder-journal-line').length, 6);
    assert.equal(byClass(component.element, 'placeholder-journal-lines')[0].getAttribute('aria-hidden'), 'true');
    assert.equal(nodes(component.element, node => node.getAttribute('contenteditable') !== null).length, 0);
    assert.match(text(component), /Journal writing is coming soon/);
    assert.equal(byClass(component.element, 'placeholder-journal-line').every(node => !node.textContent), true);
});

test('goal tracks express the chosen orientation without implying measured progress', t => {
    setup(t);
    for (const orientation of ['vertical', 'horizontal']) {
        const component = createPlaceholder({ id: 'goals-' + orientation, type: 'goals', options: { orientation } });
        component.update(context());
        const list = byClass(component.element, 'placeholder-goals-list')[0];
        assert.equal(list.dataset.orientation, orientation);
        assert.match(list.className, new RegExp('is-' + orientation));
        const tracks = byClass(component.element, 'placeholder-track');
        assert.equal(tracks.length, 3);
        assert.equal(tracks.every(track => !track.textContent && track.children.length === 0), true);
        assert.equal(nodes(component.element, node => node.getAttribute('role') === 'progressbar' || node.getAttribute('aria-valuenow') !== null).length, 0);
        assert.doesNotMatch(text(component), /\d+%|points|streak of|completed/i);
    }
});

test('weight graph periods render only empty axes and date labels, with no sample line or metrics', t => {
    setup(t);
    for (const [period, count] of [['week', 7], ['month', 5], ['year', 12]]) {
        const component = createPlaceholder({ id: 'graph-' + period, type: 'weight-graph', options: { period } });
        component.update(context());
        assert.equal(nodes(component.element, node => node.tagName === 'H2')[0].textContent,
            ({ week: 'Weekly weight', month: 'Monthly weight', year: 'Yearly weight' })[period]);
        const graph = byClass(component.element, 'placeholder-graph')[0];
        assert.equal(graph.dataset.period, period);
        assert.match(graph.className, new RegExp('period-' + period));
        assert.equal(byClass(component.element, 'placeholder-graph-labels')[0].children.length, count);
        assert.equal(byClass(component.element, 'placeholder-graph-grid-line').length, 5);
        assert.match(text(component), /Weight data will appear here/);
        assert.equal(nodes(component.element, node => ['SVG', 'PATH', 'POLYLINE', 'CANVAS'].includes(node.tagName)).length, 0);
        assert.doesNotMatch(text(component), /\d+\s*(kg|lbs?|pounds|kilograms)/i);
    }
    const month = createPlaceholder({ id: 'month', type: 'weight-graph', options: { period: 'month' } });
    month.update(context({ day: new Date(2028, 1, 10) }));
    const labels = byClass(month.element, 'placeholder-graph-labels')[0];
    const february = labels.textContent;
    assert.match(february, /29/);
    month.update(context({ day: new Date(2028, 2, 10) }));
    assert.notEqual(byClass(month.element, 'placeholder-graph-labels')[0].textContent, february);
    assert.match(byClass(month.element, 'placeholder-graph-labels')[0].textContent, /31/);
});

test('graph and goal default titles identify their variants while explicit titles remain unchanged', t => {
    setup(t);
    for (const orientation of ['vertical', 'horizontal']) {
        const component = createPlaceholder({ id: 'goals-' + orientation, type: 'goals', options: { orientation } });
        component.update(context());
        assert.equal(nodes(component.element, node => node.tagName === 'H2')[0].textContent, 'Goals · ' + orientation + ' bars');
    }
    for (const [type, options] of [['weight-graph', { period: 'year' }], ['goals', { orientation: 'horizontal' }]]) {
        const component = createPlaceholder({ id: type, type, options: { ...options, title: 'My own title' } });
        component.update(context());
        assert.equal(nodes(component.element, node => node.tagName === 'H2')[0].textContent, 'My own title');
    }
});

test('teardown is idempotent and prevents subsequent updates to a detached component', t => {
    setup(t);
    const host = document.createElement('div');
    const component = createPlaceholder({ id: 'journal', type: 'journal' }); host.append(component.element);
    component.update(context());
    assert.ok(component.element.children.length);
    component.destroy(); component.destroy();
    assert.equal(host.children.length, 0); assert.equal(component.element.children.length, 0);
    component.update(context({ day: new Date(2026, 10, 1) }));
    assert.equal(component.element.children.length, 0);
});
