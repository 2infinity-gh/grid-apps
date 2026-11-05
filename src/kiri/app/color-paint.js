/**
 * Colour painting for multi-filament prints (FDM).
 *
 * Paint is stored per widget in widget.anno.cpaint as spheres in widget
 * coordinates: { point: {x,y,z}, radius, tool }. The slicer assigns the
 * volume inside each sphere to that filament slot (later strokes win), the
 * viewer draws the surface inside each sphere in that slot's colour.
 * Height range strokes (Orca's "height range" tool) add band: true: the whole
 * object between point.z - radius and point.z + radius.
 */

import { THREE } from '../../ext/three.js';
import { api } from './api.js';
import { avgc } from '../core/utils.js';
import { slotColor, slotLabel } from './slots.js';
import { colorSchemeRegistry } from './color/schemes.js';

const MIN_RADIUS = 0.5;
const MAX_RADIUS = 20;

let painting = null;    // { tool, erase, alert } while the brush is active
let listeners = [];     // notified when painting starts/stops or changes
let brush = 2;          // brush radius in mm
let down = null;        // widget under the pointer when the stroke started
let shape = 'sphere';   // brush: 'sphere' or 'band' (height range)

// colour shown for a slot: the printer's filament colour, else Kiri's extruder colour
function toolColor(tool) {
    const mode = api.mode.get_id();
    const theme = api.space.is_dark() ? 'dark' : 'light';
    const scheme = colorSchemeRegistry.getScheme(mode, theme).widget.deselected;
    return new THREE.Color(slotColor(tool, false, avgc) ?? scheme[tool % scheme.length]);
}

// pack paint spheres into a float texture: per sphere one texel (x,y,z,r) and one (r,g,b,-)
function paintTexture(paint) {
    const count = Math.max(1, paint.length * 2);
    const width = Math.ceil(Math.sqrt(count));
    const height = Math.ceil(count / width);
    const data = new Float32Array(width * height * 4);
    paint.forEach((rec, i) => {
        const c = toolColor(rec.tool);
        // a negative radius marks a height range band
        data.set([rec.point.x, rec.point.y, rec.point.z, rec.band ? -rec.radius : rec.radius], i * 8);
        data.set([c.r, c.g, c.b, 1], i * 8 + 4);
    });
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    return { texture, width, height };
}

// install (once) or refresh the colour paint overlay on a widget's material
export function updateColorOverlay(widget) {
    const paint = widget.anno.cpaint || [];
    const material = widget.getMaterial();
    const data = material.userData;
    data.cpaint = paint;
    if (data.cpaintShader) {
        const { texture, width, height } = paintTexture(paint);
        const u = data.cpaintShader.uniforms;
        u.cpTexture.value?.dispose();
        u.cpTexture.value = texture;
        u.cpTexSize.value.set(width, height);
        u.cpCount.value = paint.length;
        return;
    }
    if (!paint.length) return;
    material.onBeforeCompile = shader => {
        const { texture, width, height } = paintTexture(data.cpaint);
        data.cpaintShader = shader;
        shader.uniforms.cpTexture = { value: texture };
        shader.uniforms.cpTexSize = { value: new THREE.Vector2(width, height) };
        shader.uniforms.cpCount = { value: data.cpaint.length };
        shader.vertexShader = 'varying vec3 vCpPos;\n' + shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\nvCpPos = vec3(transformed);');
        shader.fragmentShader = `
            varying vec3 vCpPos;
            uniform sampler2D cpTexture;
            uniform vec2 cpTexSize;
            uniform int cpCount;
        ` + shader.fragmentShader.replace('#include <dithering_fragment>', `
            #include <dithering_fragment>
            vec3 cpColor;
            bool cpHit = false;
            for (int i = 0; i < 16384; i++) {
                if (i >= cpCount) break;
                int t = i * 2;
                vec2 uv0 = vec2((float(t % int(cpTexSize.x)) + 0.5) / cpTexSize.x, (float(t / int(cpTexSize.x)) + 0.5) / cpTexSize.y);
                vec4 sphere = texture2D(cpTexture, uv0);
                if (sphere.w < 0.0 ? abs(vCpPos.z - sphere.z) <= -sphere.w : distance(vCpPos, sphere.xyz) <= sphere.w) {
                    int c = t + 1;
                    vec2 uv1 = vec2((float(c % int(cpTexSize.x)) + 0.5) / cpTexSize.x, (float(c / int(cpTexSize.x)) + 0.5) / cpTexSize.y);
                    cpColor = texture2D(cpTexture, uv1).rgb;
                    cpHit = true; // keep looking: the last stroke wins
                }
            }
            if (cpHit) {
                // keep the lighting of the base colour, swap in the paint colour
                vec3 lw = vec3(0.299, 0.587, 0.114);
                float shade = mix(1.0, dot(gl_FragColor.rgb, lw) / max(dot(diffuse, lw), 0.05), 0.6);
                gl_FragColor.rgb = clamp(cpColor * shade, 0.0, 1.0);
            }
        `);
    };
    material.needsUpdate = true;
}

