import { el } from '../ui/dom.mjs?v=pocky-1';
import { createCanvasLayout, createDefaultLayout, validateLayout } from '../layout/layout-model.mjs?v=pocky-1';
import { MIN_WIDGET_SIZE, canPlace, resizeRect, moveRect, findOpenPosition } from '../layout/canvas-geometry.mjs?v=pocky-1';
import { createPlannerLayout } from '../layout/layout-renderer.mjs?v=pocky-1';
import { createWidgetRegistry, getWidgetCatalog, getWidgetLabel } from '../layout/widget-registry.mjs?v=journal-1';

const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const corners = ['nw', 'ne', 'sw', 'se'];
let sequence = 0;

/** Edits a private draft. The owner persists it only when onSave succeeds. */
export function createLayoutEditor({ root, getLayout, getContext, onSave, registry = createWidgetRegistry() }) {
    const dialog = el('dialog', 'layout-editor');
    dialog.setAttribute('aria-labelledby', 'layout-editor-title-' + (++sequence));
    const header = el('header', 'layout-editor-header');
    const cancel = button('Cancel', 'layout-editor-cancel');
    const heading = el('div', 'layout-editor-heading');
    const title = el('h2', '', 'Day layout'); title.id = dialog.getAttribute('aria-labelledby');
    heading.append(title, el('p', '', 'Arrange your components. Leave as much space as you like.'));
    const historyControls = el('div', 'layout-editor-history');
    const undo = button('Undo'), redo = button('Redo'); historyControls.append(undo, redo);
    const save = button('Save layout', 'layout-editor-save');
    header.append(cancel, heading, historyControls, save);
    const body = el('div', 'layout-editor-body');
    const palette = el('aside', 'layout-editor-palette'); palette.setAttribute('aria-label', 'Component library');
    const stageColumn = el('div', 'layout-editor-stage-column');
    const tools = el('div', 'layout-editor-tools');
    const zoomLabel = el('label', '', 'Zoom');
    const zoomSelect = el('select'); zoomSelect.setAttribute('aria-label', 'Canvas zoom');
    [25, 50, 75, 100, 125, 150].forEach(value => zoomSelect.append(option(String(value), value + '%')));
    zoomLabel.append(zoomSelect);
    const fit = button('Fit canvas');
    tools.append(zoomLabel, fit, el('span', '', 'Drag a header to move. Resize from any corner.'));
    const viewport = el('div', 'layout-editor-viewport'); viewport.tabIndex = -1;
    const sizer = el('div', 'layout-editor-sizer');
    const surface = el('div', 'layout-editor-surface');
    surface.setAttribute('aria-label', 'Layout canvas');
    const previewRoot = el('div', 'layout-editor-preview'); previewRoot.setAttribute('aria-hidden', 'true'); previewRoot.inert = true;
    const overlays = el('div', 'layout-editor-overlays');
    const ghost = el('div', 'layout-editor-ghost'); ghost.hidden = true;
    surface.append(previewRoot, overlays, ghost); sizer.append(surface); viewport.append(sizer);
    const status = el('p', 'layout-editor-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    stageColumn.append(tools, viewport, status);
    const inspector = el('aside', 'layout-editor-inspector'); inspector.setAttribute('aria-label', 'Component settings');
    body.append(palette, stageColumn, inspector); dialog.append(header, body); root.append(dialog);

    let draft, initial, context, preview;
    let selectedId = null;
    let history = [], future = [];
    let zoom = 1;
    let gesture = null;
    let saving = false;
    let destroyed = false;
    let accountsSignature = '';
    let catalogSignature = '';
    let paletteSearch = '';
    const listeners = new AbortController();
    const on = (node, type, handler, options = {}) => node.addEventListener(type, handler, { ...options, signal: listeners.signal });

    function button(text, className = '') {
        const node = el('button', className, text); node.type = 'button'; return node;
    }
    function option(value, text) { const node = el('option', '', text); node.value = value; return node; }
    function message(text = '', error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
    function selected() { return draft?.widgets.find(widget => widget.id === selectedId); }
    function accountFor(widget) {
        const id = widget.options?.accountId;
        return context?.accounts?.find(item => id === '$primary' ? item.isPrimary : id === '$secondary' ? !item.isPrimary : item.sub === id);
    }
    function labelFor(widget) {
        const resolved = accountFor(widget);
        const options = { ...widget.options, ...(resolved ? { accountId: resolved.sub } : {}) };
        return getWidgetLabel({ ...widget, options }, context?.accounts || [], logDefinitions());
    }
    function logDefinitions() {
        const definitions = new Map((context?.customLogs || []).map(log => [log.id, log]));
        for (const log of draft?.customLogs || []) if (!definitions.has(log.id)) definitions.set(log.id, log);
        return [...definitions.values()];
    }
    function catalogKey() { return JSON.stringify([(context?.accounts || []).map(account => [account.sub, account.email]), logDefinitions()]); }
    function setRect(node, rect) {
        node.style.left = rect.x + 'px'; node.style.top = rect.y + 'px';
        node.style.width = rect.width + 'px'; node.style.height = rect.height + 'px';
    }
    function updateControls() {
        undo.disabled = saving || !history.length; redo.disabled = saving || !future.length;
        cancel.disabled = saving; save.disabled = saving;
        save.textContent = saving ? 'Saving…' : 'Save layout';
        dialog.classList.toggle('is-saving', saving);
        dialog.classList.toggle('is-dirty', Boolean(draft && !same(initial, draft)));
    }
    function updateZoom() {
        if (!draft) return;
        surface.style.width = draft.canvas.width + 'px'; surface.style.height = draft.canvas.height + 'px';
        surface.style.transform = 'scale(' + zoom + ')';
        sizer.style.width = (draft.canvas.width * zoom) + 'px'; sizer.style.height = (draft.canvas.height * zoom) + 'px';
        const value = String(Math.round(zoom * 100));
        const previousFit = zoomSelect.querySelector('[data-fit]'); if (previousFit) previousFit.remove();
        if (![...zoomSelect.options].some(item => item.value === value)) {
            const fitted = option(value, value + '%'); fitted.dataset.fit = 'true'; zoomSelect.append(fitted);
        }
        zoomSelect.value = value;
    }
    function previewContext() { return { ...context, customLogs: logDefinitions(), isLayoutPreview: true, googleReady: false, linking: false }; }
    function renderDraft() {
        if (!draft || destroyed) return;
        const restoreHandleFocus = overlays.contains(dialog.ownerDocument.activeElement);
        if (!preview) preview = createPlannerLayout({ root: previewRoot, registry, layout: draft, actions: {} });
        else preview.setLayout(draft);
        preview.update(previewContext());
        updateZoom(); renderOverlays(); renderInspector(); updateControls();
        if (catalogKey() !== catalogSignature) renderPalette();
        if (restoreHandleFocus && selectedId) {
            [...overlays.children].find(node => node.dataset.widgetId === selectedId)?.querySelector('.layout-editor-drag-handle')?.focus({ preventScroll: true });
        }
    }
    function commit(next, notice = '') {
        try {
            const valid = validateLayout(next);
            if (!same(valid, draft)) {
                history.push(copy(draft)); if (history.length > 50) history.shift();
                future = []; draft = copy(valid);
            }
            if (!draft.widgets.some(widget => widget.id === selectedId)) selectedId = null;
            renderDraft(); message(notice); return true;
        } catch (error) { message(error.message || 'That layout cannot be saved.', true); return false; }
    }
    function select(id) {
        selectedId = id;
        for (const node of overlays.children) {
            const active = node.dataset.widgetId === id;
            node.classList.toggle('is-selected', active);
            node.querySelector('.layout-editor-drag-handle').setAttribute('aria-pressed', String(active));
            node.querySelectorAll('.layout-editor-resize').forEach(handle => { handle.tabIndex = active ? 0 : -1; });
        }
        renderInspector();
    }
    function renderOverlays() {
        overlays.replaceChildren();
        for (const widget of draft.widgets) {
            const frame = el('div', 'layout-editor-widget'); frame.dataset.widgetId = widget.id; setRect(frame, widget);
            frame.classList.toggle('is-selected', selectedId === widget.id);
            const handle = button(labelFor(widget), 'layout-editor-drag-handle');
            handle.title = 'Drag to move ' + labelFor(widget); handle.setAttribute('aria-pressed', String(selectedId === widget.id));
            handle.addEventListener('pointerdown', event => startWidgetGesture(event, widget.id, 'move'));
            handle.addEventListener('click', () => select(widget.id));
            frame.append(handle);
            for (const corner of corners) {
                const resize = button('', 'layout-editor-resize corner-' + corner);
                resize.setAttribute('aria-label', 'Resize ' + labelFor(widget) + ' from ' + ({ nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' })[corner]);
                resize.tabIndex = selectedId === widget.id ? 0 : -1;
                resize.addEventListener('pointerdown', event => startWidgetGesture(event, widget.id, 'resize', corner));
                frame.append(resize);
            }
            overlays.append(frame);
        }
    }
    function freshId() {
        let id;
        do { id = 'widget-' + Date.now().toString(36) + '-' + (++sequence); } while (draft.widgets.some(widget => widget.id === id));
        return id;
    }
    function initialSize(entry) {
        return {
            width: Math.min(draft.canvas.width, Math.max(MIN_WIDGET_SIZE.width, entry.size?.width || 320)),
            height: Math.min(draft.canvas.height, Math.max(MIN_WIDGET_SIZE.height, entry.size?.height || 500)),
        };
    }
    function add(entry, rect) {
        const position = rect || findOpenPosition(initialSize(entry), draft.widgets, draft.canvas);
        if (!position) { message('There isn’t enough clear space. Increase the canvas size or move a component first.', true); return; }
        const widget = { id: freshId(), type: entry.type, ...position, options: copy(entry.options || {}) };
        selectedId = widget.id;
        commit({ ...draft, widgets: [...draft.widgets, widget] }, 'Component added.');
    }
    function renderPalette() {
        catalogSignature = catalogKey();
        palette.replaceChildren(el('h3', '', 'Components'), el('p', 'layout-editor-help', 'Click to add, or drag onto the canvas.'));
        const search = el('input', 'layout-editor-search');
        search.type = 'search'; search.placeholder = 'Find a component'; search.setAttribute('aria-label', 'Find a component'); search.value = paletteSearch;
        const entries = el('div', 'layout-editor-catalog');
        function renderEntries() {
            entries.replaceChildren();
            const query = paletteSearch.trim().toLowerCase();
            const catalog = getWidgetCatalog(context.accounts || [], logDefinitions()).filter(entry => [entry.title, entry.description, entry.category].join(' ').toLowerCase().includes(query));
            let category;
            for (const entry of catalog) {
                if (entry.category !== category) { category = entry.category; entries.append(el('h4', 'layout-editor-category', category)); }
                const card = button('', 'layout-editor-palette-card');
                card.dataset.componentType = entry.type;
                card.append(el('strong', '', entry.title), el('span', '', entry.description || ''));
                card.addEventListener('pointerdown', event => startPaletteGesture(event, entry));
                card.addEventListener('click', event => { if (event.detail === 0 && !saving) add(entry); });
                entries.append(card);
            }
            if (!catalog.length) entries.append(el('p', 'layout-editor-help', 'No matching components.'));
        }
        search.addEventListener('input', () => { paletteSearch = search.value; renderEntries(); });
        renderEntries();
        const customSection = el('div', 'layout-editor-custom-logs');
        customSection.append(el('h4', 'layout-editor-category', 'Custom checklists'));
        const customName = el('input', 'layout-editor-custom-name');
        customName.type = 'text'; customName.maxLength = 80; customName.placeholder = 'Custom log name'; customName.setAttribute('aria-label', 'Custom log name');
        const createCustom = button('Add custom log', 'layout-editor-custom-add');
        createCustom.addEventListener('click', () => {
            if (saving) return;
            const name = customName.value.trim();
            if (!name) { message('Enter a name for your custom log.', true); customName.focus(); return; }
            const customLogs = logDefinitions();
            if (customLogs.some(log => log.name.toLowerCase() === name.toLowerCase())) { message('A custom log with that name is already in the library.', true); return; }
            const id = 'custom-' + Date.now().toString(36) + '-' + (++sequence);
            paletteSearch = '';
            commit({ ...draft, customLogs: [...customLogs.map(log => ({ id: log.id, name: log.name })), { id, name }] }, 'Custom checklist added. Save your layout, then use Manage logs to add its items.');
        });
        customSection.append(customName, createCustom, el('p', 'layout-editor-help', 'New checklists are created in cloud storage when you save. Add their items in Manage logs.'));
        const reset = button('Reset to default', 'layout-editor-reset');
        reset.addEventListener('click', () => {
            if (saving) return;
            const next = createCanvasLayout(createDefaultLayout(), context.accounts || []);
            commit({ ...next, id: draft.id, name: draft.name, ...(draft.customLogs ? { customLogs: draft.customLogs } : {}) }, 'Default layout restored. You can undo this.');
        });
        const blank = button('Start blank', 'layout-editor-blank');
        blank.addEventListener('click', () => {
            if (!saving) commit({ ...draft, widgets: [] }, 'Canvas cleared. Add a component to get started.');
        });
        const paletteActions = el('div', 'layout-editor-palette-actions');
        paletteActions.append(blank, reset);
        palette.append(search, entries, customSection, paletteActions);
    }
    function field(label, control) { const wrap = el('label', 'layout-editor-field'); wrap.append(el('span', '', label), control); return wrap; }
    function numberInput(value, min, max) {
        const input = el('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = '1'; return input;
    }
    function renderInspector() {
        inspector.replaceChildren();
        if (!draft) return;
        inspector.append(el('h3', '', 'Canvas'));
        const canvasFields = el('div', 'layout-editor-field-pair');
        const canvasWidth = numberInput(draft.canvas.width, 200, 100000), canvasHeight = numberInput(draft.canvas.height, 200, 100000);
        canvasFields.append(field('Width', canvasWidth), field('Height', canvasHeight)); inspector.append(canvasFields);
        const setCanvasSize = () => {
            if (saving) return;
            if (!commit({ ...draft, canvas: { width: Number(canvasWidth.value), height: Number(canvasHeight.value) } })) renderInspector();
        };
        canvasWidth.addEventListener('change', setCanvasSize); canvasHeight.addEventListener('change', setCanvasSize);
        inspector.append(el('p', 'layout-editor-help', 'Canvas sizes are in pixels. Components keep their positions when the canvas grows.'));
        const widget = selected();
        if (!widget) { inspector.append(el('div', 'layout-editor-inspector-empty', 'Select a component to change its size, position, or title.')); return; }
        const group = el('div', 'layout-editor-widget-settings');
        group.append(el('h3', '', 'Selected component'), el('p', 'layout-editor-selected-type', labelFor(widget)));
        const titleInput = el('input'); titleInput.type = 'text'; titleInput.value = widget.options?.title || ''; titleInput.maxLength = 100; titleInput.placeholder = 'Default title';
        titleInput.addEventListener('change', () => {
            if (saving) return;
            const options = { ...widget.options };
            if (titleInput.value.trim()) options.title = titleInput.value.trim(); else delete options.title;
            commitWidget(widget.id, { options });
        });
        group.append(field('Title', titleInput));
        if (['account-tasks', 'compact-tasks'].includes(widget.type)) {
            const accountSelect = el('select');
            const accounts = context.accounts || [];
            const selectedAccountId = accountFor(widget)?.sub || widget.options.accountId;
            if (!accounts.some(account => account.sub === selectedAccountId)) accountSelect.append(option(widget.options.accountId, 'Unavailable account'));
            for (const account of accounts) accountSelect.append(option(account.sub, account.email || account.name || 'Google account'));
            accountSelect.value = selectedAccountId;
            accountSelect.addEventListener('change', () => {
                if (!saving) commitWidget(widget.id, { options: { ...widget.options, accountId: accountSelect.value } });
            });
            group.append(field('Google account', accountSelect));
            const completed = el('select');
            completed.append(option('inherit', 'Use planner preference'), option('show', 'Show completed'), option('hide', 'Hide completed'));
            completed.value = typeof widget.options.showCompleted === 'boolean' ? widget.options.showCompleted ? 'show' : 'hide' : 'inherit';
            completed.addEventListener('change', () => {
                if (saving) return;
                const options = { ...widget.options }; delete options.showCompleted;
                if (completed.value !== 'inherit') options.showCompleted = completed.value === 'show';
                commitWidget(widget.id, { options });
            });
            group.append(field('Completed tasks', completed));
            const dateFilter = el('select');
            dateFilter.append(option('inherit', 'Use planner preference'), option('day', 'Selected day'), option('day-overdue', 'Selected day + overdue'), option('all', 'All tasks'));
            dateFilter.value = widget.options.dateFilter || 'inherit';
            dateFilter.addEventListener('change', () => {
                if (saving) return;
                const options = { ...widget.options }; delete options.dateFilter;
                if (dateFilter.value !== 'inherit') options.dateFilter = dateFilter.value;
                commitWidget(widget.id, { options });
            });
            group.append(field('Task dates', dateFilter));
        }
        if (widget.type === 'goals') {
            const orientation = el('select'); orientation.append(option('vertical', 'Vertical bars'), option('horizontal', 'Horizontal bars'));
            orientation.value = widget.options.orientation || 'vertical';
            orientation.addEventListener('change', () => { if (!saving) commitWidget(widget.id, { options: { ...widget.options, orientation: orientation.value } }); });
            group.append(field('Goal bars', orientation));
        }
        if (widget.type === 'weight-graph') {
            const period = el('select'); period.append(option('week', 'Week'), option('month', 'Month'), option('year', 'Year'));
            period.value = widget.options.period || 'week';
            period.addEventListener('change', () => { if (!saving) commitWidget(widget.id, { options: { ...widget.options, period: period.value } }); });
            group.append(field('Graph period', period));
        }
        const position = el('div', 'layout-editor-field-pair');
        const sizes = el('div', 'layout-editor-field-pair');
        const x = numberInput(widget.x, 0, draft.canvas.width), y = numberInput(widget.y, 0, draft.canvas.height);
        const width = numberInput(widget.width, MIN_WIDGET_SIZE.width, draft.canvas.width), height = numberInput(widget.height, MIN_WIDGET_SIZE.height, draft.canvas.height);
        position.append(field('Left', x), field('Top', y)); sizes.append(field('Width', width), field('Height', height));
        const setGeometry = () => {
            if (saving) return;
            const rect = { x: Number(x.value), y: Number(y.value), width: Number(width.value), height: Number(height.value) };
            if (!canPlace(rect, draft.widgets, draft.canvas, widget.id)) { message('Keep the component inside the canvas without overlapping another component.', true); renderInspector(); return; }
            commitWidget(widget.id, rect);
        };
        [x, y, width, height].forEach(input => input.addEventListener('change', setGeometry));
        group.append(position, sizes);
        const remove = button('Remove component', 'layout-editor-remove'); remove.addEventListener('click', removeSelected);
        group.append(remove, el('p', 'layout-editor-help', 'Arrow keys move 1 pixel. Hold Shift for 10 pixels. Delete removes the selected component.'));
        inspector.append(group);
    }
    function commitWidget(id, change) { commit({ ...draft, widgets: draft.widgets.map(widget => widget.id === id ? { ...widget, ...change } : widget) }); }
    function removeSelected() {
        if (!selectedId || saving) return;
        commit({ ...draft, widgets: draft.widgets.filter(widget => widget.id !== selectedId) }, 'Component removed.');
    }
    function begin(event, nextGesture) {
        if (saving || gesture || event.button !== 0) return false;
        event.preventDefault();
        gesture = { ...nextGesture, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false, valid: true, candidate: null };
        surface.setPointerCapture(event.pointerId);
        dialog.classList.add('is-dragging'); return true;
    }
    function startWidgetGesture(event, id, kind, corner) {
        const widget = draft.widgets.find(item => item.id === id);
        if (!widget || !begin(event, { id, kind, corner, start: copy(widget) })) return;
        select(id); event.currentTarget.focus({ preventScroll: true });
    }
    function startPaletteGesture(event, entry) {
        if (!begin(event, { kind: 'add', entry })) return;
        event.currentTarget.focus({ preventScroll: true });
    }
    function pointerPosition(event) {
        const bounds = surface.getBoundingClientRect();
        return { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom };
    }
    function withinViewport(event) {
        const bounds = viewport.getBoundingClientRect();
        return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    }
    function pointerMove(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const dx = Math.round((event.clientX - gesture.clientX) / zoom), dy = Math.round((event.clientY - gesture.clientY) / zoom);
        if (Math.abs(event.clientX - gesture.clientX) + Math.abs(event.clientY - gesture.clientY) > 4) gesture.moved = true;
        if (!gesture.moved) return;
        let rect;
        if (gesture.kind === 'add') {
            const size = initialSize(gesture.entry), point = pointerPosition(event);
            rect = { x: Math.round(point.x - size.width / 2), y: Math.round(point.y - 20), ...size };
        } else if (gesture.kind === 'resize') rect = resizeRect(gesture.start, gesture.corner, dx, dy, draft.canvas);
        else rect = moveRect(gesture.start, dx, dy, draft.canvas);
        gesture.candidate = rect;
        gesture.valid = canPlace(rect, draft.widgets, draft.canvas, gesture.id) && (gesture.kind !== 'add' || withinViewport(event));
        setRect(ghost, rect); ghost.hidden = false; ghost.classList.toggle('is-invalid', !gesture.valid);
        ghost.textContent = gesture.valid ? 'Release to place' : 'Choose a clear space inside the canvas';
    }
    function endGesture(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const finished = gesture;
        cancelGesture();
        if (!finished.moved) { if (finished.kind === 'add') add(finished.entry); return; }
        if (!finished.valid || !finished.candidate) { message('The component stays in its original position. Choose a clear space inside the canvas.', true); return; }
        if (finished.kind === 'add') add(finished.entry, finished.candidate);
        else commitWidget(finished.id, finished.candidate);
    }
    function cancelGesture() {
        if (!gesture) return;
        const pointerId = gesture.pointerId; gesture = null;
        if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
        ghost.hidden = true; dialog.classList.remove('is-dragging');
    }
    function undoChange() {
        if (saving || !history.length) return;
        cancelGesture(); future.push(copy(draft)); draft = history.pop(); selectedId = null; renderDraft(); message('Change undone.');
    }
    function redoChange() {
        if (saving || !future.length) return;
        cancelGesture(); history.push(copy(draft)); draft = future.pop(); selectedId = null; renderDraft(); message('Change restored.');
    }
    function close() {
        if (saving || !dialog.open) return;
        cancelGesture(); dialog.close(); preview?.destroy(); preview = null; draft = null; selectedId = null;
    }
    function open() {
        if (destroyed || dialog.open) return;
        context = getContext();
        draft = copy(createCanvasLayout(getLayout(), context.accounts || [])); initial = copy(draft);
        history = []; future = []; selectedId = null; saving = false; zoom = 1;
        accountsSignature = JSON.stringify((context.accounts || []).map(account => [account.sub, account.email]));
        renderPalette(); renderDraft(); message('Changes apply to your day view when you save.'); dialog.showModal();
        if (viewport.clientWidth > 48 && viewport.clientHeight > 48) {
            zoom = Math.max(.05, Math.min(1, (viewport.clientWidth - 48) / draft.canvas.width, (viewport.clientHeight - 48) / draft.canvas.height));
            updateZoom();
        }
    }
    on(cancel, 'click', close); on(undo, 'click', undoChange); on(redo, 'click', redoChange);
    on(save, 'click', async () => {
        if (saving || gesture) return;
        saving = true; updateControls(); message('');
        try {
            await onSave(copy(validateLayout(draft)));
            if (destroyed) return;
            saving = false; close();
        } catch (error) { if (!destroyed) message(error.message || 'Your layout could not be saved. Please try again.', true); }
        finally { if (!destroyed) { saving = false; updateControls(); } }
    });
    on(zoomSelect, 'change', () => { cancelGesture(); zoom = Number(zoomSelect.value) / 100; updateZoom(); });
    on(fit, 'click', () => {
        cancelGesture(); zoom = Math.max(.05, Math.min(1, (viewport.clientWidth - 48) / draft.canvas.width, (viewport.clientHeight - 48) / draft.canvas.height)); updateZoom();
    });
    on(surface, 'pointerdown', event => { if (event.target === surface || event.target === overlays || event.target === previewRoot) select(null); });
    on(surface, 'pointermove', pointerMove); on(surface, 'pointerup', endGesture);
    on(surface, 'pointercancel', () => cancelGesture()); on(surface, 'lostpointercapture', () => cancelGesture());
    on(dialog, 'cancel', event => { event.preventDefault(); if (gesture) { cancelGesture(); message('Move cancelled.'); } else close(); });
    on(dialog, 'keydown', event => {
        if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); cancelGesture(); message('Move cancelled.'); return; }
        if (saving || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoChange() : undoChange(); return; }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return; }
        const widget = selected(), deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!widget || !deltas[event.key]) return;
        event.preventDefault(); const distance = event.shiftKey ? 10 : 1, [dx, dy] = deltas[event.key];
        const rect = moveRect(widget, dx * distance, dy * distance, draft.canvas);
        if (canPlace(rect, draft.widgets, draft.canvas, widget.id)) commitWidget(widget.id, rect);
        else message('Another component occupies that space.', true);
    });
    return {
        open, close,
        isOpen: () => dialog.open,
        update(next) {
            if (destroyed || !dialog.open) return;
            context = next;
            preview?.update(previewContext());
            const signature = JSON.stringify((context.accounts || []).map(account => [account.sub, account.email]));
            if (signature !== accountsSignature || catalogKey() !== catalogSignature) { accountsSignature = signature; renderPalette(); renderInspector(); renderOverlays(); }
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; cancelGesture(); listeners.abort(); preview?.destroy(); preview = null;
            if (dialog.open) dialog.close(); dialog.remove();
        },
    };
}
