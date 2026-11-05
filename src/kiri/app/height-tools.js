/**
 * Colour by height, like Orca's filament change on the preview's layer
 * slider: put the slider on a layer, press + and pick a slot; from that layer
 * up the whole plate prints with that slot. The changes show as coloured
 * marks along the slider (tap one to change or remove it).
 *
 * Stored per object in widget.anno.heights as [{ z, tool }] (z: top of the
 * layer in the object's own height), the same list on every object of the
 * plate; the slicer switches the slices from there (slice.js).
 */

import { api } from './api.js';
import { slotInfo } from './slots.js';

let layerZ = [];          // per preview layer: top z (from the last export)
let wrap, plus, marks, pop;

function el(tag, css, text) {
    const e = document.createElement(tag);
    e.style.cssText = css || '';
    if (text !== undefined) e.textContent = text;
    return e;
}

function hex(i) {
    const c = slotInfo(i)?.color;
    return isNaN(c) ? '#cccccc' : '#' + c.toString(16).padStart(6, '0');
}

function ink(h) {
    const n = parseInt(h.slice(1), 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#222' : '#fff';
}

function changes() {
    const w = api.widgets.all()[0];
    return (w?.anno.heights || []).slice().sort((a, b) => a.z - b.z);
}

// write the list to every object of the plate and slice again
function store(list) {
    for (const w of api.widgets.all()) {
        w.anno.heights = list.map(c => ({ ...c }));
        w.modified = true;
    }
    api.conf.save();
    api.space.save?.();
    api.function.clear_progress();
    api.function.prepare();
}

function closePop() {
    pop?.remove();
    pop = null;
}

// slot picker under / above a button; remove when editing an existing change
function picker(anchor, title, current, onpick, onremove) {
    closePop();
    pop = el('div', 'position:fixed;z-index:60;display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:#fff;' +
        'border:1px solid #bbb;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);font:12px sans-serif;color:#222');
    pop.onpointerdown = ev => ev.stopPropagation();
    pop.appendChild(el('div', 'font-weight:bold', title));
    const row = el('div', 'display:flex;flex-direction:row;gap:5px');
    const count = api.conf.get().device.extruders?.length || 1;
    for (let i = 0; i < count; i++) {
        const c = hex(i);
        const b = el('button', `width:32px;height:32px;padding:0;justify-content:center;align-items:center;border-radius:5px;font-weight:bold;` +
            `background:${c};color:${ink(c)};border:${i === current ? '3px solid #2b6' : '1px solid #888'}`, String(i + 1));
        const s = slotInfo(i);
        b.title = s ? `slot ${i + 1} · ${s.material} ${s.name || ''}` : `slot ${i + 1}`;
        b.onclick = ev => { ev.stopPropagation(); closePop(); onpick(i); };
        row.appendChild(b);
    }
    pop.appendChild(row);
    if (onremove) {
        const del = el('button', 'padding:4px 8px;border:1px solid #bbb;border-radius:5px;background:#f6f6f6;color:#c62828;justify-content:center', 'remove this change');
        del.onclick = ev => { ev.stopPropagation(); closePop(); onremove(); };
        pop.appendChild(del);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - pw - 8, r.left + r.width / 2 - pw / 2))}px`;
    pop.style.top = `${r.top - ph - 8 >= 8 ? r.top - ph - 8 : r.bottom + 8}px`;
}

// layer index whose top is at z (the first one at or above it)
function layerOf(z) {
    const i = layerZ.findIndex(v => v != null && v >= z - 0.001);
    return i < 0 ? layerZ.length - 1 : i;
}

function addAtLayer() {
    const { hi } = api.slider.getRange();
    const z = layerZ[hi];
    if (!(z > 0) || !layerZ.length) {
        api.show.alert('preview first, then put the slider on the layer to change at', 3);
        return;
    }
    const list = changes();
    // the slot printing right below, as a hint
    let current = api.widgets.all()[0]?.anno.extruder ?? 0;
    for (const c of list) if (c.z < z - 0.001) current = c.tool;
    picker(plus, `from layer ${hi + 1} (${z.toFixed(2)} mm) print with`, current, tool => {
        store([ ...list.filter(c => Math.abs(c.z - z) > 0.001), { z, tool } ]);
    });
}

// coloured marks along the slider where the changes are
function renderMarks() {
    if (!marks) return;
    marks.innerHTML = '';
    const center = document.getElementById('slider-center');
    const hiHandle = document.getElementById('slider-hi');
    const { hi, max } = api.slider.getRange();
    const list = changes();
    if (!center || !hiHandle || !max || !layerZ.length || !list.length) return;
    // the hi handle sits at c0 + frac * span: measure c0 from where it is now
    const bar = document.getElementById('slider')?.classList.contains('slider-mobile') ? 80 : 30;
    const span = center.clientWidth - bar * 2;
    const cr = center.getBoundingClientRect(), hr = hiHandle.getBoundingClientRect();
    const c0 = hr.left + hr.width / 2 - cr.left - (hi / max) * span;
    for (const c of list) {
        const i = layerOf(c.z);
        const col = hex(c.tool);
        const m = el('div', `position:absolute;top:-14px;width:16px;height:16px;margin-left:-8px;border-radius:50% 50% 50% 0;` +
            `transform:rotate(-45deg);background:${col};border:1px solid #555;cursor:pointer;pointer-events:auto`);
        m.style.left = `${c0 + (i / max) * span}px`;
        m.title = `layer ${i + 1} (${c.z.toFixed(2)} mm): slot ${c.tool + 1} · tap to change`;
        m.onpointerdown = ev => ev.stopPropagation();
        m.onclick = ev => {
            ev.stopPropagation();
            picker(m, `at layer ${i + 1} (${c.z.toFixed(2)} mm) print with`, c.tool,
                tool => store(changes().map(o => Math.abs(o.z - c.z) < 0.001 ? { z: o.z, tool } : o)),
                () => store(changes().filter(o => Math.abs(o.z - c.z) >= 0.001)));
        };
        marks.appendChild(m);
    }
}

