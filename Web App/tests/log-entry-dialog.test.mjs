import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogEntryDialog } from '../src/components/log-entry-dialog.mjs';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.className = '';
        this._text = ''; this.value = ''; this.open = false;
        const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
        this.classList = {
            contains: name => tokens().has(name),
            toggle: (name, enabled) => {
                const set = tokens(); (enabled === undefined ? !set.has(name) : enabled) ? set.add(name) : set.delete(name);
                this.className = [...set].join(' ');
            },
        };
    }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...nodes) { nodes.forEach(node => { node.remove(); this.children.push(node); node.parentNode = this; }); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    replaceChildren(...nodes) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
    querySelectorAll(selector) {
        const match = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector.startsWith('[name=') ? node.name === selector.slice(7, -2) : node.tagName === selector.toUpperCase();
        return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, callback, options = {}) {
        const values = this.listeners.get(type) || []; values.push({ callback, options }); this.listeners.set(type, values);
    }
    async dispatch(type, data = {}) {
        const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...data };
        await Promise.all((this.listeners.get(type) || []).filter(item => !item.options.signal?.aborted).map(item => item.callback(event)));
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
}

function setup(t, actions = {}) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    let context = { day: new Date(2026, 9, 17) };
    const root = document.createElement('main');
    const app = createLogEntryDialog({ root, getContext: () => context, actions });
    const dialog = root.children[0];
    return {
        app, root, dialog, form: dialog.querySelector('form'),
        input: name => dialog.querySelector('[name="' + name + '"]'),
        find: selector => dialog.querySelector(selector),
        update(next) { context = next; app.update(next); },
    };
}
const editFood = { id: 'food-existing', type: 'food', day: '2026-10-17', time: '12:30', name: 'Lunch' };

test('new weight entries keep the captured selected day and validate their numeric value before saving', async t => {
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    view.app.open('weight', new Date(2026, 9, 17));
    assert.equal(view.dialog.open, true);
    assert.equal(view.input('day').value, '2026-10-17');
    assert.equal(view.input('unit').value, 'lbs');
    view.update({ day: new Date(2026, 11, 1) });
    assert.equal(view.input('day').value, '2026-10-17');
    view.input('weight').value = '-5';
    await view.form.dispatch('submit');
    assert.equal(saved.length, 0); assert.equal(view.dialog.open, true);
    assert.match(view.find('.log-entry-status').textContent, /positive/);
    view.input('weight').value = '65.4'; view.input('unit').value = 'kg'; view.input('time').value = '07:15';
    await view.form.dispatch('submit');
    assert.equal(saved.length, 1); assert.equal(view.dialog.open, false);
    assert.equal(saved[0].day, '2026-10-17'); assert.equal(saved[0].time, '07:15');
    assert.equal(saved[0].weight, 65.4); assert.equal(saved[0].unit, 'kg'); assert.ok(saved[0].id);
});

test('workout form offers native types plus No type and requires text only when no type is chosen', async t => {
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    view.app.open('workout', '2026-10-17');
    assert.equal(view.input('workoutType').children.length, 79);
    assert.equal(view.input('workoutType').value, 'running');
    assert.equal(view.input('name').required, false);
    view.input('workoutType').value = ''; await view.input('workoutType').dispatch('change');
    assert.equal(view.input('name').required, true);
    view.input('name').value = '   ';
    await view.form.dispatch('submit');
    assert.equal(saved.length, 0);
    view.input('workoutType').value = 'traditional_strength_training'; view.input('name').value = '  Leg day  ';
    await view.form.dispatch('submit');
    assert.equal(saved[0].name, 'Leg day'); assert.equal(saved[0].workoutType, 'traditional_strength_training');
    view.app.open('workout', '2026-10-17'); view.input('name').value = '';
    await view.form.dispatch('submit');
    assert.equal(saved[1].workoutType, 'running'); assert.equal(saved[1].name, '');
    view.app.open('workout', '2026-10-17'); view.input('workoutType').value = ''; view.input('name').value = '  Free movement  ';
    await view.form.dispatch('submit');
    assert.equal(saved[2].workoutType, null); assert.equal(saved[2].name, 'Free movement');
});

