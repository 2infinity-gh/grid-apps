/**
 * Rotation rings around the selection (rotate tool): drag the red, green or
 * blue ring to turn the selection around X, Y or Z, in 5° steps (1° with shift).
 * Built in the world group, so coordinates are Kiri's (Z up).
 */

import { THREE } from '../../ext/three.js';
import { api } from './api.js';
import { space } from '../../moto/space.js';

const AXES = {
    x: { color: 0xe53935, orient: g => g.rotateY(Math.PI / 2) },
    y: { color: 0x43a047, orient: g => g.rotateX(Math.PI / 2) },
    z: { color: 0x1e88e5, orient: g => g },
};

let gizmo = null;       // { group, rings: [mesh], planes: { axis: mesh }, center }
let active = false;
let drag = null;        // { axis, start, applied }

function selectionBounds() {
    const box = api.selection.get_bounds?.();
    return box && !box.isEmpty() ? box : null;
}

function build() {
    remove();
    const box = selectionBounds();
    if (!box) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.6 + 4;
    const tube = Math.max(0.5, radius * 0.025);
    const group = new THREE.Group();
    group.position.copy(center);
    const rings = [], planes = {};
    for (const [axis, def] of Object.entries(AXES)) {
        const ring = new THREE.Mesh(
            def.orient(new THREE.TorusGeometry(radius, tube, 12, 96)),
            new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.85, depthTest: false }));
        ring.renderOrder = 999;
        ring.userData.axis = axis;
        // a wider invisible ring makes the handle easier to grab (fingers)
        const grab = new THREE.Mesh(
            def.orient(new THREE.TorusGeometry(radius, tube * 4, 8, 64)),
            new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        grab.userData.axis = axis;
        grab.userData.ring = ring;
        // invisible plane through the centre across the ring: pointer positions while dragging
        const plane = new THREE.Mesh(
            def.orient(new THREE.PlaneGeometry(10000, 10000)),
            new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        group.add(ring, grab, plane);
        rings.push(grab);
        planes[axis] = plane;
    }
    space.world.add(group);
    gizmo = { group, rings, planes, center, radius };
    space.update();
}

function remove() {
    if (gizmo) {
        space.world.remove(gizmo.group);
        gizmo = null;
        space.update();
    }
}

// angle of a pointer position around the ring's axis, in the ring's plane
function angleAt(axis, worldPoint) {
    const p = gizmo.group.worldToLocal(worldPoint.clone());
    switch (axis) {
        case 'x': return Math.atan2(p.z, p.y);
        case 'y': return Math.atan2(p.x, p.z);
        default:  return Math.atan2(p.y, p.x);
    }
}

function closestRing() {
    const { raycaster } = space.internals();
    let best = { axis: null, err: Infinity };
    for (const [axis, plane] of Object.entries(gizmo.planes)) {
        const hit = raycaster.intersectObject(plane, false)[0];
        if (!hit) continue;
        const p = gizmo.group.worldToLocal(hit.point.clone());
        const inPlane = axis === 'x' ? Math.hypot(p.y, p.z) : axis === 'y' ? Math.hypot(p.x, p.z) : Math.hypot(p.x, p.y);
        const err = Math.abs(inPlane - gizmo.radius);
        if (err < best.err) best = { axis, err, point: hit.point };
    }
    return best;
}

function highlight(axis) {
    for (const grab of gizmo?.rings || []) {
        grab.userData.ring.material.opacity = !axis || grab.userData.axis === axis ? 0.85 : 0.25;
    }
    space.update();
}

export function startRotateGizmo() {
    active = true;
    build();
    api.feature.hover = true;
    api.feature.on_mouse_down = (int, event) => {
        if (!int) {
            // which objects may start a drag: the ring handles
            return gizmo ? gizmo.rings : [];
        }
        if (!int.object.userData.axis) return;
        // where rings cross on screen several handles are hit: take the ring
        // whose circle passes closest to the pointer (measured in its own plane)
        const { axis, point } = closestRing();
        if (!axis) return;
        drag = { axis, start: angleAt(axis, point), applied: 0, fine: event?.shiftKey };
        highlight(axis);
    };
    api.feature.on_mouse_drag = ({ delta, up, int }) => {
        if (!drag) return;
        if (up) {
            drag = null;
            build();
            api.space.auto_save();
            return;
        }
        if (!delta) {
            // surface the pointer is tracked on while dragging
            return [ gizmo.planes[drag.axis] ];
        }
        if (!int?.length) return;
        let turn = angleAt(drag.axis, int[0].point) - drag.start;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // -PI..PI
        const step = (drag.fine ? 1 : 5) * Math.PI / 180;
        const want = Math.round(turn / step) * step;
        const add = want - drag.applied;
        if (Math.abs(add) >= step / 2) {
            api.selection.rotate(
                drag.axis === 'x' ? add : 0,
                drag.axis === 'y' ? add : 0,
                drag.axis === 'z' ? add : 0);
            drag.applied = want;
            // keep turning past ±180°: restart the measurement from here
            if (Math.abs(want) > Math.PI * 0.75) {
                drag.start += want;
                drag.applied = 0;
            }
        }
    };
    api.feature.on_mouse_up = (object, event) => {
        // a plain click on an object selects it while the rotate tool is active
        const widget = object?.object?.widget;
        if (widget) api.platform.select(widget, event?.shiftKey);
        return api.widgets.meshes();
    };
}

export function stopRotateGizmo() {
    active = false;
    drag = null;
    remove();
    api.feature.hover = false;
    api.feature.on_mouse_down = undefined;
    api.feature.on_mouse_drag = undefined;
    api.feature.on_mouse_up = undefined;
}

// follow the selection while the tool is active
export function refreshRotateGizmo() {
    if (active && !drag) build();
}

// for headless tests: screen position of a point on a ring (angle in degrees)
self.kiri_rotate_gizmo = {
    screenPoint(axis, deg) {
        if (!gizmo) return null;
        const r = gizmo.rings.find(g => g.userData.axis === axis).geometry.parameters.radius;
        const a = deg * Math.PI / 180;
        const local = axis === 'z' ? new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)
            : axis === 'x' ? new THREE.Vector3(0, Math.cos(a) * r, Math.sin(a) * r)
            : new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
        const world = gizmo.group.localToWorld(local);
        const { camera, renderer } = space.internals();
        const v = world.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
    }
};

export const rotateGizmo = { start: startRotateGizmo, stop: stopRotateGizmo, refresh: refreshRotateGizmo };