function addPaint(point, widget, erase) {
    const pos = widget.track.pos;
    // three coordinates (Y up) to widget coordinates (Z up), as for support paint
    const p = { x: point.x - pos.x, y: -point.z - pos.y, z: point.y - pos.z };
    const paint = widget.anno.cpaint = widget.anno.cpaint || [];
    // erasing paints the widget's own slot, which the slicer treats as unpainted
    const tool = erase ? widget.anno.extruder || 0 : painting.tool;
    const band = shape === 'band';
    const last = paint.peek();
    const near = band ? Math.abs(last?.point.z - p.z) < brush / 2 : last && dist(last.point, p) < brush / 2;
    if (last && last.tool === tool && !!last.band === band && last.radius === brush && near) return;
    paint.push(band ? { point: p, radius: brush, tool, band } : { point: p, radius: brush, tool });
    updateColorOverlay(widget);
    api.space.update();
}

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function showHint() {
    api.hide.alert(painting.alert);
    const size = shape === 'band' ? `height range ${(brush * 2).round(1)}mm` : `brush ${brush}mm`;
    painting.alert = api.show.alert(
        painting.erase ?
            `erasing colour paint · ${size} · [ ] size · esc stops` :
            `painting ${slotLabel(painting.tool)} · ${size} · [ ] size · shift erases · esc stops`, 1000);
}

function notify() {
    listeners.forEach(fn => fn(painting ? { tool: painting.tool, erase: painting.erase, brush } : null));
}

export function onPaintChange(fn) {
    listeners.push(fn);
}

export function setBrush(radius) {
    brush = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius)).round(1);
    if (painting) showHint();
    notify();
}

export function getBrush() {
    return brush;
}

export function setShape(next) {
    shape = next === 'band' ? 'band' : 'sphere';
    if (painting) showHint();
    notify();
}

export function getShape() {
    return shape;
}

export function paintStart(tool, opt = {}) {
    if (painting) {
        // switching slot or eraser while painting: keep the mouse hooks
        painting.tool = tool;
        painting.erase = !!opt.erase;
        showHint();
        notify();
        return;
    }
    painting = { tool, erase: !!opt.erase };
    api.feature.hover = true;
    api.feature.on_mouse_down = (int, event) => {
        if (int) {
            down = { widget: int.object.widget, erase: painting.erase || event?.shiftKey };
            addPaint(int.point, down.widget, down.erase);
        }
        return api.widgets.meshes();
    };
    api.feature.on_mouse_drag = ({ int }) => {
        if (down && int?.length && int[0].object.widget === down.widget) {
            addPaint(int[0].point, down.widget, down.erase);
        }
        return down ? [ down.widget.mesh ] : api.widgets.meshes();
    };
    api.feature.on_mouse_up = () => {
        down = null;
        api.conf.save();
        return api.widgets.meshes();
    };
    showHint();
    notify();
}

export function paintDone() {
    if (!painting) return;
    api.hide.alert(painting.alert);
    painting = null;
    down = null;
    api.feature.hover = false;
    api.feature.on_mouse_down = undefined;
    api.feature.on_mouse_drag = undefined;
    api.feature.on_mouse_up = undefined;
    api.conf.save();
    api.space.save();
    notify();
}

export function paintClear() {
    const widgets = api.selection.widgets();
    for (const w of widgets.length ? widgets : api.widgets.all()) {
        w.anno.cpaint = [];
        updateColorOverlay(w);
    }
    api.space.update();
    api.conf.save();
}

export function paintKey(evt) {
    if (!painting) return false;
    if (evt.key === '[' || evt.key === ']') {
        setBrush(brush * (evt.key === ']' ? 1.25 : 0.8));
        return true;
    }
    if (evt.key === 'Escape') {
        paintDone();
        return true;
    }
    return false;
}

export function isPainting() {
    return !!painting;
}

