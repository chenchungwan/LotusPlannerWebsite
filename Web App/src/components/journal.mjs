import { el, localDate } from '../ui/dom.mjs?v=pocky-1';
import { compressImages, safeJournalImageData } from '../services/journal-images.mjs?v=journal-1';
import { JOURNAL_LIMITS } from '../state/journal-model.mjs?v=journal-1';

let sequence = 0;
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
function button(text, action, className = 'journal-button') {
    const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}
const message = (error, fallback) => typeof error === 'string' ? error : error?.message || fallback;
const primarySub = context => context?.accounts?.find(account => account.isPrimary)?.sub || context?.accounts?.[0]?.sub;

/** One view of the shared journal draft. Persistence and all mutations belong to the controller. */
export function createJournal({ id, options = {}, actions = {} }) {
    const element = el('section', 'journal-panel planner-widget'); element.dataset.widgetId = id;
    const header = el('div', 'column-heading journal-heading');
    const title = el('h2', '', options.title || 'Journal'); title.id = 'journal-title-' + (++sequence); element.setAttribute('aria-labelledby', title.id);
    const date = el('time', 'journal-date'); header.append(title, date);
    const status = el('div', 'journal-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const notice = el('div', 'journal-notice'); notice.setAttribute('role', 'status');
    const content = el('div', 'journal-content');
    const hint = el('p', 'journal-hint', 'Write a note, paste an image, or drop images here.');
    const toolbar = el('div', 'journal-toolbar');
    const addText = button('Add text', () => invoke('addJournalText', renderedDay));
    const addImages = button('Add images', () => {
        if (!editable()) return;
        inputDay = renderedDay; fileInput.click();
    });
    const save = button('Save', () => invoke('saveJournal', renderedDay), 'journal-button journal-save');
    const discard = button('Discard changes', () => askDiscard(false));
    toolbar.append(addText, addImages, save, discard);
    const fileInput = el('input', 'journal-file-input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif'; fileInput.hidden = true; fileInput.setAttribute('aria-label', 'Choose journal images');
    const confirm = el('div', 'journal-discard-confirm'); confirm.hidden = true;
    const confirmText = el('p');
    const keep = button('Keep editing', () => { confirm.hidden = true; discardDay = undefined; });
    const lose = button('Discard changes', async () => {
        const day = discardDay;
        if (!editable() || !day) return;
        confirm.hidden = true; discardDay = undefined;
        await invoke('discardJournal', day);
    });
    confirm.append(confirmText, keep, lose);
    element.append(header, status, notice, content, hint, toolbar, fileInput, confirm);
    let current, renderedDay, inputDay, destroyed = false, localError, discardDay, pending = false;
    const uploads = new Map();
    const records = new Map();

    function journal() { return current?.journal || { status: 'loading', blocks: [], images: {} }; }
    function editable() { return !destroyed && !current?.isLayoutPreview && journal().status === 'ready' && journal().day === renderedDay && !journal().saving && !pending; }
    async function invoke(name, ...args) {
        if (destroyed || current?.isLayoutPreview || (name !== 'refreshJournal' && name !== 'connectLogs' && !editable())) return false;
        const day = renderedDay;
        try {
            const result = actions[name]?.(...args);
            if (result?.then) { pending = name; renderState(); await result; }
            if (!destroyed && localError?.day === day) localError = undefined;
            return true;
        } catch (error) {
            if (!destroyed) localError = { day, text: message(error, 'Couldn’t save your journal. Try again.') };
            return false;
        } finally { pending = false; if (!destroyed) renderState(); }
    }
    function askDiscard(refresh) {
        if (!editable()) return;
        if (!journal().dirty) { if (refresh) void invoke('refreshJournal'); return; }
        discardDay = renderedDay;
        confirmText.textContent = refresh ? 'Discard your unsaved changes and load the latest journal?' : 'Discard your unsaved changes for this day?';
        lose.textContent = refresh ? 'Discard and load latest' : 'Discard changes';
        confirm.hidden = false;
    }
    function renderState() {
        if (destroyed) return;
        const state = journal(), activeUpload = uploads.has(renderedDay), canEdit = editable();
        const local = localError?.day === renderedDay && localError.text;
        status.className = 'journal-status' + (state.dirty ? ' is-dirty' : '');
        if (state.day && state.day !== renderedDay || state.status === 'loading') status.textContent = 'Loading journal…';
        else if (pending === 'connectLogs') status.textContent = 'Connecting…';
        else if (pending === 'refreshJournal') status.textContent = 'Loading journal…';
        else if (state.saving || pending) status.textContent = 'Saving…';
        else if (activeUpload) status.textContent = 'Preparing images…';
        else if (state.conflict) status.textContent = 'Changes found in the cloud';
        else if (state.dirty) status.textContent = 'Unsaved changes';
        else if (local || state.error) status.textContent = 'Journal needs attention';
        else if (state.status === 'ready') status.textContent = state.modifiedAt || state.blocks?.length ? 'Saved' : 'Ready to write';
        else status.textContent = 'Journal unavailable';
        notice.replaceChildren(); notice.hidden = true;
        if (local || state.error || state.conflict || state.status === 'unconfigured' || state.status === 'error') {
            notice.hidden = false;
            const text = local || (state.conflict ? 'A newer journal is available. Your unsaved changes are still here.' : message(state.error, state.status === 'unconfigured' ? 'Connect cloud logs to use your journal.' : 'Couldn’t load your journal. Try again.'));
            notice.append(el('span', '', text));
            if (state.conflict) {
                const latest = button('Load latest', () => askDiscard(true)); latest.disabled = !canEdit; notice.append(latest);
            } else if (state.needsSignIn || state.status === 'error' || state.status === 'unconfigured') {
                const retry = button(state.needsSignIn ? 'Connect Google' : 'Try again', () => invoke(state.needsSignIn ? 'connectLogs' : 'refreshJournal'));
                retry.disabled = Boolean(current?.isLayoutPreview || pending); notice.append(retry);
            }
        }
        addText.disabled = !canEdit; addImages.disabled = !canEdit || activeUpload; fileInput.disabled = !canEdit || activeUpload;
        save.disabled = !canEdit || !state.dirty || activeUpload || Boolean(state.conflict);
        discard.disabled = !canEdit || !state.dirty || activeUpload;
        keep.disabled = lose.disabled = !canEdit;
        hint.hidden = Boolean(current?.isLayoutPreview);
        for (const record of records.values()) {
            if (record.editor) record.editor.disabled = !canEdit;
            if (record.remove) record.remove.disabled = !canEdit;
        }
    }
    function createBlock(block, day, index) {
        const root = el('div', 'journal-block journal-block-' + (['text', 'image'].includes(block.type) ? block.type : 'unsupported'));
        root.dataset.blockId = block.id;
        const remove = button('Remove', () => invoke('removeJournalBlock', { day, id: block.id }), 'journal-button journal-remove');
        remove.setAttribute('aria-label', 'Remove journal block ' + (index + 1));
        const record = { root, type: block.type, remove };
        if (block.type === 'text') {
            const editor = el('textarea', 'journal-text'); editor.placeholder = 'Start writing…'; editor.rows = 5; editor.maxLength = JOURNAL_LIMITS.text;
            editor.setAttribute('aria-label', 'Journal text ' + (index + 1) + ' for ' + day);
            editor.addEventListener('input', async () => {
                if (!editable()) return;
                const submitted = editor.value;
                const accepted = await invoke('updateJournalText', { day, id: block.id, text: submitted });
                if (accepted || destroyed || renderedDay !== day || records.get(String(block.id)) !== record || editor.value !== submitted) return;
                // A rejected edit never enters the shared draft. Keep the visible
                // text aligned with what Save will actually persist.
                const latest = journal().day === day ? journal().blocks?.find(item => item.id === block.id && item.type === 'text') : undefined;
                const restored = latest ? typeof latest.text === 'string' ? latest.text : '' : record.lastText || '';
                const start = editor.selectionStart, end = editor.selectionEnd, direction = editor.selectionDirection;
                editor.value = restored; record.lastText = restored;
                if (document.activeElement === editor && typeof editor.setSelectionRange === 'function') editor.setSelectionRange(Math.min(start || 0, restored.length), Math.min(end || 0, restored.length), direction);
            });
            root.append(editor, remove); record.editor = editor;
        } else if (block.type === 'image') {
            const frame = el('div', 'journal-image-frame');
            root.append(frame, remove); record.frame = frame;
        } else {
            root.append(el('p', 'journal-unsupported', 'This journal block is not supported here. Its original content is preserved.'));
            // Unsupported raw blocks remain untouched rather than exposing a destructive remove action.
            record.remove = undefined;
        }
        return record;
    }
    function updateBlock(record, block, index) {
        if (record.remove) record.remove.hidden = !journal().blocks?.some(item => item.id === block.id);
        if (record.editor) {
            const text = typeof block.text === 'string' ? block.text : '';
            if (record.lastText !== text) {
                if (record.editor.value !== text) {
                    const focused = document.activeElement === record.editor;
                    const start = record.editor.selectionStart, end = record.editor.selectionEnd, direction = record.editor.selectionDirection;
                    record.editor.value = text;
                    if (focused && typeof record.editor.setSelectionRange === 'function') record.editor.setSelectionRange(Math.min(start || 0, text.length), Math.min(end || 0, text.length), direction);
                }
                record.lastText = text;
            }
            record.editor.setAttribute('aria-label', 'Journal text ' + (index + 1) + ' for ' + renderedDay);
        }
        if (record.frame) {
            const image = journal().images?.[block.image];
            const data = image?.data;
            const signature = JSON.stringify([block.crop, block.w, block.h]);
            if (record.imageData !== data || record.imageSignature !== signature) {
                record.imageData = data; record.imageSignature = signature; record.frame.replaceChildren();
                if (safeJournalImageData(data)) {
                    const img = el('img', 'journal-image'); img.src = data; img.alt = 'Journal attachment ' + (index + 1); img.loading = 'lazy';
                    img.addEventListener('error', () => {
                        if (destroyed || record.imageData !== data || record.imageSignature !== signature) return;
                        record.frame.className = 'journal-image-frame'; record.frame.style.aspectRatio = '';
                        record.frame.replaceChildren(el('p', 'journal-unsupported', 'This image could not be displayed. Its original attachment is preserved.'));
                    });
                    const crop = block.crop;
                    const validCrop = crop && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(crop[key])) && crop.x >= 0 && crop.y >= 0 && crop.w > 0 && crop.h > 0 && crop.x + crop.w <= 1.00001 && crop.y + crop.h <= 1.00001;
                    if (Number.isFinite(block.w) && Number.isFinite(block.h) && block.w > 0 && block.h > 0) record.frame.style.aspectRatio = String(block.w / block.h);
                    else record.frame.style.aspectRatio = '';
                    if (validCrop) {
                        record.frame.className = 'journal-image-frame is-cropped';
                        Object.assign(img.style, { position: 'absolute', width: (100 / crop.w) + '%', height: (100 / crop.h) + '%', left: (-100 * crop.x / crop.w) + '%', top: (-100 * crop.y / crop.h) + '%', maxWidth: 'none' });
                    } else record.frame.className = 'journal-image-frame';
                    record.frame.append(img);
                } else {
                    record.frame.className = 'journal-image-frame'; record.frame.style.aspectRatio = '';
                    record.frame.append(el('p', 'journal-unsupported', data ? 'Unsupported image format. The original attachment is preserved.' : 'This image is unavailable. Its reference is preserved.'));
                }
            }
        }
    }
    function update(context) {
        if (destroyed) return;
        current = context;
        const day = localDate(context.day);
        if (renderedDay !== day) {
            renderedDay = day; records.clear(); content.replaceChildren(); confirm.hidden = true; discardDay = undefined;
        }
        date.textContent = dateFormat.format(context.day); date.setAttribute('datetime', day);
        const state = journal();
        const blocks = state.day === day && Array.isArray(state.blocks) ? state.blocks : [];
        const displayed = blocks.length ? blocks : [{ id: 'lotus-text-' + day, type: 'text', text: '' }];
        const kept = new Set();
        displayed.forEach((block, index) => {
            const key = String(block.id ?? 'unsupported-' + index); kept.add(key);
            let record = records.get(key);
            if (record && record.type !== block.type) { record.root.remove(); records.delete(key); record = undefined; }
            if (!record) { record = createBlock(block, day, index); records.set(key, record); }
            updateBlock(record, block, index);
            if (content.children[index] !== record.root) content.insertBefore(record.root, content.children[index] || null);
        });
        for (const [key, record] of records) if (!kept.has(key)) { record.root.remove(); records.delete(key); }
        renderState();
    }
    async function attach(files, day = renderedDay) {
        if (!editable() || !files?.length) return;
        const owner = primarySub(current);
        uploads.set(day, (uploads.get(day) || 0) + 1); localError = undefined; renderState();
        try {
            const images = await compressImages(files);
            if (!destroyed && !current?.isLayoutPreview && owner && primarySub(current) === owner) await actions.addJournalImages?.({ day, images });
        } catch (error) {
            if (!destroyed) localError = { day, text: message(error, 'Couldn’t attach these images. Try again.') };
        } finally {
            const count = (uploads.get(day) || 1) - 1;
            if (count) uploads.set(day, count); else uploads.delete(day);
            if (!destroyed) renderState();
        }
    }
    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []), day = inputDay || renderedDay;
        fileInput.value = ''; inputDay = undefined; return attach(files, day);
    });
    element.addEventListener('paste', event => {
        if (!editable()) return;
        const clipboard = event.clipboardData;
        const files = Array.from(clipboard?.files || []);
        if (!files.length) for (const item of Array.from(clipboard?.items || [])) if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
        if (files.length) { event.preventDefault(); return attach(files); }
    });
    element.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
    element.addEventListener('drop', event => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) { event.preventDefault(); if (editable()) return attach(files); }
    });
    return { element, update, destroy() { if (destroyed) return; destroyed = true; records.clear(); uploads.clear(); element.replaceChildren(); element.remove(); } };
}
