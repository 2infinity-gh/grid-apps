/**
 * Import OrcaSlicer / Anycubic Slicer Next process presets as Kiri FDM
 * process profiles. User presets usually hold only their overrides plus
 * "inherits", so each import starts from the current process and applies
 * what the preset (and presets it inherits from within the import) sets.
 */

import { api } from './api.js';
import { readPresets } from './filaments.js';

const pct = v => typeof v === 'string' && v.endsWith('%') ? parseFloat(v) / 100 : undefined;

function value(raw) {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === null || v === 'nil' || v === '') return undefined;
    if (typeof v !== 'string' || v.endsWith('%')) return v;
    const n = Number(v);
    return isNaN(n) ? v : n;
}

// Orca key -> (value, preset, nozzle) => { kiriField: value }
const MAP = {
    layer_height:                 v => ({ sliceHeight: v }),
    initial_layer_print_height:   v => ({ firstSliceHeight: v }),
    wall_loops:                   v => ({ sliceShells: v }),
    top_shell_layers:             v => ({ sliceTopLayers: v }),
    bottom_shell_layers:          v => ({ sliceBottomLayers: v }),
    sparse_infill_density:        v => ({ sliceFillSparse: pct(v) ?? v / 100 }),
    sparse_infill_pattern:        v => ({ sliceFillType: {
        grid: 'grid', rectilinear: 'linear', line: 'linear', alignedrectilinear: 'linear', zigzag: 'linear',
        gyroid: 'gyroid', honeycomb: 'hex', '3dhoneycomb': 'hex', triangles: 'triangle', cubic: 'grid',
        adaptivecubic: 'grid', supportcubic: 'grid', lightning: 'grid', concentric: 'linear'
    }[String(v).toLowerCase()] }),
    infill_direction:             v => ({ sliceFillAngle: v }),
    line_width:                   (v, p, n) => ({ sliceLineWidth: pct(v) ? Math.round(pct(v) * n * 1000) / 1000 : v }),
    infill_wall_overlap:          v => ({ sliceFillOverlap: pct(v) ?? v }),
    wall_sequence:                v => ({ sliceShellOrder: String(v).startsWith('outer') ? 'out-in' : 'in-out' }),
    outer_wall_speed:             v => ({ outputFinishrate: v }),
    inner_wall_speed:             v => ({ outputFeedrate: v }),
    travel_speed:                 v => ({ outputSeekrate: v }),
    initial_layer_speed:          v => ({ firstLayerRate: v }),
    initial_layer_infill_speed:   v => ({ firstLayerFillRate: v }),
    z_hop:                        v => ({ zHopDistance: v }),
    skirt_loops:                  v => ({ outputBrimCount: v }),
    skirt_distance:               v => ({ outputBrimOffset: v }),
    enable_support:               v => ({ sliceSupportType: v ? 'automatic' : 'disabled' }),
    support_top_z_distance:       v => ({ sliceSupportGapTop: v }),
    support_bottom_z_distance:    v => ({ sliceSupportGapBottom: v }),
    support_object_xy_distance:   v => ({ sliceSupportOffset: v }),
    // Orca: overhang slope from horizontal; Kiri: max overhang from vertical
    support_threshold_angle:      v => v > 0 ? ({ sliceSupportAngle: 90 - v }) : ({}),
    seam_position:                v => ({ sliceLayerStart: { nearest: 'last', aligned: 'aligned', back: 'back', random: 'random' }[v] ?? 'last' }),
    // accelerations (mm/s²); 0 = machine default
    default_acceleration:         v => ({ outputAccel: v }),
    outer_wall_acceleration:      v => ({ outputAccelOuter: v }),
    inner_wall_acceleration:      v => ({ outputAccelInner: v }),
    sparse_infill_acceleration:   (v, p) => ({ outputAccelFill: pct(v) ? pct(v) * (value(p.default_acceleration) || 0) : v }),
    top_surface_acceleration:     v => ({ outputAccelTop: v }),
    travel_acceleration:          v => ({ outputAccelTravel: v }),
    initial_layer_acceleration:   v => ({ outputAccelFirst: v }),
    // ironing
    ironing_type:                 v => ({ outputIronType: { top: 'top', topmost: 'topmost', solid: 'top' }[v] ?? 'none' }),
    ironing_flow:                 v => ({ outputIronFlow: pct(v) ?? v / 100 }),
    ironing_spacing:              v => ({ outputIronSpacing: v }),
    ironing_speed:                v => ({ outputIronSpeed: v }),
};