// recolour all overlays (e.g. after the printer's slot colours arrive)
export function refreshOverlays() {
    api.widgets.all().forEach(w => w.anno.cpaint?.length && updateColorOverlay(w));
    api.space.update();
}


function rotatePaint(widget, angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (const { point } of widget.anno.cpaint) {
        const { x, y } = point;
        point.x = x * cos - y * sin;
        point.y = x * sin + y * cos;
    }
}

function dropPaint(widget, why) {
    if (!widget.anno.cpaint?.length) return;
    widget.anno.cpaint = [];
    updateColorOverlay(widget);
    api.show.alert(`colour paint removed (${why})`, 3);
}

// Imported painted triangles (OrcaSlicer 3MF, filament states 1-based) to
// paint spheres in widget coordinates: the mesh may have been shifted while
// loading, so take the offset from the first vertex before/after.
const IMPORT_RADIUS = 1.2;
function importPaint(widget) {
    const { ref, paint } = widget.cpaintImport;
    delete widget.cpaintImport;
    const pa = widget.mesh.geometry.attributes.position.array;
    const shift = [ ref[0] - pa[0], ref[1] - pa[1], ref[2] - pa[2] ];
    let step = IMPORT_RADIUS;
    let out;
    // sample each painted triangle on a grid; coarsen if it gets too heavy
    do {
        const seen = new Set();
        out = [];
        for (const { state, tri } of paint) {
            const a = tri.slice(0, 3), b = tri.slice(3, 6), c = tri.slice(6, 9);
            const edge = Math.max(dist3(a, b), dist3(b, c), dist3(c, a));
            const n = Math.max(1, Math.ceil(edge / step));
            for (let i = 0; i <= n; i++) {
                for (let j = 0; j <= n - i; j++) {
                    const p = [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * i / n + (c[k] - a[k]) * j / n - shift[k]);
                    const key = `${state}:${p.map(v => Math.round(v / (step / 2))).join(',')}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ point: { x: p[0], y: p[1], z: p[2] }, radius: IMPORT_RADIUS, tool: state - 1 });
                }
            }
        }
        step *= 1.5;
    } while (out.length > 12000);
    widget.anno.cpaint = [ ...(widget.anno.cpaint || []), ...out ];
    updateColorOverlay(widget);
}

function dist3(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// hook into the app: keys, restoring overlays on load, keeping paint in step with transforms
export function initColorPaint() {
    api.event.on('cpaint.import', () => {
        const scheme = colorSchemeRegistry.getScheme(api.mode.get_id(), api.space.is_dark() ? 'dark' : 'light').widget;
        for (const w of api.widgets.all()) {
            if (w.cpaintImport) importPaint(w);
            w.setColor(api.selection.contains(w) ? scheme.selected : scheme.deselected, undefined, false);
        }
        api.space.update();
        api.conf.save();
    });
    api.onkey(evt => {
        if (evt.key) return paintKey(evt.key);
        if (evt.up?.key === 'Escape') return paintKey(evt.up);
        return false;
    });
    api.event.on('widget.add', added => {
        for (const w of [ added ].flat()) {
            if (w?.anno?.cpaint?.length) updateColorOverlay(w);
        }
    });
    api.event.on('widget.duplicate', (nw, ow) => {
        if (ow?.anno?.cpaint?.length) {
            nw.anno.cpaint = structuredClone(ow.anno.cpaint);
            updateColorOverlay(nw);
        }
    });
    api.event.on('widget.rotate', ({ widget, x, y, z }) => {
        if (!widget?.anno?.cpaint?.length) return;
        if (x || y) dropPaint(widget, 'tilted');
        else if (z) { rotatePaint(widget, z); updateColorOverlay(widget); }
    });
    api.event.on('widget.mirror', ({ widget }) => dropPaint(widget, 'mirrored'));
    api.event.on('widget.scale', ({ widget, x, y, z }) => {
        if (!widget?.anno?.cpaint?.length) return;
        for (const rec of widget.anno.cpaint) {
            rec.point.x *= x;
            rec.point.y *= y;
            rec.point.z *= z;
            rec.radius *= rec.band ? z : (x + y + z) / 3;
        }
        updateColorOverlay(widget);
    });
}

export const colorPaint = { init: initColorPaint, start: paintStart, done: paintDone, clear: paintClear, refresh: refreshOverlays,
    onChange: onPaintChange, setBrush, getBrush, setShape, getShape, isPainting };
