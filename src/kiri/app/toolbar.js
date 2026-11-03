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

const DEG = Math.PI / 180;
let tool = 'move';
let paintSlot = 0;
let erase = false;
let movePanel = false;  // the move tool's nudge panel (tap the move tool again)
let step = 10;
let bar, panel;

const TOOLS = [
    { id: 'camera', icon: 'fa-video',                     title: 'camera: dragging always turns the view (tap still selects)' },
    { id: 'move',   icon: 'fa-arrows-up-down-left-right', title: 'move / select (esc) · tap again for position and nudge buttons' },
    { id: 'rotate', icon: 'fa-rotate',                    title: 'rotate' },
    { id: 'scale',  icon: 'fa-expand',                    title: 'scale / size' },
    { id: 'flat',   icon: 'fa-angles-down',               title: 'lay flat: click a face to put it on the bed' },
    { id: 'paint',  icon: 'fa-paintbrush',                title: 'colour paint' },
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
    }
    render();
}

function renderPanel() {
    panel.innerHTML = '';
    panel.style.display = (tool === 'paint' || tool === 'rotate' || (tool === 'move' && movePanel)) ? 'flex' : 'none';
    const title = text => panel.appendChild(el('div', 'display:block;font-weight:bold;margin-bottom:2px', text));
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
        panel.appendChild(swatches);

        title('Pen size');
        const size = row();
        const slider = el('input', 'display:block;flex:1;min-width:120px');
        slider.type = 'range';
        slider.min = 0.5; slider.max = 10; slider.step = 0.5;
        slider.value = colorPaint.getBrush();
        const value = el('span', 'display:inline-block;min-width:44px;text-align:right', `${colorPaint.getBrush()} mm`);
        slider.oninput = () => { colorPaint.setBrush(parseFloat(slider.value)); value.textContent = `${colorPaint.getBrush()} mm`; };
        size.append(slider, value);
        panel.appendChild(size);

        const actions = row();
        actions.appendChild(button('erase all painting', () => colorPaint.clear()));
        panel.appendChild(actions);
        panel.appendChild(el('div', 'display:block;color:#777;font-size:11px',
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
        panel.appendChild(steps);
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
        panel.appendChild(pad);
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
            panel.appendChild(fields);
        }
        panel.appendChild(el('div', 'display:block;color:#777;font-size:11px',
            'tip: on a touch screen, drag a selected object with one finger'));
    }

    if (tool === 'rotate') {
        title('Rotate selection');
        for (const [axis, label] of [ ['z', 'Z'], ['x', 'X'], ['y', 'Y'] ]) {
            const r = el('div', 'display:flex;flex-direction:row;gap:4px;align-items:center;flex-wrap:nowrap');
            r.appendChild(el('span', 'display:inline-block;width:18px;font-weight:bold', label));
            for (const deg of [ -90, -15, 15, 90 ]) {
                r.appendChild(button(`${deg > 0 ? '+' : ''}${deg}°`, () => {
                    if (!needSelection()) return;
                    api.selection.rotate(axis === 'x' ? deg * DEG : 0, axis === 'y' ? deg * DEG : 0, axis === 'z' ? deg * DEG : 0);
                }));
            }
            panel.appendChild(r);
        }
        const actions = row();
        actions.appendChild(button('lay flat…', () => setTool('flat')));
        actions.appendChild(button('reset rotation', () => { if (needSelection()) document.getElementById('unrotate')?.click(); }));
        actions.appendChild(button('exact angles…', () => { if (needSelection()) document.getElementById('context-rotate-panel')?.click(); }));
        panel.appendChild(actions);
    }
}

function render() {
    if (!bar) return;
    bar.innerHTML = '';
    for (const t of TOOLS) {
        const active = t.id === tool;
        const b = el('button', `display:inline-flex;align-items:center;justify-content:center;width:34px;height:30px;border-radius:6px;` +
            `border:1px solid ${active ? '#3b82f6' : '#ccc'};background:${active ? '#3b82f6' : '#f7f7f7'};color:${active ? '#fff' : '#333'};cursor:pointer`);
        b.title = t.title;
        b.appendChild(el('i', 'font-size:15px', '')).className = `fas ${t.icon}`;
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
    renderPanel();
}

// desktop: top left next to the settings panel; narrow screens: bottom left, panel above it
function layout() {
    const narrow = window.innerWidth < 760;
    Object.assign(bar.style, narrow ?
        { top: 'auto', bottom: '12px', left: '8px' } :
        { top: '44px', bottom: 'auto', left: '222px' });
    Object.assign(panel.style, narrow ?
        { top: 'auto', bottom: '58px', left: '8px', width: 'min(300px, calc(100vw - 16px))', maxHeight: '60vh', overflowY: 'auto' } :
        { top: '86px', bottom: 'auto', left: '222px', width: '300px', maxHeight: 'none' });
}

export function initToolbar() {
    bar = el('div', 'position:fixed;top:44px;left:222px;z-index:20;display:flex;flex-direction:row;gap:4px;' +
        'background:rgba(255,255,255,.92);border:1px solid #ccc;border-radius:8px;padding:3px');
    bar.id = 'tool-bar';
    panel = el('div', 'position:fixed;top:86px;left:222px;z-index:20;display:none;flex-direction:column;gap:6px;width:300px;' +
        'background:rgba(255,255,255,.97);border:1px solid #ccc;border-radius:8px;padding:10px 12px;font:12px sans-serif;color:#222;box-shadow:0 4px 14px rgba(0,0,0,.15)');
    panel.id = 'tool-panel';
    panel.onclick = ev => ev.stopPropagation();
    document.body.append(bar, panel);
    layout();
    window.addEventListener('resize', layout);

    // painting can stop elsewhere (esc): fall back to the move tool
    colorPaint.onChange(state => {
        if (!state && tool === 'paint') { tool = 'move'; render(); }
    });
    onSlots(() => render());
    // keep the move panel's selection and position current
    for (const ev of [ 'widget.select', 'widget.deselect', 'selection.move', 'widget.delete' ]) {
        api.event.on(ev, () => { if (tool === 'move' && movePanel) render(); });
    }
    // lay flat ends by itself after one click; scale panel may be closed from Kiri
    api.event.on('selection.rotate', () => { if (tool === 'flat') setTool('move'); });
    api.event.on('mode.set', mode => {
        bar.style.display = mode === 'FDM' ? 'flex' : 'none';
        if (mode !== 'FDM') { setTool('move'); panel.style.display = 'none'; }
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
