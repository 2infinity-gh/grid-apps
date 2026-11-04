/**
 * FDM settings panel laid out like Orca / Anycubic Slicer Next: separate
 * Printer, Filament and Process sections at the top, then the process
 * settings in tabs (Quality, Strength, Speed, Support, ...).
 * Kiri's own machine and profile selectors are moved in, so they keep working.
 */

import { api } from './api.js';
import { slotInfo } from './slots.js';
import { filaments } from './filaments.js';

const TABS = [
    { id: 'quality',  label: 'Quality',   groups: [ 'fdm-layers', 'fdm-walls' ] },
    { id: 'strength', label: 'Strength',  groups: [ 'fdm-solid', 'fdm-fill' ] },
    { id: 'speed',    label: 'Speed',     groups: [ 'fdm-output' ] },
    { id: 'support',  label: 'Support',   groups: [ 'fdm-support' ] },
    { id: 'base',     label: 'Adhesion',  groups: [ 'fdm-base' ] },
    { id: 'temp',     label: 'Temp & fan', groups: [ 'fdm-heat', 'fdm-cool' ] },
    { id: 'other',    label: 'Others',    groups: [ 'fdm-expert' ] },
    { id: 'all',      label: 'All' },
];
const TAB_KEY = 'kiri-side-tab';
// Kiri's collapse key of each group
const GROUP_KEY = {
    'fdm-layers': 'fdm-layers', 'fdm-walls': 'fdm-walls', 'fdm-solid': 'fdm-solid', 'fdm-fill': 'fdm-fill',
    'fdm-heat': 'fdm-heat', 'fdm-cool': 'fdm-cool', 'fdm-support': 'fdm-supp', 'fdm-base': 'fdm-base',
    'fdm-output': 'fdm-out', 'fdm-expert': 'fdm-xprt',
};

let root, slotList, tabBar, tab = 'quality';
try { tab = localStorage.getItem(TAB_KEY) || tab; } catch { }

function el(tag, css, text) {
    const e = document.createElement(tag);
    e.style.cssText = css || '';
    if (text !== undefined) e.textContent = text;
    return e;
}

function iconButton(icon, title, onclick) {
    const b = el('button', 'display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:22px;padding:0;' +
        'border:1px solid #c8c8c8;border-radius:4px;background:#f7f7f7;color:#444;cursor:pointer;text-transform:none');
    b.title = title;
    b.appendChild(el('i', 'font-size:11px')).className = `fas ${icon}`;
    b.onclick = ev => { ev.stopPropagation(); onclick(b); };
    return b;
}

function section(title, icon, ...buttons) {
    const s = el('div', 'display:flex;flex-direction:column;gap:4px;padding:6px 6px 8px;border-bottom:1px solid #d6dbe3');
    const head = el('div', 'display:flex;flex-direction:row;align-items:center;gap:4px');
    const name = el('span', 'flex:1;font-weight:bold;font-size:13px;color:#333;text-transform:none;white-space:nowrap');
    name.appendChild(el('i', 'margin-right:5px;color:#5a7fb8')).className = `fas ${icon}`;
    name.appendChild(document.createTextNode(title));
    head.appendChild(name);
    buttons.forEach(b => head.appendChild(b));
    s.appendChild(head);
    return s;
}

function hex(i) {
    const c = slotInfo(i)?.color;
    return isNaN(c) ? '#cccccc' : '#' + c.toString(16).padStart(6, '0');
}

