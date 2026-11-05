/**
 * Arrange toolbar (FDM): move, rotate, scale, lay flat and colour paint,
 * with one active tool at a time, modelled on Anycubic Slicer Next.
 */

import { api } from './api.js';
import { colorPaint } from './color-paint.js';
import { slotInfo, onSlots } from './slots.js';
import { colorSchemeRegistry } from './color/schemes.js';
import * as faceTool from './face-tool.js';
import { space } from '../../moto/space.js';
import { rotateGizmo } from './rotate-gizmo.js';

const DEG = Math.PI / 180;
let tool = 'move';
let paintSlot = 0;
let erase = false;
let movePanel = false;  // the move tool's nudge panel (tap the move tool again)
let step = 10;
let bar, panel, body;
// positions the user dragged the toolbar / panel to (null: default spot)
const POS_KEY = 'kiri-toolbar-pos';
let pos = {};
try { pos = JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch { pos = {}; }

const TOOLS = [
    { id: 'camera', icon: 'fa-video',                     title: 'camera: dragging always turns the view (tap still selects)' },
    { id: 'move',   icon: 'fa-arrows-up-down-left-right', title: 'move / select (esc) · tap again for position and nudge buttons' },
    { id: 'rotate', icon: 'fa-rotate',                    title: 'rotate' },
    { id: 'scale',  icon: 'fa-expand',                    title: 'scale / size' },
    { id: 'flat',   icon: 'fa-angles-down',               title: 'lay flat: click a face to put it on the bed' },
    { id: 'paint',  icon: 'fa-paintbrush',                title: 'colour paint' },
];

// one-shot actions on the selection, after the tools
const ACTIONS = [
    { id: 'duplicate', icon: 'fa-clone',     title: 'duplicate (ctrl+d)', run: duplicate },
    { id: 'delete',    icon: 'fa-trash-can', title: 'delete (del)',       run: () => api.platform.delete(api.selection.meshes()) },
];

function el(tag, css, text) {
    const e = document.createElement(tag);
    e.style.cssText = css || '';
    if (text !== undefined) e.textContent = text;
    return e;
}

function slotHex(i) {
    const slot = slotInfo(i);
    if (slot && !isNaN(slot.color)) return '#' + slot.color.toString(16).padStart(6, '0');
    const scheme = colorSchemeRegistry.getScheme(api.mode.get_id(), 'light').widget.deselected;
    return '#' + scheme[i % scheme.length].toString(16).padStart(6, '0');
}

// readable number on a coloured swatch
function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#222' : '#fff';
}

// copy the selection and select the copies, ready to move or copy again
function duplicate() {
    const before = new Set(api.widgets.all());
    api.selection.duplicate();
    const copies = api.widgets.all().filter(w => !before.has(w));
    if (!copies.length) return;
    api.platform.deselect();
    copies.forEach(w => api.platform.select(w, true));
}

function needSelection() {
    if (api.selection.widgets().length) return true;
    api.show.alert('select an object first', 2);
    return false;
}

function hideKiriPanel(id) {
    const p = document.getElementById(id);
    if (p && !p.classList.contains('hide')) document.getElementById(`context-${id.replace('panel-', '')}-panel`)?.click();
}

function setTool(next) {
    // leave the previous tool
    if (tool === 'paint' && next !== 'paint') colorPaint.done();
    if (tool === 'scale' && next !== 'scale') hideKiriPanel('panel-scale');
    if (tool === 'flat' && next !== 'flat') faceTool.endIt?.();
    if (tool === 'rotate' && next !== 'rotate') rotateGizmo.stop();
    tool = next;
    space.cameraOnly(next === 'camera');
    // enter the new one
    if (next === 'scale') {
        if (!needSelection()) return setTool('move');
        const p = document.getElementById('panel-scale');
        if (p?.classList.contains('hide')) document.getElementById('context-scale-panel')?.click();
    } else if (next === 'flat') {
        faceTool.startLayFlat();
    } else if (next === 'paint') {
        colorPaint.start(paintSlot, { erase });
    } else if (next === 'rotate') {
        rotateGizmo.start();
    }
    render();
}

