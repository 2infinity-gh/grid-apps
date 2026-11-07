/**
 * Calibration prints, made like any other print: each test is a generated
 * model plus a process profile derived from the active one, with per layer
 * overrides (ranges). Slice and export as usual (start G-code, filament slot
 * and temperatures all apply).
 *
 *  - max flow:    a single wall cylinder (vase) whose wall speed rises so the
 *                 flow climbs from start to end mm³/s; no flow caps, no min
 *                 layer time. Read the height where the wall starts to fail.
 *  - PA tower:    a hollow square at the profile's own outer wall speed and
 *                 acceleration; PA rises every mm. Read the sharpest corners.
 *  - temperature: blocks of a few °C each, hottest at the bottom, with a
 *                 narrow neck between blocks to count them by.
 */

import { THREE } from '../../ext/three.js';
import { api } from './api.js';

// bead cross section (Orca): rectangle with rounded sides
const beadArea = (w, h) => w > h ? (w - h) * h + Math.PI * h * h / 4 : Math.PI * w * w / 4 * (h / w);

// layer tops: first layer, then layer height (as the slicer stacks them)
function layerTops(first, h, height) {
    const z = [ first ];
    while (z[z.length - 1] + h <= height + 1e-6) z.push(+(z[z.length - 1] + h).toFixed(4));
    return z;
}

function addModel(geo, name) {
    geo = geo.toNonIndexed();
    api.platform.load_verts(undefined, Array.from(geo.attributes.position.array), name);
    geo.dispose();
}

function merge(geos) {
    const pos = [];
    for (const g of geos) {
        const ng = g.toNonIndexed();
        pos.push(...ng.attributes.position.array);
        ng.dispose();
        g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return out;
}

// a box standing on z = z0 (THREE centres it)
function box(x, y, z, z0) {
    return new THREE.BoxGeometry(x, y, z).translate(0, 0, z0 + z / 2);
}

// save as a new process profile, derived from the active one, and select it
// the profile in use before the calibration print, to go back to once the
// calibration object is removed (also after a reload)
const PREV_KEY = 'korca-calib-prev';
let watching = false, building = 0;
function watchDelete() {
    if (watching) return;
    watching = true;
    api.event.on('widget.delete', () => setTimeout(endCalibration));
}

// bed empty while a calibration profile is active: back to the old profile,
// and drop the calibration one (its ranges would carry over to the next model)
function endCalibration() {
    // (making a new calibration print clears the bed first)
    if (api.widgets.all().length || Date.now() - building < 3000) return;
    const set = api.conf.get(), mode = set.mode;
    const name = set.process?.processName || '';
    if (!name.startsWith('calibration ')) return;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(PREV_KEY)); } catch (e) {}
    const procs = set.sproc[mode];
    let prev = saved?.name;
    // an unsaved working copy (e.g. "default"): bring it back as it was
    // ("default" follows the working copy on every save, so it holds the
    // calibration settings by now)
    if (prev && (!procs[prev] || prev === 'default') && saved.proc) procs[prev] = saved.proc;
    if (!prev || !procs[prev] || prev.startsWith('calibration ')) {
        prev = Object.keys(procs).find(n => n !== name && !n.startsWith('calibration '));
    }
    if (!prev) {
        // nothing to go back to: at least drop the per-layer overrides
        set.process.ranges = [];
        api.event.emit('range.updates', set.process.ranges);
        return;
    }
    delete procs[name];
    api.conf.load(null, prev, true);
    api.conf.save();
    api.devices.refresh?.();
    try { localStorage.removeItem(PREV_KEY); } catch (e) {}
}

function useProfile(name, change) {
    const set = api.conf.get();
    const mode = set.mode;
    const cur = set.process?.processName;
    if (cur && !cur.startsWith('calibration ')) {
        try { localStorage.setItem(PREV_KEY, JSON.stringify({ name: cur, proc: set.process })); } catch (e) {}
    }
    watchDelete();
    const proc = structuredClone(set.process);
    change(proc);
    proc.processName = name;
    set.sproc[mode][name] = proc;
    api.conf.load(null, name, true);
    api.conf.save();
    api.devices.refresh?.();
}

