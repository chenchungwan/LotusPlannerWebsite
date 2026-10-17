import { el } from '../ui/dom.mjs?v=logs-1';
import { validateCustomLog } from '../state/log-model.mjs?v=logs-1';

let nextManager = 0;
let nextFallbackId = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function newId() {
    return globalThis.crypto?.randomUUID?.() || 'custom-' + Date.now().toString(36) + '-' + (++nextFallbackId) + '-' + Math.random().toString(36).slice(2, 10);
}

function definition(value, index = 0) {
    return {
        id: value.id, name: typeof value.name === 'string' ? value.name : '', enabled: value.enabled !== false,
        order: Number.isFinite(value.order) ? value.order : index,
        items: (Array.isArray(value.items) ? value.items : []).map((item, order) => ({
            id: item.id, title: typeof item.title === 'string' ? item.title : '', enabled: item.enabled !== false,
            order: Number.isFinite(item.order) ? item.order : order,
        })).sort((a, b) => a.order - b.order),
    };
}

/** Manages reusable checklist definitions. Completion records stay in the data service. */
export function createLogManager({ root, getContext, actions }) {
    const dialog = el('dialog', 'planner-dialog log-manager-dialog');
    const title = el('h2', '', 'Custom logs'); title.id = 'log-manager-title-' + (++nextManager);
    dialog.setAttribute('aria-labelledby', title.id);
    const header = el('header', 'log-manager-header');
    const closeButton = button('Close', 'log-manager-close'); header.append(title, closeButton);
    const stateMessage = el('p', 'log-manager-state'); stateMessage.setAttribute('role', 'status');
    const body = el('div', 'log-manager-body');
    const sidebar = el('aside', 'log-manager-sidebar'); sidebar.setAttribute('aria-label', 'Custom log collections');
    const newButton = button('New collection', 'log-manager-new');
    const collectionList = el('div', 'log-manager-collections');
    sidebar.append(newButton, collectionList);
    const editor = el('div', 'log-manager-editor');
    const discardPrompt = el('div', 'log-manager-discard'); discardPrompt.hidden = true;
    discardPrompt.setAttribute('role', 'alert');
    const discardText = el('p', '', 'Discard your unsaved changes to open another collection?');
    const keep = button('Keep editing'), discard = button('Discard changes');
    discardPrompt.append(discardText, keep, discard);
    body.append(sidebar, editor);
    const status = el('p', 'log-manager-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const footer = el('footer', 'log-manager-footer');
    const cancel = button('Cancel', 'secondary-button'), save = button('Save collection', 'primary-button log-manager-save');
    footer.append(cancel, save);
    dialog.append(header, stateMessage, discardPrompt, body, status, footer); root.append(dialog);

    let context = {};
    let draft = null, initial = null;
    let selectedId = null;
    let saving = false, disposed = false;
    let operation = 0;
    let pendingSelection = null;
    let collectionSignature = '';
    const controls = new Set();
    const listeners = new AbortController();
    const on = (node, type, handler) => node.addEventListener(type, handler, { signal: listeners.signal });

    function button(text, className = '') { const node = el('button', className, text); node.type = 'button'; return node; }
    function field(label, input) { const node = el('label', 'log-manager-field'); node.append(el('span', '', label), input); return node; }
    function message(text = '', error = false) { status.textContent = text; status.hidden = !text; status.classList.toggle('is-error', error); }
    function definitions() {
        return (Array.isArray(context.customLogs) ? context.customLogs : []).filter(item => item && typeof item.id === 'string' && item.id)
            .map(definition).sort((a, b) => a.order - b.order);
    }
    function ready() { return context.logs?.status === 'ready'; }
    function busy() { return saving || Boolean(context.logs?.saving); }
    function dirty() { return draft && !same(draft, initial); }
    function validDraft() {
        try { validateCustomLog(draft); return true; } catch { return false; }
    }
    function refreshControls() {
        const disabled = busy();
        closeButton.disabled = disabled; cancel.disabled = disabled;
        save.disabled = disabled || !ready() || !validDraft();
        save.textContent = saving ? 'Saving…' : 'Save collection';
        newButton.disabled = disabled;
        for (const control of controls) control.disabled = disabled || control.dataset.unavailable === 'true';
        for (const node of collectionList.children) node.disabled = disabled;
        dialog.setAttribute('aria-busy', String(disabled));
    }
    function renderState() {
        const logs = context.logs || { status: 'loading' };
        stateMessage.hidden = logs.status === 'ready';
        stateMessage.classList.toggle('is-error', logs.status === 'error');
        stateMessage.textContent = ({
            loading: 'Loading your custom logs…',
            unconfigured: 'Cloud logs are not configured yet. You can review your collection names here.',
            error: typeof logs.error === 'string' ? logs.error : logs.error?.message || 'Your custom logs could not load. Please try again.',
        })[logs.status] || '';
        refreshControls();
    }
    function renderCollections() {
        collectionList.replaceChildren();
        for (const value of definitions()) {
            const item = button('', 'log-manager-collection'); item.dataset.collectionId = value.id;
            item.classList.toggle('is-selected', selectedId === value.id);
            item.classList.toggle('is-archived', !value.enabled);
            item.setAttribute('aria-pressed', String(selectedId === value.id));
            item.append(el('strong', '', value.name || 'Unnamed collection'), el('span', '', value.enabled ? value.items.length + ' checklist items' : 'Archived'));
            item.addEventListener('click', () => requestSelection(value.id)); collectionList.append(item);
        }
        if (!collectionList.children.length) collectionList.append(el('p', 'log-manager-empty', 'No custom collections yet. Create as many as you need.'));
        collectionSignature = JSON.stringify(definitions()); refreshControls();
    }
    function changed() { message(); refreshControls(); }
    function checkbox(label, checked, action) {
        const input = el('input'); input.type = 'checkbox'; input.checked = checked;
        input.addEventListener('change', () => { action(input.checked); changed(); }); controls.add(input);
        return field(label, input);
    }
    function renderEditor(focusItemId) {
        editor.replaceChildren(); controls.clear();
        if (!draft) { editor.append(el('p', 'log-manager-empty', 'Choose a collection or create a new one.')); refreshControls(); return; }
        const name = el('input', 'log-manager-name'); name.type = 'text'; name.value = draft.name; name.maxLength = 80; name.placeholder = 'Collection name';
        name.addEventListener('input', () => { draft.name = name.value; changed(); }); controls.add(name);
        editor.append(field('Collection name', name));
        editor.append(checkbox('Show this collection in daily logs', draft.enabled, value => { draft.enabled = value; }));
        const heading = el('div', 'log-manager-items-heading'); heading.append(el('h3', '', 'Checklist items'));
        const add = button('Add checklist item', 'log-manager-add-item'); controls.add(add);
        add.dataset.unavailable = String(draft.items.length >= 500);
        add.addEventListener('click', () => {
            if (busy() || draft.items.length >= 500) return;
            const item = { id: newId(), title: '', enabled: true, order: draft.items.length };
            draft.items.push(item); renderEditor(item.id); changed();
        });
        heading.append(add); editor.append(heading);
        const items = el('div', 'log-manager-items');
        let focusInput;
        draft.items.forEach((item, index) => {
            const unsavedItem = !initial?.items.some(entry => entry.id === item.id);
            const row = el('div', 'log-manager-item'); row.dataset.itemId = item.id; row.classList.toggle('is-archived', !item.enabled);
            const titleInput = el('input', 'log-manager-item-title'); titleInput.type = 'text'; titleInput.value = item.title; titleInput.maxLength = 160;
            titleInput.placeholder = 'Item title'; titleInput.setAttribute('aria-label', 'Checklist item title');
            titleInput.addEventListener('input', () => { item.title = titleInput.value; changed(); }); controls.add(titleInput);
            if (item.id === focusItemId) focusInput = titleInput;
            const enabled = checkbox('Enabled', item.enabled, value => {
                item.enabled = value; row.classList.toggle('is-archived', !value);
                archive.textContent = unsavedItem ? 'Remove' : value ? 'Archive' : 'Restore';
            });
            const itemActions = el('div', 'log-manager-item-actions');
            const up = button('↑', 'log-manager-item-up'), down = button('↓', 'log-manager-item-down');
            up.setAttribute('aria-label', 'Move item up'); down.setAttribute('aria-label', 'Move item down');
            up.dataset.unavailable = String(index === 0); down.dataset.unavailable = String(index === draft.items.length - 1);
            const move = offset => {
                if (busy()) return;
                const target = index + offset;
                if (target < 0 || target >= draft.items.length) return;
                [draft.items[index], draft.items[target]] = [draft.items[target], draft.items[index]];
                draft.items.forEach((entry, order) => { entry.order = order; }); renderEditor(item.id); changed();
            };
            up.addEventListener('click', () => move(-1)); down.addEventListener('click', () => move(1));
            controls.add(up); controls.add(down);
            const archive = button(unsavedItem ? 'Remove' : item.enabled ? 'Archive' : 'Restore', 'log-manager-item-archive'); controls.add(archive);
            archive.addEventListener('click', () => {
                if (busy()) return;
                if (unsavedItem) {
                    draft.items = draft.items.filter(entry => entry.id !== item.id);
                    draft.items.forEach((entry, order) => { entry.order = order; });
                    renderEditor(); changed(); message('New item removed.'); return;
                }
                item.enabled = !item.enabled; renderEditor(item.id); changed();
                message(item.enabled ? 'Item restored.' : 'Item archived. Its historical entries are retained.');
            });
            itemActions.append(up, down, archive); row.append(titleInput, enabled, itemActions); items.append(row);
        });
        if (!draft.items.length) items.append(el('p', 'log-manager-empty', 'Add the things you want to check off each day.'));
        editor.append(items, el('p', 'log-manager-history-note', 'Archiving a collection or item hides it from daily logs and retains its historical entries. Restore it at any time.'));
        refreshControls(); focusInput?.focus({ preventScroll: true });
    }
    function select(id) {
        const all = definitions();
        const value = all.find(item => item.id === id);
        draft = value ? copy(value) : { id: id || newId(), name: '', enabled: true, order: all.length, items: [] };
        selectedId = draft.id; initial = copy(draft); pendingSelection = null; discardPrompt.hidden = true;
        message(); renderCollections(); renderEditor();
    }
    function requestSelection(id) {
        if (busy() || id === selectedId) return;
        if (dirty()) { pendingSelection = { id }; discardPrompt.hidden = false; return; }
        select(id);
    }
    function close() {
        if (busy()) return;
        operation++; if (dialog.open) dialog.close();
        draft = null; initial = null; pendingSelection = null; discardPrompt.hidden = true;
    }
    on(closeButton, 'click', close); on(cancel, 'click', close);
    on(newButton, 'click', () => requestSelection(null));
    on(keep, 'click', () => { pendingSelection = null; discardPrompt.hidden = true; });
    on(discard, 'click', () => { const next = pendingSelection; if (next) select(next.id); });
    on(dialog, 'cancel', event => { event.preventDefault(); close(); });
    on(save, 'click', async () => {
        if (busy() || !ready() || !validDraft()) return;
        const currentOperation = ++operation;
        const value = validateCustomLog({ ...draft, items: draft.items.map((item, order) => ({ ...item, order })) });
        saving = true; refreshControls(); message();
        try {
            await actions.saveCustomLog(value);
            if (disposed || currentOperation !== operation) return;
            saving = false; close();
        } catch (error) {
            if (!disposed && currentOperation === operation) message(error.message || 'Your collection could not be saved. Please try again.', true);
        } finally { if (!disposed && currentOperation === operation) { saving = false; refreshControls(); } }
    });
    return {
        open(customLogId) {
            if (disposed) return;
            context = getContext() || {};
            if (dialog.open) { if (customLogId) requestSelection(customLogId); renderState(); return; }
            const all = definitions(); select(customLogId || all.find(item => item.enabled)?.id || all[0]?.id || null);
            renderState(); dialog.showModal();
        },
        update(next) {
            if (disposed) return;
            context = next || {};
            if (!dialog.open) return;
            const signature = JSON.stringify(definitions());
            if (signature !== collectionSignature) {
                if (draft && !dirty() && !saving) {
                    const current = definitions().find(item => item.id === selectedId);
                    if (current) { draft = copy(current); initial = copy(current); renderEditor(); }
                }
                renderCollections();
            }
            renderState();
        },
        destroy() {
            if (disposed) return;
            disposed = true; operation++; listeners.abort();
            if (dialog.open) dialog.close(); dialog.remove(); controls.clear(); draft = null; initial = null;
        },
    };
}