function renderPanel() {
    body.innerHTML = '';
    panel.style.display = (tool === 'paint' || tool === 'rotate' || (tool === 'move' && movePanel)) ? 'block' : 'none';
    const title = text => body.appendChild(el('div', 'display:block;font-weight:bold;margin-bottom:2px', text));
    const button = (text, onclick, css = '') => {
        const b = el('button', 'display:inline-block;padding:4px 8px;border:1px solid #bbb;border-radius:5px;background:#f6f6f6;color:#222;cursor:pointer;font:12px sans-serif;' + css, text);
        b.onclick = ev => { ev.stopPropagation(); onclick(); };
        return b;
    };
    const row = () => el('div', 'display:flex;flex-direction:row;gap:5px;align-items:center;flex-wrap:wrap');

    if (tool === 'paint') {
        title('Filaments');
        const swatches = row();
        const count = api.conf.get().device.extruders?.length || 1;
        for (let i = 0; i < count; i++) {
            const hex = slotHex(i);
            const active = !erase && i === paintSlot;
            const b = button(String(i + 1), () => { paintSlot = i; erase = false; colorPaint.start(paintSlot, { erase }); render(); },
                `width:30px;height:30px;padding:0;font-weight:bold;background:${hex};color:${inkFor(hex)};` +
                `border:${active ? '3px solid #2b6' : '1px solid #888'};box-shadow:${active ? '0 0 0 1px #fff inset' : 'none'}`);
            b.title = slotInfo(i) ? `slot ${i + 1} · ${slotInfo(i).material} ${slotInfo(i).name || ''}` : `slot ${i + 1}`;
            swatches.appendChild(b);
        }
        const eraser = button('eraser', () => { erase = !erase; colorPaint.start(paintSlot, { erase }); render(); },
            erase ? 'background:#2b6;color:#fff;border-color:#2b6' : '');
        eraser.title = 'erase colour paint (or hold shift while painting)';
        swatches.appendChild(eraser);
        body.appendChild(swatches);

        title('Pen size');
        const size = row();
        const slider = el('input', 'display:block;flex:1;min-width:120px');
        slider.type = 'range';
        slider.min = 0.5; slider.max = 10; slider.step = 0.5;
        slider.value = colorPaint.getBrush();
        const value = el('span', 'display:inline-block;min-width:44px;text-align:right', `${colorPaint.getBrush()} mm`);
        slider.oninput = () => { colorPaint.setBrush(parseFloat(slider.value)); value.textContent = `${colorPaint.getBrush()} mm`; };
        size.append(slider, value);
        body.appendChild(size);

        const actions = row();
        actions.appendChild(button('erase all painting', () => colorPaint.clear()));
        body.appendChild(actions);
        body.appendChild(el('div', 'display:block;color:#777;font-size:11px',
            'drag over the model to paint · [ ] pen size · shift erases · esc back to move'));
    }

    if (tool === 'move' && movePanel) {
        const sel = api.selection.widgets();
        const dev = api.conf.get().device;
        title(sel.length ? `Move selection (${sel.length})` : 'Move — select an object first');
        const steps = row();
        steps.appendChild(el('span', 'display:inline-block;width:40px', 'step'));
        for (const s of [ 1, 10 ]) {
            steps.appendChild(button(`${s} mm`, () => { step = s; render(); },
                s === step ? 'background:#3b82f6;color:#fff;border-color:#3b82f6' : ''));
        }
        body.appendChild(steps);
        // arrows as seen from the front of the printer: up = towards the back (+Y)
        const nudge = (dx, dy) => { if (needSelection()) { api.selection.move(dx * step, dy * step, 0); render(); } };
        const pad = el('div', 'display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,40px);gap:4px;justify-content:center');
        const cell = (text, fn, title) => { const b = button(text, fn, 'width:44px;height:40px;font-size:18px;padding:0'); b.title = title; return b; };
        pad.append(el('span'), cell('↑', () => nudge(0, 1), 'towards the back'), el('span'),
            cell('←', () => nudge(-1, 0), 'left'), cell('⊙', () => {
                if (!needSelection()) return;
                // centre the selection on the bed
                const ps = sel.map(w => w.track.pos);
                api.selection.move(-ps.reduce((a, p) => a + p.x, 0) / ps.length, -ps.reduce((a, p) => a + p.y, 0) / ps.length, 0);
                render();
            }, 'centre on the bed'), cell('→', () => nudge(1, 0), 'right'),
            el('span'), cell('↓', () => nudge(0, -1), 'towards the front'), el('span'));
        body.appendChild(pad);
        if (sel.length === 1) {
            // position of the object's centre, measured from the front-left corner of the bed
            const pos = sel[0].track.pos;
            const fields = row();
            for (const [axis, size] of [ ['x', dev.bedWidth], ['y', dev.bedDepth] ]) {
                fields.appendChild(el('span', 'display:inline-block;width:14px;font-weight:bold', axis.toUpperCase()));
                const input = el('input', 'display:inline-block;width:70px;padding:3px;font:12px sans-serif');
                input.type = 'number';
                input.step = '0.5';
                input.value = (pos[axis] + size / 2).toFixed(1);
                input.onchange = () => {
                    const v = parseFloat(input.value);
                    if (isNaN(v)) return;
                    const d = v - size / 2 - sel[0].track.pos[axis];
                    api.selection.move(axis === 'x' ? d : 0, axis === 'y' ? d : 0, 0);
                    render();
                };
                fields.appendChild(input);
            }
            fields.appendChild(el('span', 'color:#777', 'mm'));
            body.appendChild(fields);
        }
        body.appendChild(el('div', 'display:block;color:#777;font-size:11px',
            'tip: on a touch screen, drag a selected object with one finger'));
    }

    if (tool === 'rotate') {
        title('Rotate selection');
        body.appendChild(el('div', 'display:block;color:#777;font-size:11px',
            'drag a ring (red X, green Y, blue Z) in 5° steps, shift for 1°'));
        for (const [axis, label] of [ ['z', 'Z'], ['x', 'X'], ['y', 'Y'] ]) {
            const r = el('div', 'display:flex;flex-direction:row;gap:4px;align-items:center;flex-wrap:nowrap');
            r.appendChild(el('span', 'display:inline-block;width:18px;font-weight:bold', label));
            for (const deg of [ -90, -15, 15, 90 ]) {
                r.appendChild(button(`${deg > 0 ? '+' : ''}${deg}°`, () => {
                    if (!needSelection()) return;
                    api.selection.rotate(axis === 'x' ? deg * DEG : 0, axis === 'y' ? deg * DEG : 0, axis === 'z' ? deg * DEG : 0);
                }));
            }
            body.appendChild(r);
        }
        const actions = row();
        actions.appendChild(button('lay flat…', () => setTool('flat')));
        actions.appendChild(button('reset rotation', () => { if (needSelection()) document.getElementById('unrotate')?.click(); }));
        actions.appendChild(button('exact angles…', () => { if (needSelection()) document.getElementById('context-rotate-panel')?.click(); }));
        body.appendChild(actions);
    }
}