test('Pocky workout settings lead the picker, deduplicate native IDs, and preserve archived type-only edits', async t => {
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    view.update({ logs: { settings: { workoutTypes: [
        { id: 'walk', name: 'Morning walk', color: '#34c759' },
        { id: 'yoga', name: 'Stretching', color: '#af52de' },
        { id: 'old-custom', name: 'Old strength session', archived: true },
    ] } } });
    view.app.open('workout', '2026-10-17');
    const options = view.input('workoutType').children;
    assert.deepEqual(options.slice(0, 3).map(option => [option.value, option.textContent]), [['', 'No type'], ['walk', 'Morning walk'], ['yoga', 'Stretching']]);
    assert.equal(options.filter(option => option.value === 'yoga').length, 1);
    assert.equal(options.some(option => option.value === 'old-custom'), false);
    assert.equal(view.input('workoutType').value, 'walk');
    await view.find('.log-entry-cancel').dispatch('click');
    const entry = { id: 'pocky-workout', type: 'workout', day: '2026-10-17', workoutType: 'old-custom', name: '' };
    view.app.open('workout', entry.day, entry);
    assert.equal(view.input('workoutType').value, 'old-custom');
    assert.equal(view.input('workoutType').children.find(option => option.value === 'old-custom').textContent, 'Old strength session (archived)');
    assert.equal(view.input('name').value, '');
    await view.form.dispatch('submit');
    assert.equal(saved[0].id, entry.id); assert.equal(saved[0].workoutType, 'old-custom'); assert.equal(saved[0].name, '');
    assert.equal(saved[0].time, '12:00');
});

test('unavailable legacy workout types remain editable without being replaced by a native type', async t => {
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    const entry = { id: 'pocky-legacy', type: 'workout', day: '2026-10-17', time: '09:15', workoutType: 'unknown-existing-id', name: '' };
    view.app.open('workout', entry.day, entry);
    assert.equal(view.input('workoutType').value, entry.workoutType);
    assert.ok(view.input('workoutType').children.some(option => option.value === entry.workoutType));
    await view.form.dispatch('submit'); assert.equal(saved[0].workoutType, entry.workoutType);
});

test('new weight forms use shared Pocky units while edits keep their original unit', async t => {
    const view = setup(t);
    view.update({ logs: { settings: { weightUnit: 'kg' } } });
    view.app.open('weight', '2026-10-17'); assert.equal(view.input('unit').value, 'kg');
    await view.find('.log-entry-cancel').dispatch('click');
    view.app.open('weight', '2026-10-17', { id: 'old-weight', type: 'weight', day: '2026-10-17', time: '07:00', weight: 150, unit: 'lbs' });
    assert.equal(view.input('unit').value, 'lbs');
});

test('save failures retain the draft and identity for a successful retry', async t => {
    let fail = true;
    const saved = [];
    const view = setup(t, { saveEntry: async value => { saved.push(value); if (fail) throw new Error('Connection interrupted'); } });
    view.app.open('food', '2026-10-17');
    assert.equal(view.input('name').tagName, 'TEXTAREA');
    view.input('name').value = '  Soup  ';
    await view.form.dispatch('submit');
    assert.equal(view.dialog.open, true); assert.equal(view.input('name').value, '  Soup  ');
    assert.equal(view.find('.log-entry-status').classList.contains('is-error'), true);
    assert.match(view.find('.log-entry-status').textContent, /Connection interrupted/);
    assert.equal(view.find('.log-entry-save').disabled, false);
    fail = false; await view.form.dispatch('submit');
    assert.equal(view.dialog.open, false); assert.equal(saved.length, 2);
    assert.equal(saved[0].id, saved[1].id); assert.equal(saved[1].name, 'Soup');
});