function ink(h) {
    const n = parseInt(h.slice(1), 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#222' : '#fff';
}

// one row per slot: colour + number, profile choice, edit
function renderSlots() {
    if (!slotList) return;
    slotList.innerHTML = '';
    const count = api.conf.get().device.extruders?.length || 1;
    const library = filaments.library();
    for (let i = 0; i < count; i++) {
        const row = el('div', 'display:flex;flex-direction:row;align-items:center;gap:4px');
        const c = hex(i);
        const badge = el('span', `display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:4px;` +
            `border:1px solid #888;background:${c};color:${ink(c)};font:bold 11px sans-serif`, String(i + 1));
        const slot = slotInfo(i);
        badge.title = slot ? `slot ${i + 1}: ${slot.material} ${slot.name || ''}` : `slot ${i + 1}`;
        const select = el('select', 'flex:1;min-width:0;width:0;font:12px sans-serif;padding:1px 2px;text-transform:none');
        select.appendChild(new Option('— process settings —', ''));
        for (const p of library) select.appendChild(new Option(p.name, p.name));
        select.value = filaments.slotProfileName(i);
        select.title = select.value || 'no filament profile: the process settings apply';
        select.onchange = () => filaments.setSlot(i, select.value);
        const edit = iconButton('fa-pen', 'edit this filament profile', () => {
            if (select.value) filaments.edit(select.value, i);
            else api.show.alert('choose a filament profile first (or import one)', 3);
        });
        row.append(badge, select, edit);
        slotList.appendChild(row);
    }
}

function showTab(id) {
    tab = TABS.some(t => t.id === id) ? id : 'quality';
    try { localStorage.setItem(TAB_KEY, tab); } catch { }
    const show = TABS.find(t => t.id === tab).groups;
    for (const t of TABS) {
        for (const g of t.groups || []) document.getElementById(g)?.classList.toggle('side-tab-hidden', !!show && !show.includes(g));
    }
    // a tab shows its groups opened up
    if (show) {
        const hidden = api.conf.get().hidden || {};
        let changed = false;
        for (const g of show) {
            const key = GROUP_KEY[g];
            if (key && hidden[key]) { hidden[key] = false; changed = true; }
        }
        if (changed) { api.uc.setHidden(hidden); api.conf.save(); }
    }
    for (const b of tabBar.children) {
        const on = b.dataset.tab === tab;
        b.style.background = on ? '#3b82f6' : 'transparent';
        b.style.color = on ? '#fff' : '#445';
        b.style.borderColor = on ? '#3b82f6' : '#c8c8c8';
    }
}

// where Kiri put the selectors, to put them back outside FDM mode
const homes = new Map();
function moveTo(node, parent) {
    if (!node) return;
    if (!homes.has(node)) homes.set(node, { parent: node.parentNode, next: node.nextSibling });
    parent.appendChild(node);
}
function moveHome(node) {
    const home = homes.get(node);
    if (home && node.parentNode !== home.parent) home.parent.insertBefore(node, home.next);
}

function onMode(mode) {
    const fdm = mode === 'FDM';
    root.style.display = fdm ? 'flex' : 'none';
    document.getElementById('all-devpro')?.classList.toggle('side-tab-hidden', fdm);
    const nodes = [ api.ui.modeDevice, api.ui.modeProfile, document.getElementById('process-save') ];
    if (fdm) {
        moveTo(nodes[0], root.querySelector('.side-printer'));
        moveTo(nodes[1], root.querySelector('.side-process'));
        moveTo(nodes[2], root.querySelector('.side-process'));
    } else {
        nodes.forEach(moveHome);
    }
}

export function initSidePanel() {
    const slide = document.getElementById('panel-slide');
    if (!slide || !api.ui.modeDevice || !api.ui.modeProfile) return;
    const style = document.createElement('style');
    style.textContent = `.side-tab-hidden { display: none !important; }
        #side-panel select { text-transform: none; }
        #side-panel .side-printer > select, #side-panel .side-process > select { display:block; width:100%; box-sizing:border-box; font:12px sans-serif; padding:2px; }`;
    document.head.appendChild(style);

    // width 0 / min-width 100%: take the panel's width, never widen it
    root = el('div', 'display:flex;flex-direction:column;background:#fbfcfe;width:0;min-width:100%;box-sizing:border-box');
    root.id = 'side-panel';

    const printer = section('Printer', 'fa-print',
        iconButton('fa-pen', 'edit the printer (machine settings)', () => api.show.devices()));
    printer.classList.add('side-printer');

    const filament = section('Filament', 'fa-circle-dot',
        iconButton('fa-file-import', 'import Orca filament presets (.json / .zip)', () => {
            const input = el('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '.json,.zip';
            input.onchange = () => filaments.import([...input.files]);
            input.click();
        }),
        iconButton('fa-arrows-rotate', 'from printer: choose a profile per slot for the loaded filament (material, brand, colour)', () => filaments.fromPrinter()),
        iconButton('fa-list', 'all filament profiles', () => filaments.show()));
    slotList = el('div', 'display:flex;flex-direction:column;gap:3px');
    filament.appendChild(slotList);

    const process = section('Process', 'fa-layer-group');
    process.classList.add('side-process');

    tabBar = el('div', 'display:flex;flex-direction:row;flex-wrap:wrap;gap:3px;padding:6px 6px 4px;border-bottom:1px solid #d6dbe3');
    for (const t of TABS) {
        const b = el('button', 'padding:2px 7px;border:1px solid #c8c8c8;border-radius:10px;font:11px sans-serif;cursor:pointer;text-transform:none', t.label);
        b.dataset.tab = t.id;
        b.onclick = ev => { ev.stopPropagation(); showTab(t.id); };
        tabBar.appendChild(b);
    }

    root.append(printer, filament, process, tabBar);
    slide.insertBefore(root, slide.firstChild);

    filaments.onChange(renderSlots);
    api.event.on('device.select', () => setTimeout(renderSlots));
    api.event.on('mode.set', onMode);
    renderSlots();
    showTab(tab);
    onMode(api.mode.get());
}

export const sidePanel = { init: initSidePanel, refresh: renderSlots };