function visible(on) {
    if (!wrap) return;
    const fdm = api.mode.get() === 'FDM';
    plus.style.display = on && fdm ? 'flex' : 'none';
    marks.style.display = on && fdm ? 'block' : 'none';
    if (!on) closePop();
    if (on) setTimeout(renderMarks);
}

export function initHeightTools() {
    const slider = document.getElementById('slider');
    const center = document.getElementById('slider-center');
    if (!slider || !center || wrap) return;
    wrap = slider;
    plus = el('button', 'display:none;align-items:center;justify-content:center;flex:none;min-width:28px;margin:0 0 0 4px;padding:0 6px;' +
        'border:1px solid #3b82f6;border-radius:5px;background:#fff;color:#3b82f6;font:bold 16px sans-serif;text-transform:none', '+');
    plus.id = 'height-add';
    plus.title = 'change filament from this layer up (colour by height)';
    plus.onpointerdown = ev => ev.stopPropagation();
    plus.onclick = ev => { ev.stopPropagation(); addAtLayer(); };
    slider.appendChild(plus);
    marks = el('div', 'display:none;position:absolute;left:0;right:0;top:0;height:0;pointer-events:none;z-index:5');
    marks.id = 'height-marks';
    center.appendChild(marks);

    document.addEventListener('pointerdown', () => closePop());
    api.event.on('print.layers', z => { layerZ = z || []; renderMarks(); });
    api.event.on('preview.end', () => visible(true));
    for (const ev of [ 'slice.begin', 'preview.begin' ]) api.event.on(ev, () => { layerZ = []; visible(false); });
    api.event.on('view.set', () => visible(api.view.is_preview?.() ?? false));
    api.event.on('mode.set', () => visible(false));
    window.addEventListener('resize', () => renderMarks());
}

export const heightTools = { init: initHeightTools, changes };
