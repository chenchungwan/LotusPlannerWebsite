import { el } from '../ui/dom.mjs?v=components-1';
import { validateLayout, resolveLayout, resolveCanvasLayout } from './layout-model.mjs?v=components-1';

// The composition layer owns placement. Components never choose their neighbors.
export function createPlannerLayout({ root, registry, layout, actions = {} }) {
    let definition = validateLayout(layout);
    let context;
    const columns = new Map();
    const widgets = new Map();
    let destroyed = false;
    root.classList.add('layout-canvas');
    function position(parent, node, index) {
        if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
    }
    function instanceFor(widget) {
        const signature = JSON.stringify({ type: widget.type, options: widget.options });
        let instance = widgets.get(widget.id);
        if (instance && instance.signature !== signature) {
            instance.component.destroy(); instance.frame.remove(); widgets.delete(widget.id); instance = null;
        }
        if (!instance) {
            const factory = registry.get(widget.type);
            if (!factory) throw new Error('No component registered for ' + widget.type);
            const component = factory({ id: widget.id, options: widget.options, actions });
            const frame = el('div', 'layout-widget-frame');
            frame.dataset.widgetType = widget.type; frame.dataset.widgetId = widget.id;
            frame.append(component.element);
            instance = { component, frame, signature }; widgets.set(widget.id, instance);
        }
        return instance;
    }
    function render(nextContext) {
        if (destroyed) return;
        context = nextContext;
        const freeform = definition.version === 2;
        root.classList.toggle('freeform-layout', freeform);
        root.style.setProperty('--canvas-width', freeform ? definition.canvas.width + 'px' : 'auto');
        root.style.setProperty('--canvas-height', freeform ? definition.canvas.height + 'px' : 'auto');
        const activeColumns = new Set(), activeWidgets = new Set();
        if (freeform) {
            resolveCanvasLayout(definition, context.accounts).forEach((widget, index) => {
                activeWidgets.add(widget.id);
                const instance = instanceFor(widget);
                Object.assign(instance.frame.style, {
                    position: 'absolute', left: widget.x + 'px', top: widget.y + 'px',
                    width: widget.width + 'px', height: widget.height + 'px', flex: 'none',
                });
                instance.frame.classList.remove('fixed-widget-height');
                position(root, instance.frame, index);
                instance.component.update(context);
            });
        } else {
            resolveLayout(definition, context.accounts).forEach((spec, columnIndex) => {
                activeColumns.add(spec.id);
                let column = columns.get(spec.id);
                if (!column) {
                    column = el('div', 'layout-column'); column.dataset.columnId = spec.id;
                    columns.set(spec.id, column);
                }
                column.style.setProperty('--column-size', String(spec.size || 1));
                column.style.setProperty('--column-width', spec.width ? spec.width + 'px' : 'auto');
                column.classList.toggle('fixed-column', Boolean(spec.width));
                position(root, column, columnIndex);
                spec.widgets.forEach((widget, widgetIndex) => {
                    activeWidgets.add(widget.id);
                    const instance = instanceFor(widget);
                    Object.assign(instance.frame.style, { position: '', left: '', top: '', width: '', height: '' });
                    instance.frame.style.flex = widget.height ? '0 0 ' + widget.height + 'px' : String(widget.flex || 1) + ' 1 0';
                    instance.frame.style.setProperty('--widget-height', widget.height ? widget.height + 'px' : 'auto');
                    instance.frame.classList.toggle('fixed-widget-height', Boolean(widget.height));
                    position(column, instance.frame, widgetIndex);
                    instance.component.update(context);
                });
            });
        }
        for (const [key, instance] of widgets) {
            if (!activeWidgets.has(key)) { instance.component.destroy(); instance.frame.remove(); widgets.delete(key); }
        }
        for (const [key, column] of columns) {
            if (!activeColumns.has(key)) { column.remove(); columns.delete(key); }
        }
    }
    return {
        update: render,
        tick(nextContext = context) { if (!destroyed) for (const instance of widgets.values()) instance.component.tick?.(nextContext); },
        setLayout(next) { definition = validateLayout(next); if (context) render(context); },
        getLayout() { return validateLayout(definition); },
        destroy() {
            destroyed = true;
            for (const instance of widgets.values()) instance.component.destroy();
            widgets.clear(); columns.clear(); root.replaceChildren();
        },
    };
}