function startFresh() {
    building = Date.now();
    if (api.widgets.all().length && !confirm('remove the objects on the bed for the calibration print?')) return false;
    api.platform.clear();
    return true;
}

/** max volumetric flow: speed per layer from the flow wanted at that height */
export function maxFlow({ start = 5, end = 30, height = 50, diameter = 30, width = 0.65, layer = 0.3 } = {}) {
    if (!startFresh()) return;
    const set = api.conf.get();
    const base = set.process;
    const first = base.firstSliceHeight || layer;
    const bottom = 2;
    const tops = layerTops(first, layer, height);
    const zStart = tops[bottom - 1];
    // what the export multiplies the bead by: outer wall flow and the filament's flow ratio
    const fil = set.filaments?.library?.find(p => p.name === set.filaments?.slots?.[0]);
    const mult = (base.outputShellMult || 1) * (fil?.flow || 1);
    const area = beadArea(width, layer) * mult;
    const flowAt = z => start + (end - start) * Math.max(0, Math.min(1, (z - zStart) / (height - zStart)));
    const ranges = [];
    const table = [];
    tops.forEach((z, i) => {
        if (i < 1) return;
        const flow = flowAt(z);
        ranges.push({ lo: i, hi: i, fields: { outputFinishrate: Math.round(flow / area * 10) / 10 } });
    });
    for (let z = Math.ceil(zStart); z <= height; z += 5) table.push([ z, +flowAt(z).toFixed(1) ]);
    useProfile(`calibration max flow ${start}-${end}`, p => {
        Object.assign(p, {
            sliceHeight: layer,
            sliceShells: 1,
            sliceFillType: 'vase',
            sliceFillSparse: 0,
            sliceTopLayers: 0,
            sliceBottomLayers: bottom,
            sliceLineWidthOuter: width,
            sliceDetectThin: 'basic',
            sliceGapFill: false,
            sliceSupportEnable: false,
            // the solid bottom slow; only the wall follows the flow ramp
            outputFeedrate: 40,
            outputSpeedSolid: 40,
            outputSpeedTop: 40,
            outputSpeedSparse: 40,
            outputMaxFlowrate: 200,
            outputIgnoreFilamentMvs: true,
            outputMinLayerTime: 0,
            outputSpeedSmall: 0,
            outputLayerRetract: false,
            outputRetractWipe: 0,
            outputScarfLength: 0,
            // enough acceleration to reach the speed on a 30 mm circle
            outputAccelOuter: Math.max(base.outputAccel || 0, base.outputAccelFill || 0, 5000),
            ranges
        });
    });
    addModel(new THREE.CylinderGeometry(diameter / 2, diameter / 2, height, 120).rotateX(Math.PI / 2), `max flow ${start}-${end}`);
    return { table, note: `flow = ${start} + (height − ${zStart.toFixed(1)}) × ${((end - start) / (height - zStart)).toFixed(3)} mm³/s` };
}