// Orca settings that matter for the result but have no Kiri counterpart
const KNOWN_UNMAPPED = [
    'bridge_speed', 'gap_infill_speed', 'support_speed', 'top_surface_speed', 'internal_solid_infill_speed',
    'sparse_infill_speed', 'top_surface_pattern', 'bottom_surface_pattern', 'brim_width', 'brim_type',
    'seam_gap', 'wipe_on_loops', 'only_one_wall_top', 'detect_overhang_wall', 'enable_arc_fitting',
    'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'top_surface_line_width',
    'support_interface_top_layers', 'tree_support_branch_angle', 'xy_hole_compensation', 'xy_contour_compensation',
    'elefant_foot_compensation', 'fuzzy_skin', 'slow_down_layers', 'precise_outer_wall', 'overhang_reverse',
    // Kiri's "adaptive" thin walls are the nearest thing but crash on some models, so not mapped
    'wall_generator'
];

function isProcessPreset(j) {
    if (!j || typeof j !== 'object' || !j.name) return false;
    if (j.type && j.type !== 'process') return false;
    return !!(j.type || j.layer_height || j.wall_loops || (j.inherits && /\d\.\d+mm/.test(String(j.inherits))));
}

// a preset's own values merged over what it inherits from within the import
function flatten(json, batch, depth = 0) {
    const plain = json.inherits && String(json.inherits).replace(/\s*@.*$/, '');
    const parent = depth < 8 && batch.find(j => j !== json && (j.name === json.inherits || j.name === plain));
    return { ...(parent ? flatten(parent, batch, depth + 1) : {}), ...json };
}

export async function importProcesses(files) {
    const texts = await readPresets(files);
    const presets = [];
    const skipped = [];
    for (const text of texts) {
        let json;
        try { json = JSON.parse(text) } catch { skipped.push('not JSON'); continue; }
        if (isProcessPreset(json)) presets.push(json);
        else skipped.push(json?.name ? `${json.name} (${json.type || '?'})` : 'not a process preset');
    }
    const set = api.conf.get();
    const mode = set.mode;
    const nozzle = set.device.extruders?.[0]?.extNozzle || 0.4;
    const unmapped = new Set();
    let last;
    for (const raw of presets) {
        const preset = flatten(raw, presets);
        const proc = structuredClone(set.process);
        for (const [key, rawValue] of Object.entries(preset)) {
            const v = value(rawValue);
            if (v === undefined) continue;
            if (MAP[key]) {
                for (const [k, nv] of Object.entries(MAP[key](v, preset, nozzle))) {
                    if (nv !== undefined && !(typeof nv === 'number' && isNaN(nv))) proc[k] = nv;
                }
            } else if (KNOWN_UNMAPPED.includes(key)) {
                unmapped.add(key);
            }
        }
        proc.processName = raw.name;
        set.sproc[mode][raw.name] = proc;
        last = raw.name;
    }
    if (last) {
        api.conf.load(null, last, true);
        api.conf.save();
        api.devices.refresh();
    }
    const msg = [ `imported ${presets.length} process profile${presets.length === 1 ? '' : 's'}` ];
    if (skipped.length) msg.push(`skipped: ${skipped.join(', ')}`);
    if (unmapped.size) msg.push(`not supported in Kiri: ${[...unmapped].join(', ')}`);
    api.show.alert(msg.join(' · '), 10);
    return { imported: presets.map(p => p.name), skipped, unmapped: [...unmapped] };
}

export function pickProcessFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.zip';
    input.style.display = 'none';
    input.id = 'process-import-input';
    input.onchange = () => { importProcesses([...input.files]); input.remove(); };
    document.body.appendChild(input);
    input.click();
}

export const processImport = { import: importProcesses, pick: pickProcessFiles };