function savePos() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { }
}

// drag `target` by `handle` (mouse or finger); double click puts it back
function draggable(handle, target, key) {
    handle.style.touchAction = 'none';
    handle.onpointerdown = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const r = target.getBoundingClientRect();
        const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
        handle.setPointerCapture(ev.pointerId);
        handle.style.cursor = 'grabbing';
        handle.onpointermove = e => { pos[key] = { x: e.clientX - dx, y: e.clientY - dy }; layout(); };
        handle.onpointerup = handle.onpointercancel = () => {
            handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
            handle.style.cursor = 'grab';
            savePos();
        };
    };
    handle.onclick = ev => ev.stopPropagation();
    handle.ondblclick = ev => { ev.stopPropagation(); delete pos[key]; savePos(); layout(); };
}

function render() {
    if (!bar) return;
    bar.innerHTML = '';
    const grip = el('div', 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;min-height:14px;' +
        'color:#999;cursor:grab;font-size:14px;user-select:none', '⠿');
    grip.title = 'drag to move the toolbar · double click: back to its place';
    grip.className = 'tool-grip';
    draggable(grip, bar, 'bar');
    bar.appendChild(grip);
    const icon = (b, name) => { b.appendChild(el('i', 'font-size:15px', '')).className = `fas ${name}`; };
    for (const t of TOOLS) {
        const active = t.id === tool;
        const b = el('button', `display:inline-flex;align-items:center;justify-content:center;width:34px;height:30px;border-radius:6px;` +
            `border:1px solid ${active ? '#3b82f6' : '#ccc'};background:${active ? '#3b82f6' : '#f7f7f7'};color:${active ? '#fff' : '#333'};cursor:pointer`);
        b.title = t.title;
        icon(b, t.icon);
        b.onclick = ev => {
            ev.stopPropagation();
            if (t.id === 'move') {
                // tapping move again shows / hides the position and nudge panel
                movePanel = tool === 'move' ? !movePanel : movePanel;
                setTool('move');
            } else {
                setTool(t.id === tool ? 'move' : t.id);
            }
        };
        bar.appendChild(b);
    }
    // divider: 1px along the bar, full width across it (row or column)
    bar.appendChild(el('span', 'flex:0 0 1px;align-self:stretch;background:#ccc;margin:2px'));
    for (const a of ACTIONS) {
        const b = el('button', 'display:inline-flex;align-items:center;justify-content:center;width:34px;height:30px;border-radius:6px;' +
            `border:1px solid #ccc;background:#f7f7f7;color:${a.id === 'delete' ? '#c62828' : '#333'};cursor:pointer`);
        b.title = a.title;
        icon(b, a.icon);
        b.onclick = ev => { ev.stopPropagation(); if (needSelection()) a.run(); };
        bar.appendChild(b);
    }
    renderPanel();
    layout();
}

