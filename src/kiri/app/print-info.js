/**
 * Print time and filament after a preview, in the side panel: total time
 * (Klipper-style estimate from the G-code, see estimate.js) and per slot the
 * filament in metres and grams (and price when the filament profile has one).
 * The G-code is generated in the background right after the preview.
 */

import { api } from './api.js';
import { client } from './workers.js';
import { filaments } from './filaments.js';
import { slotInfo } from './slots.js';

let box, run = 0;

export function formatTime(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

// per tool: { tool, mm, g, cost } for the tools that print anything
export function filamentUse(estimate, settings = api.conf.get()) {
    const dia = settings.device.extruders?.[0]?.extFilament || 1.75;
    const area = Math.PI * (dia / 2) ** 2;
    return (estimate?.filament || []).map((mm, tool) => {
        const { density, cost, type } = filaments.slotMaterial(tool);
        const g = mm * area / 1000 * density;
        return { tool, mm, g, type, cost: cost ? g / 1000 * cost : undefined };
    }).filter(u => u.mm > 0.5);
}

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

function show(estimate) {
    if (!box) return;
    box.innerHTML = '';
    if (!estimate) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    const use = filamentUse(estimate);
    const head = el('div', 'display:flex;flex-direction:row;align-items:center;gap:6px');
    const title = el('span', 'flex:1;font-weight:bold;font-size:13px;color:#333;text-transform:none;white-space:nowrap');
    title.appendChild(el('i', 'margin-right:5px;color:#5a7fb8')).className = 'fas fa-clock';
    title.appendChild(document.createTextNode('Estimate'));
    head.append(title, el('span', 'font:bold 14px sans-serif;color:#1d4ed8', formatTime(estimate.time)));
    box.appendChild(head);
    const total = use.reduce((a, u) => a + u.g, 0);
    const cost = use.every(u => u.cost !== undefined) && use.length ? use.reduce((a, u) => a + u.cost, 0) : undefined;
    for (const u of use) {
        const row = el('div', 'display:flex;flex-direction:row;align-items:center;gap:6px;font:12px sans-serif;color:#333');
        const c = hex(u.tool);
        row.appendChild(el('span', `display:inline-block;flex:none;width:12px;height:12px;border-radius:3px;border:1px solid #888;background:${c}`));
        row.appendChild(el('span', 'flex:1;text-transform:none', `slot ${u.tool + 1} · ${u.type}`));
        row.appendChild(el('span', 'text-transform:none', `${(u.mm / 1000).toFixed(2)} m · ${u.g.toFixed(1)} g`));
        box.appendChild(row);
    }
    const notes = [];
    if (use.length > 1) notes.push(`total ${total.toFixed(1)} g`);
    if (cost !== undefined) notes.push(`€ ${cost.toFixed(2)}`);
    if (estimate.swaps) notes.push(`${estimate.swaps} filament swaps (${formatTime(estimate.swapTime)})`);
    if (estimate.start) notes.push(`incl. ${formatTime(estimate.start)} heat up and levelling`);
    if (notes.length) box.appendChild(el('div', 'font:11px sans-serif;color:#667;text-transform:none', notes.join(' · ')));
}

function calculate() {
    if (api.mode.get() !== 'FDM') return;
    const mine = ++run;
    box.style.display = 'flex';
    box.innerHTML = '';
    box.appendChild(el('div', 'font:12px sans-serif;color:#667;text-transform:none', 'calculating print time…'));
    client.export(api.conf.get(), () => {}, (output, error) => {
        if (mine !== run) return;
        show(error ? undefined : output?.estimate);
    });
}

function clear() {
    run++;
    show();
}

export function initPrintInfo() {
    const panel = document.getElementById('side-panel');
    if (!panel || box) return;
    box = el('div', 'display:none;flex-direction:column;gap:4px;padding:6px 6px 8px;border-bottom:1px solid #d6dbe3;background:#f3f7ff');
    box.id = 'print-info';
    // under the Process section, above the tabs
    const process = panel.querySelector('.side-process');
    process ? process.after(box) : panel.appendChild(box);
    api.event.on('preview.end', calculate);
    for (const ev of [ 'slice.begin', 'preview.begin', 'widget.add', 'widget.delete', 'mode.set' ]) api.event.on(ev, clear);
}

export const printInfo = { init: initPrintInfo, formatTime, filamentUse };
