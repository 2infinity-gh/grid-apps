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
    merged.type = merged.type || guessType(inherits, name);
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
    return out;
}

// Orca user presets often carry only their overrides plus "inherits" and no
// "type" (that lives in the system parent), so accept anything that is not
// explicitly a machine/process preset and looks like a filament preset
function isFilamentPreset(j) {
    if (!j || typeof j !== 'object' || !j.name) return false;
    if (j.type && j.type !== 'filament') return false;
    return !!(j.type || j.inherits || j.filament_settings_id || j.filament_type || j.nozzle_temperature);
}

// material from the preset's own names when no filament_type is set anywhere
function guessType(...names) {
    const text = names.filter(v => v).join(' ').toUpperCase();
    return [ 'PETG', 'PCTG', 'PLA', 'ABS', 'ASA', 'TPU', 'PVA', 'PC', 'PA', 'HIPS' ]
        .find(t => new RegExp(`(^|[^A-Z])${t}([^A-Z]|$)`).test(text));
}

function store() {
    const set = api.conf.get();
    set.filaments = set.filaments || { library: [], slots: [] };
    set.filaments.library = set.filaments.library || [];
    set.filaments.slots = set.filaments.slots || [];
    return set.filaments;
}

export async function importFilaments(files) {
    const texts = await readPresets(files);
    const skipped = [];
    const presets = [];
    texts.forEach((text, i) => {
        let json;
        try { json = JSON.parse(text) } catch { skipped.push('not JSON'); return; }
        if (isFilamentPreset(json)) presets.push(json);
        else skipped.push(json?.name ? `${json.name} (${json.type || 'not a filament'})` : 'not a filament preset');
    });
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
    api.show.alert(`imported ${count} filament profile${count === 1 ? '' : 's'}` +
        (skipped.length ? `, skipped ${skipped.length}: ${skipped.join(', ')}` : ''), 6);
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

// a dialog with one block per slot (stacked vertically): import presets and choose a profile
export function showFilaments() {
    const fil = store();
    const count = api.conf.get().device.extruders?.length || 1;
    const old = document.getElementById('filament-dialog');
    if (old) old.remove();
    // explicit layout on every element: Kiri's page styles must not reflow this dialog
    const el = (tag, css, text) => {
        const e = document.createElement(tag);
        e.style.cssText = css || '';
        if (text !== undefined) e.textContent = text;
        return e;
    };
    const wrap = el('div', 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center');
    wrap.id = 'filament-dialog';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:min(480px,94vw);max-height:88vh;overflow-y:auto;background:#fff;color:#222;border-radius:10px;padding:16px 18px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)');
    wrap.appendChild(box);
    const close = () => { wrap.remove(); api.conf.save(); };
    wrap.onclick = ev => { if (ev.target === wrap) close() };
    const button = (text, onclick, primary) => {
        const b = el('button', `display:inline-block;padding:6px 12px;border-radius:6px;border:1px solid ${primary ? '#3b82f6' : '#bbb'};background:${primary ? '#3b82f6' : '#f3f3f3'};color:${primary ? '#fff' : '#222'};cursor:pointer;font:13px sans-serif`, text);
        b.onclick = onclick;
        return b;
    };

    const render = () => {
        box.innerHTML = '';
        box.appendChild(el('div', 'display:block;font-weight:bold;font-size:16px', 'Filament profiles'));
        for (let i = 0; i < count; i++) {
            const slot = slotInfo(i);
            const card = el('div', 'display:flex;flex-direction:column;gap:6px;border:1px solid #e3e3e3;border-radius:8px;padding:10px 12px;background:#fafafa');
            const head = el('div', 'display:flex;flex-direction:row;align-items:center;gap:8px');
            head.appendChild(el('span', `display:inline-block;flex:none;width:16px;height:16px;border-radius:50%;border:1px solid #888;background:#${(slot?.color ?? 0xcccccc).toString(16).padStart(6, '0')}`));
            head.appendChild(el('span', 'display:inline-block;flex:none;font-weight:bold;white-space:nowrap', `Slot ${i + 1}`));
            head.appendChild(el('span', 'display:inline-block;flex:1;min-width:0;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                slot ? `${slot.material}${slot.name ? ' · ' + slot.name : ''}` : ''));
            card.appendChild(head);
            const sel = el('select', 'display:block;width:100%;box-sizing:border-box;padding:5px;font:13px sans-serif');
            sel.appendChild(new Option('— use the process settings —', ''));
            for (const p of fil.library) sel.appendChild(new Option(p.name, p.name));
            sel.value = fil.slots[i] || '';
            sel.onchange = () => { fil.slots[i] = sel.value; api.conf.save(); render(); };
            card.appendChild(sel);
            const p = fil.library.find(p => p.name === fil.slots[i]);
            if (p) {
                card.appendChild(el('div', 'display:block;color:#555;font-size:12px', [
                    p.type || '?', `${p.temp}°C`, `bed ${p.bed}°C`,
                    p.flow ? `flow ${p.flow}` : '', p.mvs ? `max ${p.mvs} mm³/s` : '', p.pa ? `PA ${p.pa}` : ''
                ].filter(v => v).join(' · ')));
            }
            box.appendChild(card);
        }
        const input = el('input', 'display:none');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.json,.zip';
        input.onchange = async () => { await importFilaments([...input.files]); render(); };
        const buttons = el('div', 'display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;justify-content:flex-end');
        if (fil.library.length) {
            buttons.appendChild(button('remove all', () => {
                if (confirm('remove all imported filament profiles?')) { fil.library = []; fil.slots = []; api.conf.save(); render(); }
            }));
        }
        buttons.appendChild(button('import Orca filament (.json / .zip)', () => input.click()));
        buttons.appendChild(button('done', close, true));
        box.appendChild(input);
        box.appendChild(buttons);
        box.appendChild(el('div', 'display:block;color:#777;font-size:12px',
            `${fil.library.length} profile${fil.library.length === 1 ? '' : 's'} imported. OrcaSlicer user presets live in …/OrcaSlicer/user/<id>/filament/. A slot without a profile uses the process settings.`));
    };
    render();
    document.body.appendChild(wrap);
}

onSlots(() => { autoAssign() });

export const filaments = { show: showFilaments, import: importFilaments, slotProfileName };