/** pressure advance tower: PA per mm of height at the profile's outer wall settings */
export function paTower({ start = 0, end = 0.06, step = 0.002, size = 40 } = {}) {
    if (!startFresh()) return;
    const base = api.conf.get().process;
    const layer = base.sliceHeight || 0.2;
    const first = base.firstSliceHeight || layer;
    const bottom = 3;
    const zStart = first + (bottom - 1) * layer;
    const mm = Math.max(1, Math.round((end - start) / step));
    const height = +(zStart + mm + 1).toFixed(2);
    const tops = layerTops(first, layer, height);
    const ranges = [];
    const table = [];
    tops.forEach((z, i) => {
        const k = Math.min(mm, Math.max(0, Math.floor(z - zStart)));
        ranges.push({ lo: i, hi: i, fields: { outputCalibPA: +(start + k * step).toFixed(4) } });
    });
    for (let k = 0; k <= mm; k += Math.max(1, Math.round(mm / 15))) table.push([ +(zStart + k).toFixed(1), +(start + k * step).toFixed(4) ]);
    useProfile(`calibration PA ${start}-${end}`, p => {
        Object.assign(p, {
            sliceShells: 2,
            sliceFillSparse: 0,
            sliceTopLayers: 0,
            sliceBottomLayers: bottom,
            sliceSupportEnable: false,
            outputKeepOuterSpeed: true,
            ranges
        });
    });
    addModel(box(size, size, height, 0), `PA tower ${start}-${end}`);
    return { table, note: `PA = ${start} + (height − ${zStart.toFixed(1)} mm, whole mm) × ${step}; at the outer wall speed ${base.outputFinishrate} mm/s and acceleration ${base.outputAccelOuter || base.outputAccel || 'machine'}` };
}

/** temperature tower: hottest at the bottom, one block per temperature */
export function tempTower({ high = 230, low = 190, step = 5, block = 8, size = 20 } = {}) {
    if (!startFresh()) return;
    const base = api.conf.get().process;
    const layer = base.sliceHeight || 0.2;
    const first = base.firstSliceHeight || layer;
    const temps = [];
    for (let t = high; t >= low - 1e-6; t -= step) temps.push(t);
    const neck = 1;
    const geos = [];
    let z = 0;
    const bands = [];
    temps.forEach((t, i) => {
        geos.push(box(size, size, block - neck, z));
        bands.push([ z, z + block, t ]);
        z += block - neck;
        if (i < temps.length - 1) geos.push(box(size * 0.85, size * 0.85, neck, z));
        z += i < temps.length - 1 ? neck : 0;
    });
    const tops = layerTops(first, layer, z);
    const ranges = tops.map((zt, i) => {
        const b = bands.find(([ lo, hi ]) => zt - layer / 2 < hi) ?? bands[bands.length - 1];
        return { lo: i, hi: i, fields: { outputCalibTemp: b[2] } };
    });
    useProfile(`calibration temperature ${high}-${low}`, p => {
        Object.assign(p, { sliceSupportEnable: false, ranges });
    });
    addModel(merge(geos), `temperature tower ${high}-${low}`);
    return { table: bands.map(([ lo, , t ]) => [ +lo.toFixed(1), t ]), note: `${block} mm per block, ${step} °C apart, hottest at the bottom` };
}

const TESTS = {
    flow: {
        title: 'Max volumetric flow',
        fields: [ [ 'start', 'start mm³/s', 5 ], [ 'end', 'end mm³/s', 30 ], [ 'height', 'height mm', 50 ] ],
        run: maxFlow,
        cols: [ 'height mm', 'flow mm³/s' ],
        read: 'Look for the height where the wall first gets gaps, gets rough or loses its sheen. Use about 10% below the flow at that height as the filament\'s max volumetric speed.'
    },
    pa: {
        title: 'Pressure advance tower',
        fields: [ [ 'start', 'start PA', 0 ], [ 'end', 'end PA', 0.06 ], [ 'step', 'PA per mm', 0.002 ] ],
        run: paTower,
        cols: [ 'height mm', 'PA' ],
        read: 'Look at the corners: too low PA bulges them, too high leaves a gap or a rounded corner. Measure the height of the sharpest corners.'
    },
    temp: {
        title: 'Temperature tower',
        fields: [ [ 'high', 'highest °C', 230 ], [ 'low', 'lowest °C', 190 ], [ 'step', 'step °C', 5 ] ],
        run: tempTower,
        cols: [ 'from mm', '°C' ],
        read: 'Pick the coolest block that still has strong layers and a smooth surface (less stringing and sagging than the hotter ones).'
    }
};

