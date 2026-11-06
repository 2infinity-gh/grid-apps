/**
 * Import OrcaSlicer / Anycubic Slicer Next process presets as Kiri FDM
 * process profiles. User presets hold only their differences from a parent
 * ("inherits"): the parent comes from the same import, or for the Kobra X
 * system presets from the built-in base (orca-base.js). Orca G-code and 3MF
 * projects carry the complete, resolved settings and import as they are.
 */

import { api } from './api.js';
import { readPresets, addFilamentPresets } from './filaments.js';
import { KOBRA_X_BASE } from './orca-base.js';
import { conf } from './conf/defaults.js';
import { JSZip } from '../../ext/jszip-esm.js';

const pct = v => typeof v === 'string' && v.endsWith('%') ? parseFloat(v) / 100 : undefined;

// Orca's auto brim decides per object (mostly none): Kiri only takes an explicit brim
function hasBrim(p) {
    const type = String(value(p.brim_type) ?? 'auto_brim');
    return type !== 'no_brim' && type !== 'auto_brim' && (value(p.brim_width) || 0) > 0;
}

function value(raw) {
    let v = Array.isArray(raw) ? raw[0] : raw;
    // G-code config blocks list per filament values: "215,205", "PLA;PETG"
    if (typeof v === 'string' && !v.includes('\n') && /[,;]/.test(v) && !/^".*"$/.test(v)) v = v.split(/[,;]/)[0].trim();
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
    // Kiri has one first-layer outline setting: loops at an offset from the
    // part; offset 0 makes it a brim. An Orca brim wins over its skirt.
    skirt_loops:                  (v, p) => hasBrim(p) ? {} : { outputBrimCount: v },
    skirt_distance:               (v, p) => hasBrim(p) ? {} : { outputBrimOffset: v },
    brim_width:                   (v, p) => hasBrim(p) ? {
        outputBrimCount: Math.max(1, Math.round(v / (value(p.initial_layer_line_width) || value(p.line_width) || 0.42))),
        outputBrimOffset: value(p.brim_object_gap) || 0
    } : {},
    enable_support:               (v, p) => {
        const type = String(value(p.support_type) ?? '');
        const organic = String(value(p.support_style) ?? '') === 'tree_organic';
        return { sliceSupportType: !v ? 'disabled' : type.startsWith('tree') ? (organic ? 'organic' : 'tree') : type.includes('manual') ? 'manual' : 'automatic' };
    },
    tree_support_branch_angle:    v => ({ sliceSupportTreeAngle: v }),
    tree_support_tip_diameter:    v => ({ sliceSupportTreeTip: v }),
    tree_support_branch_diameter: v => ({ sliceSupportTreeBranch: v }),
    tree_support_branch_diameter_angle: v => ({ sliceSupportTreeGrow: v }),
    tree_support_branch_distance: v => ({ sliceSupportTreeSpacing: v }),
    // Orca sizes an automatic brim itself; Kiri then keeps its 3 mm
    tree_support_brim_width:      (v, p) => String(value(p.tree_support_auto_brim)) === '0' || p.tree_support_auto_brim?.[0] === 'false' ? { sliceSupportBrim: v } : {},
    support_top_z_distance:       v => ({ sliceSupportGapTop: v }),
    // 0 = the object's own filament, n = filament n (Kiri's support tool works the same way)
    support_filament:             v => ({ sliceSupportNozzle: v }),
    support_interface_top_layers: v => ({ sliceSupportInterface: v }),
    // Orca gives the gap between interface lines; Kiri a density (0.42 mm lines)
    support_interface_spacing:    v => ({ sliceSupportInterfaceDensity: Math.min(1, 0.42 / (0.42 + v)) }),
    support_bottom_z_distance:    v => ({ sliceSupportGapBottom: v }),
    support_object_xy_distance:   v => ({ sliceSupportOffset: v }),
    // Orca: overhang slope from horizontal; Kiri: max overhang from vertical
    support_on_build_plate_only:  v => ({ sliceSupportPlateOnly: v === true || String(v) === '1' || String(v) === 'true' }),
    support_threshold_angle:      v => v > 0 ? ({ sliceSupportAngle: 90 - v }) : ({}),
    seam_position:                v => ({ sliceLayerStart: { nearest: 'last', aligned: 'aligned', back: 'back', random: 'random' }[v] ?? 'last' }),
    // accelerations (mm/s²); 0 = machine default
    default_acceleration:         v => ({ outputAccel: v }),
    outer_wall_acceleration:      v => ({ outputAccelOuter: v }),
    inner_wall_acceleration:      v => ({ outputAccelInner: v }),
    sparse_infill_acceleration:   (v, p) => ({ outputAccelFill: pct(v) ? pct(v) * (value(p.default_acceleration) || 0) : v }),
    top_surface_acceleration:     v => ({ outputAccelTop: v }),
    internal_solid_infill_acceleration: (v, p) => ({ outputAccelSolid: pct(v) ? pct(v) * (value(p.default_acceleration) || 0) : v }),
    travel_acceleration:          v => ({ outputAccelTravel: v }),
    initial_layer_acceleration:   v => ({ outputAccelFirst: v }),
    // ironing
    ironing_type:                 v => ({ outputIronType: { top: 'top', topmost: 'topmost', solid: 'top' }[v] ?? 'none' }),
    ironing_flow:                 v => ({ outputIronFlow: pct(v) ?? v / 100 }),
    ironing_spacing:              v => ({ outputIronSpacing: v }),
    ironing_speed:                v => ({ outputIronSpeed: v }),
    // retraction, wipe, cooling and temperatures (filament profiles override
    // these per slot; the process keeps them for slots without a profile)
    // Orca has no pause after the un-retract
    retraction_length:            v => ({ outputRetractDist: v, outputRetractDwell: 0 }),
    retraction_speed:             v => ({ outputRetractSpeed: v }),
    retract_when_changing_layer:  v => ({ outputLayerRetract: v === 1 || v === 'true' || v === '1' }),
    wipe_distance:                (v, p) => ({ outputRetractWipe: [1, '1', 'true'].includes(value(p.wipe)) ? v : 0 }),
    slow_down_layer_time:         v => ({ outputMinLayerTime: v }),
    slow_down_min_speed:          v => ({ outputMinSpeed: v }),
    dont_slow_down_outer_wall:    v => ({ outputKeepOuterSpeed: v === 1 || v === 'true' || v === '1' }),
    fan_max_speed:                v => ({ outputFanSpeed: Math.round(v * 2.55) }),
    close_fan_the_first_x_layers: v => ({ outputFanLayer: v }),
    nozzle_temperature:           v => ({ outputTemp: v }),
    nozzle_temperature_initial_layer: v => ({ firstLayerNozzleTemp: v }),
    textured_plate_temp:          v => ({ outputBedTemp: v }),
    textured_plate_temp_initial_layer: v => ({ firstLayerBedTemp: v }),
    filament_max_volumetric_speed: v => ({ outputMaxFlowrate: v }),
    // flow: Orca's overall ratio times its per feature ratios (the filament's
    // own flow ratio is applied per slot on top, as in Orca)
    print_flow_ratio:             (v, p) => {
        const f = k => (value(p[k]) ?? 1) * v;
        return { outputShellMult: f('outer_wall_flow_ratio'), outputFillMult: f('internal_solid_infill_flow_ratio'), outputSparseMult: f('sparse_infill_flow_ratio') };
    },
    // speeds per feature (percentages are of the outer / inner wall speed)
    top_surface_speed:            v => ({ outputSpeedTop: v }),
    internal_solid_infill_speed:  (v, p) => ({ outputSpeedSolid: pct(v) ? pct(v) * (value(p.inner_wall_speed) || 0) : v }),
    sparse_infill_speed:          (v, p) => ({ outputSpeedSparse: pct(v) ? pct(v) * (value(p.inner_wall_speed) || 0) : v }),
    bridge_speed:                 v => ({ outputSpeedBridge: v }),
    gap_infill_speed:             v => ({ outputSpeedGap: v }),
    // the classic wall generator always fills the gaps between walls
    filter_out_gap_fill:          v => ({ sliceGapFill: true, sliceGapFillMin: v }),
    minimum_sparse_infill_area:   v => ({ sliceSparseMinArea: v }),
    support_speed:                v => ({ outputSpeedSupport: v }),
    // Orca's threshold 0 (its default) switches the small perimeter speed off
    small_perimeter_speed:        (v, p) => !(value(p.small_perimeter_threshold) > 0) ? { outputSpeedSmall: 0 } :
        ({ outputSpeedSmall: pct(v) ? Math.round(pct(v) * (value(p.outer_wall_speed) || 0)) : v }),
    small_perimeter_threshold:    v => v > 0 ? { outputSmallRadius: v } : { outputSpeedSmall: 0 },
    elefant_foot_compensation:    v => ({ firstLayerElephant: v }),
    top_shell_thickness:          v => ({ sliceTopThickness: v }),
    bottom_shell_thickness:       v => ({ sliceBottomThickness: v }),
    fan_min_speed:                v => ({ outputFanMin: v }),
    fan_cooling_layer_time:       v => ({ outputFanLayerTime: v }),
    enable_arc_fitting:           v => ({ fdmArcEnabled: [1, '1', 'true'].includes(v) }),
    // line widths per feature (percentages of the nozzle)
    outer_wall_line_width:        (v, p, n) => ({ sliceLineWidthOuter: pct(v) ? pct(v) * n : v }),
    inner_wall_line_width:        (v, p, n) => ({ sliceLineWidthInner: pct(v) ? pct(v) * n : v }),
    internal_solid_infill_line_width: (v, p, n) => ({ sliceLineWidthSolid: pct(v) ? pct(v) * n : v }),
    sparse_infill_line_width:     (v, p, n) => ({ sliceLineWidthSparse: pct(v) ? pct(v) * n : v }),
    initial_layer_line_width:     (v, p, n) => ({ sliceLineWidthFirst: pct(v) ? pct(v) * n : v }),
    // bridges and overhangs
    bridge_flow:                  v => ({ outputBridgeFlow: v }),
    enable_overhang_speed:        (v, p) => {
        const on = [1, '1', 'true'].includes(v);
        const sp = k => on ? value(p[k]) || 0 : 0;
        return { outputSpeedOver1: sp('overhang_1_4_speed'), outputSpeedOver2: sp('overhang_2_4_speed'),
            outputSpeedOver3: sp('overhang_3_4_speed'), outputSpeedOver4: sp('overhang_4_4_speed') };
    },
    enable_overhang_bridge_fan:   (v, p) => ({ outputOverhangFan: [1, '1', 'true'].includes(v) ? value(p.overhang_fan_speed) ?? 100 : -1 }),
    overhang_fan_threshold:       v => ({ outputOverhangFanThreshold: pct(v) ?? v }),
    // top surfaces and shells
    ensure_vertical_shell_thickness: v => ({ sliceVerticalShells: ![0, '0', 'false', 'none', 'ensure_none'].includes(v) }),
    only_one_wall_top:            v => ({ sliceOneWallTop: [1, '1', 'true'].includes(v) }),
    top_surface_pattern:          v => ({ outputMonotonic: String(v).startsWith('monotonic') }),
    // fuzzy skin
    fuzzy_skin:                   (v, p) => ({ outputFuzzyThickness: v && v !== 'none' ? value(p.fuzzy_skin_thickness) ?? 0.3 : 0,
        outputFuzzyAll: v === 'all' || v === 'allwalls' }),
    fuzzy_skin_point_distance:    v => ({ outputFuzzyDistance: v }),
    fuzzy_skin_first_layer:       v => ({ outputFuzzyFirst: [1, '1', 'true'].includes(v) }),
    // shapes and extras
    spiral_mode:                  v => [1, '1', 'true'].includes(v) ? { sliceFillType: 'vase' } : {},
    draft_shield:                 v => ({ outputDraftShield: v === 'enabled' || v === 'limited' }),
    raft_layers:                  v => ({ outputRaft: v > 0 }),
    raft_contact_distance:        v => ({ outputRaftSpacing: v }),
    // Orca: gap between support lines; Kiri: density
    support_base_pattern_spacing: (v, p, n) => ({ sliceSupportDensity: Math.min(1, n / (n + v)) }),
    // scarf seam: Orca's scarf length
    seam_slope_type:              (v, p) => ({ outputScarfLength: v && v !== 'none' ? value(p.seam_slope_min_length) || 10 : 0 }),
    // Orca offsets each side (+ grows the part / the hole); Kiri gives the
    // change in size, and its outer value shrinks
    xy_contour_compensation:      v => ({ sliceCompOuter: -2 * v }),
    xy_hole_compensation:         v => ({ sliceCompInner: 2 * v }),
};

