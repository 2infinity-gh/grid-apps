/**
 * Filament profiles per slot.
 *
 * Profiles are imported from OrcaSlicer / Anycubic Slicer Next filament
 * presets (.json, or a .zip of them) and kept in settings.filaments:
 *   library: [ { name, type, color, temp, tempFirst, bed, bedFirst, flow,
 *                fanMax, fanOffLayers, mvs, retract, retractSpeed, pa } ]
 *   slots:   [ profile name per slot ]
 * The FDM export applies the slot's profile at each filament change.
 */

import { JSZip } from '../../ext/jszip-esm.js';
import { api } from './api.js';
import { slotInfo, slotLabel, onSlots } from './slots.js';

// fallbacks when a preset (or what it inherits) does not set a value
const TYPE_DEFAULTS = {
    PLA:  { temp: 210, tempFirst: 215, bed: 60,  fanMax: 100, fanOffLayers: 1, mvs: 15 },
    PETG: { temp: 240, tempFirst: 245, bed: 70,  fanMax: 50,  fanOffLayers: 3, mvs: 12 },
    ABS:  { temp: 250, tempFirst: 255, bed: 100, fanMax: 10,  fanOffLayers: 3, mvs: 15 },
    ASA:  { temp: 255, tempFirst: 260, bed: 100, fanMax: 20,  fanOffLayers: 3, mvs: 15 },
    TPU:  { temp: 225, tempFirst: 230, bed: 45,  fanMax: 100, fanOffLayers: 1, mvs: 3.6 },
    PVA:  { temp: 210, tempFirst: 215, bed: 55,  fanMax: 100, fanOffLayers: 1, mvs: 10 },
    PC:   { temp: 270, tempFirst: 270, bed: 110, fanMax: 20,  fanOffLayers: 3, mvs: 10 },
};

function typeDefaults(type = '') {
    const key = Object.keys(TYPE_DEFAULTS).find(k => type.toUpperCase().startsWith(k));
    return TYPE_DEFAULTS[key] ?? {};
}

// Orca stores most values as arrays of strings; "nil" means not set
function value(raw) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === null || v === 'nil' || v === '') return undefined;
    const n = parseFloat(v);
    return isNaN(n) ? v : n;
}

// the Orca keys we use, as profile fields
function fromOrca(json) {
    const pick = (...keys) => keys.map(k => value(json[k])).find(v => v !== undefined);
    const pa = value(json.enable_pressure_advance) === 1 || json.enable_pressure_advance?.[0] === 'true'
        ? pick('pressure_advance') : undefined;
    const fields = {
        type: pick('filament_type'),
        color: pick('filament_colour'),
        temp: pick('nozzle_temperature'),
        tempFirst: pick('nozzle_temperature_initial_layer'),
        bed: pick('textured_plate_temp', 'hot_plate_temp'),
        bedFirst: pick('textured_plate_temp_initial_layer', 'hot_plate_temp_initial_layer'),
        flow: pick('filament_flow_ratio'),
        fanMax: pick('fan_max_speed'),
        fanOffLayers: pick('close_fan_the_first_x_layers'),
        mvs: pick('filament_max_volumetric_speed'),
        retract: pick('filament_retraction_length'),
        retractSpeed: pick('filament_retraction_speed'),
        pa
    };
    for (const k in fields) if (fields[k] === undefined) delete fields[k];
    return fields;
}

// resolve "inherits" against the batch being imported and the library, then type defaults
function resolve(json, batch, library) {
    const own = fromOrca(json);
    let parent = {};
    const inherits = json.inherits && String(json.inherits);
    if (inherits) {
        const plain = inherits.replace(/\s*@.*$/, '');
        const hit = batch.find(j => j.name === inherits || j.name === plain)
            ?? library.find(p => p.name === inherits || p.name === plain);
        if (hit) parent = hit.raw ? resolve(hit.raw, batch.filter(j => j !== hit), library) : hit;
    }
    const merged = { ...parent, ...own };
    const name = String(json.name || json.filament_settings_id?.[0] || 'filament');
    return { ...typeDefaults(merged.type), ...merged, name, raw: undefined };
}

async function readPresets(files) {
    const out = [];
    for (const file of files) {
        if (file.name.toLowerCase().endsWith('.zip')) {
            const zip = await JSZip.loadAsync(file);
            for (const entry of Object.values(zip.files)) {
                if (!entry.dir && entry.name.toLowerCase().endsWith('.json')) {
                    out.push(await entry.async('string'));
                }
            }
        } else {
            out.push(await file.text());
        }
    }
    return out.map(text => { try { return JSON.parse(text) } catch { return null } })
        .filter(j => j && (j.type === 'filament' || j.filament_type || j.nozzle_temperature));
}