export function showCalibrate() {
    watchDelete();
    document.getElementById('calibrate-dialog')?.remove();
    const el = (tag, style, text) => {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (text !== undefined) e.textContent = text;
        return e;
    };
    const wrap = el('div', 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center');
    wrap.id = 'calibrate-dialog';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:min(460px,94vw);max-height:88vh;overflow-y:auto;background:#fff;color:#222;border-radius:10px;padding:16px 18px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)');
    wrap.appendChild(box);
    wrap.onclick = ev => { if (ev.target === wrap) wrap.remove() };
    let which = 'flow';
    const last = {};
    const render = (result) => {
        box.innerHTML = '';
        box.appendChild(el('div', 'display:block;font-weight:bold;font-size:16px', 'Calibration prints'));
        const tabs = el('div', 'display:flex;flex-direction:row;gap:6px;flex-wrap:wrap');
        for (const [ key, t ] of Object.entries(TESTS)) {
            const b = el('button', `display:inline-block;padding:5px 10px;border-radius:6px;border:1px solid ${key === which ? '#3b82f6' : '#bbb'};background:${key === which ? '#e8f0fe' : '#f3f3f3'};color:#222;cursor:pointer;font:13px sans-serif`, t.title);
            b.onclick = () => { which = key; render(); };
            tabs.appendChild(b);
        }
        box.appendChild(tabs);
        const test = TESTS[which];
        const inputs = {};
        const grid = el('div', 'display:grid;grid-template-columns:1fr 110px;gap:6px 10px;align-items:center');
        for (const [ key, label, def ] of test.fields) {
            grid.appendChild(el('label', 'display:block', label));
            const i = el('input', 'display:block;width:100%;box-sizing:border-box;padding:4px;font:13px sans-serif');
            i.type = 'number';
            i.step = 'any';
            i.value = last[which]?.[key] ?? def;
            inputs[key] = i;
            grid.appendChild(i);
        }
        box.appendChild(grid);
        box.appendChild(el('div', 'display:block;color:#555;font-size:12px', test.read));
        if (result) {
            box.appendChild(el('div', 'display:block;color:#555;font-size:12px', result.note));
            const tbl = el('table', 'border-collapse:collapse;font-size:12px');
            const row = (cells, head) => {
                const tr = el('tr');
                for (const c of cells) tr.appendChild(el(head ? 'th' : 'td', 'border:1px solid #ddd;padding:2px 8px;text-align:right', String(c)));
                tbl.appendChild(tr);
            };
            row(test.cols, true);
            result.table.forEach(r => row(r));
            box.appendChild(tbl);
            box.appendChild(el('div', 'display:block;color:#777;font-size:12px',
                'The model and a "calibration …" process profile are loaded: slice and export as usual. Pick your own process profile again afterwards.'));
        }
        const buttons = el('div', 'display:flex;flex-direction:row;gap:8px;justify-content:flex-end');
        const make = el('button', 'display:inline-block;padding:6px 12px;border-radius:6px;border:1px solid #3b82f6;background:#3b82f6;color:#fff;cursor:pointer;font:13px sans-serif', 'make test');
        make.onclick = () => {
            const args = {};
            for (const [ key ] of test.fields) args[key] = parseFloat(inputs[key].value);
            last[which] = args;
            const out = test.run(args);
            if (out) render(out);
        };
        const close = el('button', 'display:inline-block;padding:6px 12px;border-radius:6px;border:1px solid #bbb;background:#f3f3f3;color:#222;cursor:pointer;font:13px sans-serif', 'close');
        close.onclick = () => wrap.remove();
        buttons.appendChild(close);
        buttons.appendChild(make);
        box.appendChild(buttons);
    };
    render();
    document.body.appendChild(wrap);
}

export const calibrate = { show: showCalibrate, watch: watchDelete, maxFlow, paTower, tempTower };
