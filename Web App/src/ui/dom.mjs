const icons = {
        sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
        calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h1m3 0h1m3 0h1M8 17h1m3 0h1"/>',
        checklist: '<path d="m3 6 1.5 1.5L7 4m3 2h11M3 12h4m3 0h11M3 18h4m3 0h11"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
        book: '<path d="M12 5v16M12 5C8 2 3 4 3 4v15s5-2 9 2c4-4 9-2 9-2V4s-5-2-9 1Z"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
        settings: '<path d="m9 3-.8 2.1-2.2.4L4.5 8l1 2-.5 2 .5 2-1 2L6 18.5l2.2.4L9 21h6l.8-2.1 2.2-.4 1.5-2.5-1-2 .5-2-.5-2 1-2L18 5.5l-2.2-.4L15 3Z"/><circle cx="12" cy="12" r="3"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
        logout: '<path d="M9 4H4v16h5m4-4 4-4-4-4m-5 4h13"/>',
        left: '<path d="m15 5-7 7 7 7"/>', right: '<path d="m9 5 7 7-7 7"/>',
        refresh: '<path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5m-4 9a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
        eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
        plus: '<path d="M12 4v16M4 12h16"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
    };
export function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'; }
export function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

export function renderIcons(root) {
    root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
}

export function localDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