// keep a dragged element on screen (its grip at least)
function placed(e, p) {
    const x = Math.min(Math.max(0, p.x), window.innerWidth - Math.min(e.offsetWidth || 60, window.innerWidth));
    const y = Math.min(Math.max(14, p.y), window.innerHeight - 40);
    return { top: `${y}px`, bottom: 'auto', left: `${x}px` };
}

// desktop: a column along the settings panel, the tool panel beside it;
// narrow screens: a footer under the app, panel above it; desktop: where the user dragged it
let footer = 0;   // height the app gives up for the footer
function layout() {
    const narrow = window.innerWidth < 760;
    bar.style.flexDirection = narrow ? 'row' : 'column';
    // phones: a footer across the bottom (the app ends above it, so it covers
    // nothing), scrolling sideways when it does not fit; dragging is a desktop thing
    Object.assign(bar.style, narrow ?
        { top: 'auto', bottom: '0', left: '0', right: '0', transform: 'none', maxWidth: 'none', overflowX: 'auto',
          boxSizing: 'border-box', justifyContent: 'center', borderRadius: '0', border: '0', borderTop: '1px solid #ccc',
          padding: '4px 4px calc(4px + env(safe-area-inset-bottom))', background: '#fff' } :
        { right: 'auto', transform: 'none', maxWidth: 'none', overflowX: 'visible', justifyContent: 'flex-start',
          borderRadius: '8px', border: '1px solid #ccc', padding: '3px', background: 'rgba(255,255,255,.92)',
          ...(pos.bar ? placed(bar, pos.bar) : { top: '48px', bottom: 'auto', left: '220px' }) });
    const grip = bar.querySelector('.tool-grip');
    if (grip) grip.style.display = narrow ? 'none' : 'inline-flex';
    for (const c of bar.children) if (c.tagName === 'BUTTON') c.style.flexShrink = '0';
    const app = document.getElementById('app');
    const need = narrow && bar.style.display !== 'none' ? bar.offsetHeight : 0;
    if (app && need !== footer) {
        footer = need;
        Object.assign(app.style, need ? { top: '0', bottom: `${need}px`, height: 'auto' } : { top: '', bottom: '', height: '' });
        // the 3D view takes the new size
        setTimeout(() => window.dispatchEvent(new Event('resize')));
    }
    Object.assign(panel.style, { width: narrow ? 'min(300px, calc(100vw - 16px))' : '300px' });
    Object.assign(body.style, { maxHeight: narrow ? '55vh' : 'calc(100vh - 140px)' });
    Object.assign(panel.style, pos.panel ? placed(panel, pos.panel) : narrow ?
        { top: 'auto', bottom: `${footer + 8}px`, left: '8px' } :
        { top: '62px', bottom: 'auto', left: '264px' });
}