// Orca settings that matter for the result but have no Kiri counterpart
const KNOWN_UNMAPPED = [
    'bottom_surface_pattern', 'brim_width', 'brim_type', 'seam_gap', 'wipe_on_loops', 'detect_overhang_wall',
    'top_surface_line_width', 'slow_down_layers', 'precise_outer_wall', 'overhang_reverse',
    // Orca's default Arachne: Kiri's adaptive walls are the nearest, but far too
    // slow on detailed models in the browser, so imports keep the normal walls
    'wall_generator',
];

function isProcessPreset(j) {
    if (!j || typeof j !== 'object' || !j.name) return false;
    if (j.type && j.type !== 'process') return false;
    return !!(j.type || j.layer_height || j.wall_loops || (j.inherits && /\d\.\d+mm/.test(String(j.inherits))));
}

// a preset's own values merged over what it inherits from within the import
function flatten(json, batch, depth = 0) {
    if (json.complete) return json;
    const plain = json.inherits && String(json.inherits).replace(/\s*@.*$/, '');
    const parent = depth < 8 && batch.find(j => j !== json && (j.name === json.inherits || j.name === plain));
    if (parent) return { ...flatten(parent, batch, depth + 1), ...json };
    // a system parent that is not in the import
    const base = /kobra\s*x/i.test(String(json.inherits || json.name || '')) ? KOBRA_X_BASE : {};
    return { ...base, ...json };
}