function store() {
    const set = api.conf.get();
    set.filaments = set.filaments || { library: [], slots: [] };
    set.filaments.library = set.filaments.library || [];
    set.filaments.slots = set.filaments.slots || [];
    return set.filaments;
}

export async function importFilaments(files) {
    const presets = await readPresets(files);
    const fil = store();
    const batch = presets.map(raw => ({ name: raw.name, raw }));
    let count = 0;
    for (const raw of presets) {
        const profile = resolve(raw, batch, fil.library);
        delete profile.raw;
        fil.library = fil.library.filter(p => p.name !== profile.name);
        fil.library.push(profile);
        count++;
    }
    fil.library.sort((a, b) => a.name.localeCompare(b.name));
    autoAssign();
    api.conf.save();
    api.show.alert(`imported ${count} filament profile${count === 1 ? '' : 's'}`, 3);
    return count;
}

// give unassigned slots the profile named like the filament the printer reports
export function autoAssign() {
    const fil = store();
    const count = api.conf.get().device.extruders?.length || 0;
    for (let i = 0; i < count; i++) {
        const slot = slotInfo(i);
        if (fil.slots[i] || !slot?.name) continue;
        if (fil.library.some(p => p.name === slot.name)) fil.slots[i] = slot.name;
    }
}

export function slotProfileName(i) {
    return store().slots[i] || '';
}

// a small dialog: import presets and choose a profile per slot
export function showFilaments() {
    const fil = store();
    const count = api.conf.get().device.extruders?.length || 1;
    const old = document.getElementById('filament-dialog');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'filament-dialog';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#222;border-radius:10px;padding:16px 18px;min-width:340px;max-width:92vw;max-height:85vh;overflow:auto;font:14px sans-serif';
    wrap.appendChild(box);
    const close = () => { wrap.remove(); api.conf.save(); };
    wrap.onclick = ev => { if (ev.target === wrap) close() };

    const render = () => {
        box.innerHTML = '';
        const h = (tag, text, css) => { const e = document.createElement(tag); if (text) e.textContent = text; if (css) e.style.cssText = css; return e; };
        box.appendChild(h('div', 'Filament profiles', 'font-weight:bold;font-size:16px;margin-bottom:10px'));
        for (let i = 0; i < count; i++) {
            const row = h('div', null, 'display:flex;gap:8px;align-items:center;margin:6px 0');
            const slot = slotInfo(i);
            const dot = h('span', null, `width:14px;height:14px;border-radius:50%;border:1px solid #888;background:#${(slot?.color ?? 0xcccccc).toString(16).padStart(6, '0')}`);
            row.appendChild(dot);
            row.appendChild(h('span', slotLabel(i), 'min-width:110px'));
            const sel = document.createElement('select');
            sel.style.cssText = 'flex:1;max-width:320px';
            sel.appendChild(new Option('— process settings —', ''));
            for (const p of fil.library) sel.appendChild(new Option(p.name, p.name));
            sel.value = fil.slots[i] || '';
            sel.onchange = () => { fil.slots[i] = sel.value; api.conf.save(); render(); };
            row.appendChild(sel);
            box.appendChild(row);
            const p = fil.library.find(p => p.name === fil.slots[i]);
            if (p) {
                box.appendChild(h('div', [
                    `${p.type || '?'}`, `${p.temp}°C`, `bed ${p.bed}°C`,
                    p.flow ? `flow ${p.flow}` : '', p.mvs ? `max ${p.mvs}mm³/s` : '', p.pa ? `PA ${p.pa}` : ''
                ].filter(v => v).join(' · '), 'margin:0 0 4px 22px;color:#666;font-size:12px'));
            }
        }
        const buttons = h('div', null, 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap');
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.json,.zip';
        input.style.display = 'none';
        input.onchange = async () => { await importFilaments([...input.files]); render(); };
        const imp = h('button', 'import Orca filament (.json / .zip)');
        imp.onclick = () => input.click();
        const done = h('button', 'done');
        done.onclick = close;
        buttons.append(imp, input, done);
        if (fil.library.length) {
            const clear = h('button', 'remove all profiles');
            clear.onclick = () => { if (confirm('remove all imported filament profiles?')) { fil.library = []; fil.slots = []; api.conf.save(); render(); } };
            buttons.appendChild(clear);
        }
        box.appendChild(buttons);
        box.appendChild(h('div', 'Profiles come from OrcaSlicer / Anycubic Slicer Next: user presets live in …/OrcaSlicer/user/<id>/filament/. A slot without a profile uses the process settings.', 'margin-top:10px;color:#777;font-size:12px;max-width:420px'));
    };
    render();
    document.body.appendChild(wrap);
}

onSlots(() => { autoAssign() });

export const filaments = { show: showFilaments, import: importFilaments, slotProfileName };