test('pending saves block duplicate submissions, every close path, and form controls until acknowledgment', async t => {
    let acknowledge, calls = 0;
    const view = setup(t, { saveEntry: () => { calls++; return new Promise(resolve => { acknowledge = resolve; }); } });
    view.app.open('food', '2026-10-17'); view.input('name').value = 'Breakfast';
    const pending = view.form.dispatch('submit');
    assert.equal(view.form.getAttribute('aria-busy'), 'true');
    assert.equal(view.input('day').disabled, true); assert.equal(view.input('name').disabled, true);
    assert.equal(view.find('.log-entry-save').disabled, true);
    await view.form.dispatch('submit'); await view.find('.log-entry-close').dispatch('click'); await view.find('.log-entry-cancel').dispatch('click');
    let prevented = false;
    await view.dialog.dispatch('cancel', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(calls, 1); assert.equal(view.dialog.open, true);
    acknowledge(); await pending;
    assert.equal(view.dialog.open, false);
});

test('editing keeps the original ID/day and delete requires confirmation plus backend acknowledgment', async t => {
    let acknowledge, deletes = [], saves = [];
    const view = setup(t, {
        saveEntry: async value => saves.push(value),
        deleteEntry: id => { deletes.push(id); return new Promise(resolve => { acknowledge = resolve; }); },
    });
    view.app.open('food', '2030-01-01', editFood);
    assert.equal(view.input('day').value, editFood.day); assert.equal(view.input('name').value, 'Lunch');
    view.input('name').value = 'Late lunch'; await view.form.dispatch('submit');
    assert.equal(saves[0].id, editFood.id);
    view.app.open('food', '2026-10-17', editFood);
    await view.find('.log-entry-confirm-delete').dispatch('click'); assert.deepEqual(deletes, []);
    await view.find('.log-entry-delete').dispatch('click');
    assert.equal(view.find('.log-entry-delete-confirmation').hidden, false);
    await view.find('.log-entry-keep').dispatch('click');
    assert.equal(view.find('.log-entry-delete-confirmation').hidden, true);
    await view.find('.log-entry-delete').dispatch('click');
    const pending = view.find('.log-entry-confirm-delete').dispatch('click');
    assert.deepEqual(deletes, [editFood.id]); assert.equal(view.dialog.open, true);
    await view.dialog.dispatch('cancel'); assert.equal(view.dialog.open, true);
    acknowledge(); await pending; assert.equal(view.dialog.open, false);
});

test('moving a Pocky entry retains its original routing source and deletion passes a separate source copy', async t => {
    const saved = [], deleted = [];
    const view = setup(t, {
        saveEntry: async value => saved.push(value),
        deleteEntry: async (id, source) => deleted.push({ id, source }),
    });
    const source = Object.freeze({ day: '2026-10-17', kind: 'food', rawId: 'shared-legacy-uuid' });
    const entry = Object.freeze({ ...editFood, id: 'shared-legacy-uuid', source });
    view.app.open('food', entry.day, entry);
    view.input('day').value = '2026-10-18'; view.input('name').value = 'Moved lunch';
    await view.form.dispatch('submit');
    assert.equal(saved[0].day, '2026-10-18'); assert.equal(saved[0].id, entry.id);
    assert.deepEqual(saved[0].source, source); assert.notEqual(saved[0].source, source);
    assert.equal(entry.day, '2026-10-17'); assert.equal(source.day, '2026-10-17');
    // A colliding raw UUID on another day must not change this delete's route.
    view.app.open('food', entry.day, entry); view.input('day').value = '2026-10-19';
    await view.find('.log-entry-delete').dispatch('click'); await view.find('.log-entry-confirm-delete').dispatch('click');
    assert.deepEqual(deleted, [{ id: entry.id, source }]);
    assert.notEqual(deleted[0].source, source); assert.notEqual(deleted[0].source, saved[0].source);
});

test('delete failures keep the entry and allow retry without changing its form values', async t => {
    let fail = true, calls = 0;
    const view = setup(t, { deleteEntry: async () => { calls++; if (fail) throw new Error('Delete failed'); } });
    view.app.open('food', editFood.day, editFood);
    await view.find('.log-entry-delete').dispatch('click'); await view.find('.log-entry-confirm-delete').dispatch('click');
    assert.equal(view.dialog.open, true); assert.equal(view.input('name').value, 'Lunch');
    assert.match(view.find('.log-entry-status').textContent, /Delete failed/);
    fail = false; await view.find('.log-entry-confirm-delete').dispatch('click');
    assert.equal(calls, 2); assert.equal(view.dialog.open, false);
});

test('sleep starts with unset times and its Set actions use the selected local day across daylight saving', async t => {
    const previous = process.env.TZ; process.env.TZ = 'America/Los_Angeles';
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    view.app.open('sleep', new Date(2026, 10, 1));
    assert.equal(view.input('bedTime').value, ''); assert.equal(view.input('wakeTime').value, '');
    await view.form.dispatch('submit'); assert.equal(saved.length, 0); assert.equal(view.dialog.open, true);
    const set = view.dialog.querySelectorAll('.log-entry-set-time');
    await set[0].dispatch('click'); await set[1].dispatch('click');
    assert.equal(view.input('bedTime').value, '2026-10-31T23:00');
    assert.equal(view.input('wakeTime').value, '2026-11-01T08:00');
    await view.form.dispatch('submit');
    assert.equal(saved[0].day, '2026-11-01');
    assert.equal(saved[0].bedTime, '2026-11-01T06:00:00.000Z');
    assert.equal(saved[0].wakeTime, '2026-11-01T16:00:00.000Z');
});

test('sleep edits roundtrip local times, permit a single time, and reject nonexistent local clocks', async t => {
    const previous = process.env.TZ; process.env.TZ = 'America/Los_Angeles';
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const saved = [];
    const view = setup(t, { saveEntry: async value => saved.push(value) });
    const entry = { id: 'sleep-id', type: 'sleep', day: '2026-10-17', time: '12:00', bedTime: '2026-10-17T06:00:00.000Z', wakeTime: '2026-10-17T15:00:00.000Z' };
    view.app.open('sleep', entry.day, entry);
    assert.equal(view.input('bedTime').value, '2026-10-16T23:00'); assert.equal(view.input('wakeTime').value, '2026-10-17T08:00');
    await view.dialog.querySelectorAll('.log-entry-clear-time')[0].dispatch('click');
    await view.form.dispatch('submit');
    assert.equal(saved[0].id, 'sleep-id'); assert.equal(saved[0].bedTime, null); assert.equal(saved[0].wakeTime, entry.wakeTime);
    view.app.open('sleep', '2026-03-08'); view.input('wakeTime').value = '2026-03-08T02:30';
    await view.form.dispatch('submit');
    assert.equal(saved.length, 1); assert.equal(view.dialog.open, true);
    assert.match(view.find('.log-entry-status').textContent, /does not exist in your timezone/);
});

test('dialog lifecycles keep headings and new identities separate and become inert after destruction', async t => {
    const saved = [];
    const first = setup(t, { saveEntry: async value => saved.push(value) });
    const secondRoot = document.createElement('main');
    const second = createLogEntryDialog({ root: secondRoot, actions: {} });
    assert.notEqual(first.dialog.getAttribute('aria-labelledby'), secondRoot.children[0].getAttribute('aria-labelledby'));
    first.app.open('food', '2026-10-17'); first.input('name').value = 'One'; await first.form.dispatch('submit');
    first.app.open('food', '2026-10-17'); first.input('name').value = 'Two'; await first.form.dispatch('submit');
    assert.notEqual(saved[0].id, saved[1].id);
    first.app.open('food', '2026-10-17'); first.input('name').value = 'Three';
    const oldForm = first.form;
    first.app.destroy(); first.app.destroy(); await oldForm.dispatch('submit');
    assert.equal(saved.length, 2); assert.equal(first.root.children.length, 0);
    assert.equal(first.app.open('food', '2026-10-17'), false); second.destroy();
});
