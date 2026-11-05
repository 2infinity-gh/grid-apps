/**
 * Tree supports (support type "tree").
 *
 * Kiri's support pass leaves in slice.shadow, per layer, the areas right
 * under an overhang that need support. Tree supports start branch tips on
 * a grid inside those areas and grow the branches down layer by layer:
 *
 * - a branch moves sideways at most dz * tan(branch angle) per layer, toward
 *   its nearest neighbour, and merges with it when they meet (fewer, thicker
 *   trunks)
 * - a branch that gets too close to the model is pushed away from it; when
 *   that is not possible within one layer's move it ends, resting on the model
 * - tips start at the tip diameter, reach the branch diameter within a few
 *   layers, and then widen with the diameter angle on the way down
 *
 * Organic (support type "organic") smooths each branch's path afterwards, so
 * branches bend in curves and flow into each other where they merge, and
 * lets tips drop straight down for a few layers before they lean.
 *
 * Each layer's support is the union of its branch circles in slice.supports;
 * the caller trims it with the part (xy offset, top/bottom z distance) and
 * fills it like any other support.
 */

const DEG = Math.PI / 180;
const TIP_LAYERS = 6;   // layers for a tip to grow to the branch diameter
const RAMP_LAYERS = 5;  // organic: layers over which a tip starts to lean
const SMOOTH_PASSES = 30;

// ray casting on a polygon's points (holes in poly.inner)
function insideRing(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function insidePoly(poly, x, y) {
    if (!insideRing(poly.points, x, y)) return false;
    for (const hole of poly.inner || []) if (insideRing(hole.points, x, y)) return false;
    return true;
}

// the model at one layer, ready for distance and inside tests
function obstacle(polys) {
    const items = [];
    for (const poly of polys || []) {
        const rings = [ poly.points, ...(poly.inner || []).map(p => p.points) ];
        const segs = [];
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i++) {
                const a = ring[i], b = ring[(i + 1) % ring.length];
                segs.push([ a.x, a.y, b.x, b.y ]);
                minx = Math.min(minx, a.x); miny = Math.min(miny, a.y);
                maxx = Math.max(maxx, a.x); maxy = Math.max(maxy, a.y);
            }
        }
        items.push({ poly, segs, minx, miny, maxx, maxy });
    }
    return {
        // { inside, dist, qx, qy }: nearest point of the model's outline within `range`
        probe(x, y, range) {
            let best = { inside: false, dist: Infinity, qx: x, qy: y };
            for (const it of items) {
                if (x < it.minx - range || x > it.maxx + range || y < it.miny - range || y > it.maxy + range) continue;
                if (!best.inside && insidePoly(it.poly, x, y)) best.inside = true;
                for (const [ax, ay, bx, by] of it.segs) {
                    const dx = bx - ax, dy = by - ay;
                    const len = dx * dx + dy * dy;
                    let t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
                    t = Math.max(0, Math.min(1, t));
                    const qx = ax + t * dx, qy = ay + t * dy;
                    const d = Math.hypot(x - qx, y - qy);
                    if (d < best.dist) { best.dist = d; best.qx = qx; best.qy = qy; }
                }
            }
            return best;
        }
    };
}

// branch tips for one layer's overhang areas: a fixed xy grid (so tips line up
// between layers), or the area's centre when it is smaller than the grid
function contactPoints(polys, spacing) {
    const out = [];
    for (const poly of polys || []) {
        const b = poly.getBounds ? poly.getBounds() : poly.bounds;
        if (!b) continue;
        let found = 0;
        for (let x = Math.ceil(b.minx / spacing) * spacing; x <= b.maxx; x += spacing) {
            for (let y = Math.ceil(b.miny / spacing) * spacing; y <= b.maxy; y += spacing) {
                if (insidePoly(poly, x, y)) { out.push({ x, y }); found++; }
            }
        }
        if (!found) {
            const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
            if (insidePoly(poly, cx, cy)) out.push({ x: cx, y: cy });
            else {
                // thin or curved area (the ring under a ball's overhang): points
                // along its outline, one per grid spacing
                const pts = poly.points;
                let walked = spacing;
                for (let i = 0; i < pts.length; i++) {
                    const a = pts[i], c = pts[(i + 1) % pts.length];
                    if (walked >= spacing) { out.push({ x: a.x, y: a.y }); walked = 0; }
                    walked += Math.hypot(c.x - a.x, c.y - a.y);
                }
            }
        }
    }
    return out;
}