// the resolved settings in an Orca G-code's config block (or a project's
// Metadata/project_settings.config), as a complete preset
function fromConfig(cfg, fallback) {
    const name = String(value(cfg.print_settings_id) || fallback).replace(/\(.*\.3mf\)$/, '').trim();
    return { ...cfg, name, complete: true };
}

function gcodeConfig(text) {
    const start = text.indexOf('; CONFIG_BLOCK_START');
    if (start < 0) return null;
    const cfg = {};
    for (const line of text.substring(start).split('\n')) {
        const m = line.match(/^; (\w+) = (.*)$/);
        if (m) cfg[m[1]] = m[2].trim();
        if (line.startsWith('; CONFIG_BLOCK_END')) break;
    }
    return cfg;
}

// the filament presets inside a resolved config (per filament lists), as
// Orca-like presets for the filament library
function configFilaments(cfg) {
    // quoted values (names, the adaptive PA model) may hold commas themselves
    const quoted = v => v.trim().startsWith('"') ? [ ...v.matchAll(/"((?:[^"\\]|\\.)*)"/g) ].map(m => m[1]) : null;
    const list = v => Array.isArray(v) ? v : typeof v === 'string'
        ? quoted(v) ?? (v.split(/;/).length > 1 ? v.split(';') : v.split(',')) : [ v ];
    const names = list(cfg.filament_settings_id || []).map(n => String(n).replace(/^"|"$/g, '').trim()).filter(n => n);
    return names.map((name, i) => {
        const json = { name, type: 'filament' };
        for (const [key, raw] of Object.entries(cfg)) {
            if (key === 'filament_settings_id') continue;
            const vals = list(raw);
            if (vals.length === names.length) json[key] = [ String(vals[i]).trim() ];
        }
        return json;
    });
}