export function initToolbar() {
    bar = el('div', 'position:fixed;top:44px;left:222px;z-index:20;display:flex;flex-direction:row;gap:4px;' +
        'background:rgba(255,255,255,.92);border:1px solid #ccc;border-radius:8px;padding:3px');
    bar.id = 'tool-bar';
    panel = el('div', 'position:fixed;top:62px;left:264px;z-index:20;display:none;box-sizing:border-box;width:300px;' +
        'background:rgba(255,255,255,.97);border:1px solid #ccc;border-radius:8px;padding:10px 12px;font:12px sans-serif;color:#222;box-shadow:0 4px 14px rgba(0,0,0,.15)');
    panel.id = 'tool-panel';
    panel.onclick = ev => ev.stopPropagation();
    // the "ear" on top of the panel: grab it to put the panel somewhere else
    const ear = el('div', 'position:absolute;top:-15px;left:50%;transform:translateX(-50%);width:54px;height:15px;box-sizing:border-box;' +
        'background:rgba(255,255,255,.97);border:1px solid #ccc;border-bottom:0;border-radius:8px 8px 0 0;' +
        'display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;line-height:1;cursor:grab;user-select:none', '• • •');
    ear.id = 'tool-panel-ear';
    ear.title = 'drag to move this panel · double click: back to its place';
    draggable(ear, panel, 'panel');
    body = el('div', 'display:flex;flex-direction:column;gap:6px;overflow-y:auto');
    panel.append(ear, body);
    // inside #app (its own stacking context) so the top menu drops over them
    (document.getElementById('app') || document.body).append(bar, panel);
    layout();
    window.addEventListener('resize', layout);

    // painting can stop elsewhere (esc): fall back to the move tool
    colorPaint.onChange(state => {
        if (!state && tool === 'paint') { tool = 'move'; render(); }
    });
    onSlots(() => render());
    // rotation rings follow the selection
    for (const ev of [ 'widget.select', 'widget.deselect', 'selection.move', 'selection.rotate', 'selection.scale', 'widget.delete' ]) {
        api.event.on(ev, () => rotateGizmo.refresh());
    }
    // keep the move panel's selection and position current
    for (const ev of [ 'widget.select', 'widget.deselect', 'selection.move', 'widget.delete' ]) {
        api.event.on(ev, () => { if (tool === 'move' && movePanel) render(); });
    }
    // lay flat ends by itself after one click; scale panel may be closed from Kiri
    api.event.on('selection.rotate', () => { if (tool === 'flat') setTool('move'); });
    api.event.on('mode.set', mode => {
        bar.style.display = mode === 'FDM' ? 'flex' : 'none';
        if (mode !== 'FDM') { setTool('move'); panel.style.display = 'none'; }
        layout();
    });
    // only meaningful while arranging
    api.event.on('view.set', view => {
        const arrange = api.view.is_arrange();
        bar.style.opacity = arrange ? '1' : '.4';
        bar.style.pointerEvents = arrange ? 'auto' : 'none';
        if (!arrange && tool !== 'move') setTool('move');
    });
    if (api.mode.get() !== 'FDM') bar.style.display = 'none';
    render();
}

export const toolbar = { init: initToolbar, set: setTool };