export function treeSupports({ stack, process, lineWidth, newPoint, newPolygon, POLY, progress, organic }) {
    const angle = Math.min(75, Math.max(5, process.sliceSupportTreeAngle ?? 40));
    const tipR = Math.max(lineWidth, process.sliceSupportTreeTip ?? 1.2) / 2;
    const branchR = Math.max(tipR, (process.sliceSupportTreeBranch ?? 3) / 2);
    const grow = Math.tan((process.sliceSupportTreeGrow ?? 3) * DEG);
    const spacing = Math.max(1, process.sliceSupportTreeSpacing ?? 4);
    const margin = lineWidth / 2;
    const minArea = lineWidth * lineWidth;

    const layers = stack.slice().sort((a, b) => b.z - a.z);   // top down
    let nodes = [];
    let count = 0;
    // per layer: { node, x, y, r } of every branch, drawn after (organic) smoothing
    const placed = layers.map(() => []);
    const models = [];

    for (let i = 0; i < layers.length; i++) {
        const slice = layers[i];
        const below = layers[i + 1];
        const dz = below ? slice.z - below.z : slice.z;
        const step = dz * Math.tan(angle * DEG);
        models[i] = models[i] || obstacle(slice.clips);

        // 1. new tips under this layer's overhangs, unless a branch is already there
        for (const p of contactPoints(slice.shadow, spacing)) {
            if (nodes.some(n => Math.hypot(n.x - p.x, n.y - p.y) < Math.max(n.r, spacing * 0.6))) continue;
            nodes.push({ x: p.x, y: p.y, r: tipR, age: 0, path: [] });
        }

        // 2. where each branch is on this layer
        for (const n of nodes) {
            const at = { node: n, layer: i, x: n.x, y: n.y, r: n.r };
            n.path.push(at);
            placed[i].push(at);
        }
        if (!below) break;

        // 3. move the branches for the layer below: toward a neighbour, away from the model
        const model2 = models[i + 1] = obstacle(below.clips);
        // the bare part (clips are the part grown by the support xy distance)
        const part2 = obstacle(below.topPolys ? below.topPolys() : below.clips);
        const clear = n => {
            const hit = model2.probe(n.x, n.y, n.r + margin + step);
            return !hit.inside && hit.dist >= n.r + margin;
        };
        // a branch only ends (rests on the model) when its centre would be on
        // the bare part; inside the xy distance it keeps being pushed out (the
        // trim afterwards cuts off what is too close), and the part below a
        // gentle overhang (a ball's underside) moves away from it anyway
        const free = n => {
            const hit = part2.probe(n.x, n.y, lineWidth);
            return !hit.inside && hit.dist >= lineWidth / 4;
        };
        for (const n of nodes) {
            // organic tips drop straight first, then lean more and more
            let budget = organic ? step * Math.min(1, (n.age + 1) / RAMP_LAYERS) : step;
            // keep clear of the model below
            const hit = model2.probe(n.x, n.y, n.r + margin + step);
            if (hit.inside || hit.dist < n.r + margin) {
                let ux = n.x - hit.qx, uy = n.y - hit.qy;
                let len = Math.hypot(ux, uy) || 1;
                if (hit.inside) { ux = -ux; uy = -uy; }
                ux /= len; uy /= len;
                const need = hit.inside ? hit.dist + n.r + margin : n.r + margin - hit.dist;
                const move = Math.min(need, budget);
                n.x += ux * move; n.y += uy * move;
                budget -= move;
                if (!free(n)) { n.dead = true; continue; }   // rests on the model
            }
            // drift toward the nearest neighbour to merge into a trunk
            let near, nd = Infinity;
            for (const m of nodes) {
                if (m === n || m.dead) continue;
                const d = Math.hypot(m.x - n.x, m.y - n.y);
                if (d < nd) { nd = d; near = m; }
            }
            if (near && budget > 0 && nd < spacing * 4) {
                const move = Math.min(budget, nd / 2);
                const ox = n.x, oy = n.y;
                n.x += (near.x - n.x) / nd * move;
                n.y += (near.y - n.y) / nd * move;
                if (!clear(n)) { n.x = ox; n.y = oy; }
            }
        }
        nodes = nodes.filter(n => !n.dead);

        // 4. merge branches that meet
        for (let a = 0; a < nodes.length; a++) {
            const n = nodes[a];
            if (n.gone) continue;
            for (let b = a + 1; b < nodes.length; b++) {
                const m = nodes[b];
                if (m.gone) continue;
                const d = Math.hypot(m.x - n.x, m.y - n.y);
                if (d <= Math.max(step, Math.min(n.r, m.r))) {
                    const wn = n.r * n.r, wm = m.r * m.r;
                    n.x = (n.x * wn + m.x * wm) / (wn + wm);
                    n.y = (n.y * wn + m.y * wm) / (wn + wm);
                    n.r = Math.max(n.r, m.r, Math.sqrt(wn + wm) * 0.8);
                    n.age = Math.max(n.age, m.age);
                    m.gone = true;
                    m.into = n;
                }
            }
        }
        nodes = nodes.filter(n => !n.gone);

        // 5. thicker on the way down
        for (const n of nodes) {
            n.age++;
            n.r = n.r < branchR ? Math.min(branchR, n.r + (branchR - tipR) / TIP_LAYERS) : n.r + dz * grow;
        }
        if (progress) progress(++count / layers.length * (organic ? 0.7 : 1));
    }

    if (organic) smooth(placed, models, margin);

    // this layer's support: the union of its branch circles
    layers.forEach((slice, i) => {
        if (!placed[i].length) return;
        const circles = placed[i].map(n => {
            const segs = Math.max(8, Math.min(32, Math.round(2 * Math.PI * n.r / 0.6)));
            return newPolygon().centerCircle(newPoint(n.x, n.y, slice.z), n.r, segs, true);
        });
        slice.supports = POLY.setZ(POLY.union(circles, minArea, true), slice.z);
    });
}

// organic: relax every branch's path (each point toward the mean of its
// neighbours above and below), keeping tips and feet in place, then undo any
// point that the smoothing moved into the model
function smooth(placed, models, margin) {
    const all = placed.flat();
    // the point that follows each one on the layer below: the same branch,
    // or the branch it merged into
    for (const p of all) {
        const n = p.node;
        const k = n.path.indexOf(p);
        p.up = k > 0 ? n.path[k - 1] : null;
        p.down = n.path[k + 1] || (n.into ? n.into.path.find(q => q.layer === p.layer + 1) : null) || null;
        p.ox = p.x; p.oy = p.y;
    }
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        for (const p of all) {
            if (!p.up || !p.down) { p.nx = p.x; p.ny = p.y; continue; }
            p.nx = (p.up.x + 2 * p.x + p.down.x) / 4;
            p.ny = (p.up.y + 2 * p.y + p.down.y) / 4;
        }
        for (const p of all) { p.x = p.nx; p.y = p.ny; }
    }
    for (const p of all) {
        const model = models[p.layer];
        if (!model) continue;
        const hit = model.probe(p.x, p.y, p.r + margin);
        if (hit.inside || hit.dist < p.r + margin) { p.x = p.ox; p.y = p.oy; }
    }
}