async function readProcessFiles(files) {
    const presets = [], texts = [], skipped = [], filaments = [];
    for (const file of files) {
        const lower = file.name.toLowerCase();
        const base = file.name.replace(/\.[^.]+$/, '');
        if (lower.endsWith('.gcode')) {
            const cfg = gcodeConfig(await file.text());
            cfg ? presets.push(fromConfig(cfg, base)) : skipped.push(`${file.name} (no Orca settings)`);
            if (cfg) filaments.push(...configFilaments(cfg));
        } else if (lower.endsWith('.3mf')) {
            const zip = await JSZip.loadAsync(file);
            const entry = zip.file('Metadata/project_settings.config');
            let cfg;
            try { cfg = entry && JSON.parse(await entry.async('string')); } catch { }
            cfg ? presets.push(fromConfig(cfg, base)) : skipped.push(`${file.name} (no Orca project settings)`);
            if (cfg) filaments.push(...configFilaments(cfg));
        } else {
            texts.push(...await readPresets([ file ]));
        }
    }
    return { presets, texts, skipped, filaments };
}

export async function importProcesses(files) {
    const { presets, texts, skipped, filaments: fils } = await readProcessFiles(files);
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
        // Kiri's own defaults for what Orca has no setting for, never the
        // values of whatever profile happens to be active
        const proc = structuredClone(conf.defaults[mode.toLowerCase()]?.p || set.process);
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
    // the filaments the G-code / project was sliced with go to the library too
    const filCount = fils.length ? addFilamentPresets(fils) : 0;
    const msg = [ `imported ${presets.length} process profile${presets.length === 1 ? '' : 's'}` ];
    if (filCount) msg.push(`${filCount} filament profile${filCount === 1 ? '' : 's'}`);
    if (skipped.length) msg.push(`skipped: ${skipped.join(', ')}`);
    if (unmapped.size) msg.push(`not supported in Kiri: ${[...unmapped].join(', ')}`);
    api.show.alert(msg.join(' · '), 10);
    return { imported: presets.map(p => p.name), skipped, unmapped: [...unmapped] };
}

export function pickProcessFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.zip,.3mf,.gcode';
    input.style.display = 'none';
    input.id = 'process-import-input';
    input.onchange = () => { importProcesses([...input.files]); input.remove(); };
    document.body.appendChild(input);
    input.click();
}

export const processImport = { import: importProcesses, pick: pickProcessFiles };
