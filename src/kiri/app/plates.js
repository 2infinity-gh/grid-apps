/** Build plates from multi-plate OrcaSlicer / Bambu Studio projects */

import { api } from './api.js';
import { local as SDB } from '../../data/local.js';
import { Widget } from './widget.js';
import { platform } from './platform.js';
import { printerSent } from './printer-link.js';

// ask which plate of a project to load: resolves a plate id, 'all', or null (cancelled)
export function choosePlate(plates, file) {
    return new Promise(resolve => {
        const el = (tag, css, text) => {
            const e = document.createElement(tag);
            e.style.cssText = css || '';
            if (text !== undefined) e.textContent = text;
            return e;
        };
        const wrap = el('div', 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center');
        wrap.id = 'plate-dialog';
        const box = el('div', 'display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:min(380px,94vw);background:#fff;color:#222;border-radius:10px;padding:16px 18px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)');
        wrap.appendChild(box);
        box.appendChild(el('div', 'display:block;font-weight:bold;font-size:16px', 'Which plate?'));
        box.appendChild(el('div', 'display:block;color:#666;font-size:12px;margin-bottom:4px', `${file || 'This project'} has ${plates.length} plates.`));
        const done = value => { wrap.remove(); resolve(value); };
        const button = (text, value, primary) => {
            const b = el('button', `display:block;width:100%;text-align:left;padding:8px 12px;border-radius:6px;border:1px solid ${primary ? '#3b82f6' : '#ccc'};background:${primary ? '#eff6ff' : '#f7f7f7'};color:#222;cursor:pointer;font:14px sans-serif`, text);
            b.onclick = () => done(value);
            box.appendChild(b);
        };
        for (const p of plates) {
            button(`Plate ${p.id}${p.name ? ' · ' + p.name : ''} — ${p.count} object${p.count === 1 ? '' : 's'}`, p.id, true);
        }
        button('Each plate onto its own Kiri plate', 'split');
        button('All plates together on one', 'all');
        button('Cancel', null);
        wrap.onclick = ev => { if (ev.target === wrap) done(null) };
        document.body.appendChild(wrap);
    });
}

/**
 * Build plates inside Kiri. The active plate's objects live on the
 * platform as usual; the other plates keep their objects as saved widget
 * states (the same store Kiri uses for the workspace) and are swapped in
 * when you switch plates. State: { active, plates: [ { name, ids } ] }.
 */


const KEY = 'ws-plates';
const wait = ms => new Promise(r => setTimeout(r, ms));
let state = load();
let busy = false;

function load() {
    try {
        const s = JSON.parse(SDB.getItem(KEY) || 'null');
        if (s?.plates?.length) return s;
    } catch (e) { }
    return { active: 0, plates: [ { name: 'Plate 1', ids: [] } ] };
}

function persist() {
    SDB.setItem(KEY, JSON.stringify(state));
    renderBar();
}

// ids kept on inactive plates: the workspace save must not throw them away
export function inactivePlateIds() {
    return state.plates.filter((p, i) => i !== state.active).flatMap(p => p.ids);
}

function platformWidgets() {
    return api.widgets.all().filter(w => !w.synth);
}

async function stash() {
    const widgets = platformWidgets();
    await Promise.all(widgets.map(w => new Promise(r => w.saveState(r))));
    state.plates[state.active].ids = widgets.map(w => w.id);
    return widgets;
}

function restorePlate(ids) {
    return new Promise(resolve => {
        if (!ids.length) return resolve();
        let loaded = 0;
        for (const id of ids) {
            Widget.loadFromState(id, widget => {
                if (widget) {
                    platform.add(widget, 0, true, true);
                    const ann = api.widgets.annotate(id);
                    widget.meta.file = widget.meta.file || ann.file;
                }
                if (++loaded === ids.length) resolve();
            }, true);
        }
    });
}

export async function switchPlate(index) {
    if (busy) return api.show.alert('still saving the plates, one moment…', 2);
    if (index === state.active || !state.plates[index]) return;
    busy = true;
    try {
        api.function.clear?.();
        const widgets = await stash();
        state.active = index;
        persist();
        if (widgets.length) platform.delete(widgets);
        await restorePlate(state.plates[index].ids);
        await wait(250);
        platform.deselect();
        platform.update_bounds();
        api.space.update();
        api.space.save(true);
    } finally {
        busy = false;
        renderBar();
    }
}

export async function addPlate(name) {
    state.plates.push({ name: name || `Plate ${state.plates.length + 1}`, ids: [] });
    persist();
    await switchPlate(state.plates.length - 1);
}

export async function removePlate(index = state.active) {
    if (state.plates.length < 2) return;
    if (!confirm(`remove ${state.plates[index].name} and its objects?`)) return;
    if (index === state.active) {
        // empty the platform first, then forget the plate
        platform.delete(platformWidgets());
        state.plates[index].ids = [];
        const next = index === 0 ? 1 : index - 1;
        await switchPlate(next);
    }
    const ids = state.plates[index].ids;
    state.plates.splice(index, 1);
    if (state.active > index) state.active--;
    ids.forEach(id => Widget.deleteFromState(id));
    persist();
}

// load a multi-plate project: each project plate goes onto its own Kiri plate
export async function loadIntoPlates(groups, loadModels) {
    for (let i = 0; i < groups.length; i++) {
        const { plate, models } = groups[i];
        if (i > 0 || platformWidgets().length) {
            await addPlate(`Plate ${plate.id}${plate.name ? ' · ' + plate.name : ''}`);
        } else {
            state.plates[state.active].name = `Plate ${plate.id}${plate.name ? ' · ' + plate.name : ''}`;
        }
        loadModels(models);
        await wait(400);
        api.event.emit('cpaint.import');
        await wait(100);
        await stash();
        persist();
    }
}

// slice every plate and upload each G-code to the printer (kx-bridge), one file per plate
export async function sendAllPlates() {
    if (busy) return;
    if (!confirm(`slice all ${state.plates.length} plates and send each G-code to the printer?\n(nothing starts printing)`)) return;
    const back = state.active;
    const sent = [];
    const uploaded = [];
    for (let i = 0; i < state.plates.length; i++) {
        await switchPlate(i);
        if (!platformWidgets().length) continue;
        const alert = api.show.alert(`slicing ${state.plates[i].name}…`, 600);
        try {
            await new Promise(r => api.function.slice(r));
            await new Promise(r => api.function.prepare(r));
            const gcode = await new Promise(r => api.function.export(g => r(g)));
            const base = (platformWidgets()[0]?.meta.file || 'kiri').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
            const filename = `${base}-plate${i + 1}.gcode`;
            const form = new FormData();
            form.append('file', new Blob([ gcode ], { type: 'text/plain' }), filename);
            const res = await fetch('/printer-api/server/files/upload', { method: 'POST', body: form, credentials: 'same-origin' });
            sent.push(`${filename}: ${res.ok ? 'sent' : 'failed ' + res.status}`);
            if (res.ok) uploaded.push(filename);
        } catch (e) {
            sent.push(`${state.plates[i].name}: ${e.message || e}`);
        } finally {
            api.hide.alert(alert);
        }
    }
    await switchPlate(back);
    api.show.alert(sent.join(' · ') || 'no plates with objects', 10);
    if (uploaded.length) printerSent(uploaded, false);
}

export function plateState() {
    return state;
}

// a small bar above the platform: one button per plate, add, remove, send all
function renderBar() {
    let bar = document.getElementById('plate-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'plate-bar';
        bar.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:20;display:flex;flex-direction:row;gap:4px;align-items:center;background:rgba(255,255,255,.9);border:1px solid #ccc;border-radius:8px;padding:3px 6px;font:12px sans-serif';
        document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    const button = (text, title, onclick, active) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = `display:inline-block;padding:3px 8px;border-radius:5px;border:1px solid ${active ? '#3b82f6' : '#ccc'};background:${active ? '#3b82f6' : '#f7f7f7'};color:${active ? '#fff' : '#222'};cursor:pointer;font:12px sans-serif`;
        b.onclick = ev => { ev.stopPropagation(); onclick(); };
        bar.appendChild(b);
    };
    state.plates.forEach((p, i) => button(String(i + 1), p.name, () => switchPlate(i), i === state.active));
    button('+', 'add a plate', () => addPlate());
    if (state.plates.length > 1) {
        button('✕', `remove ${state.plates[state.active].name}`, () => removePlate());
        button('⇪ all', 'slice every plate and send each G-code to the printer', () => sendAllPlates());
    }
}

export function initPlates() {
    // for scripting and headless tests
    self.kiri_plates = { state: () => state, switch: switchPlate, add: addPlate, remove: removePlate, sendAll: sendAllPlates };
    if (api.mode.get() === 'FDM') renderBar();
    api.event.on('mode.set', mode => {
        const bar = document.getElementById('plate-bar');
        if (bar) bar.style.display = mode === 'FDM' ? 'flex' : 'none';
        else if (mode === 'FDM') renderBar();
    });
}

export const plates = { init: initPlates, switch: switchPlate, add: addPlate, remove: removePlate, sendAll: sendAllPlates, state: plateState };
