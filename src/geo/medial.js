/**
 * Centre lines (an approximate medial axis) of narrow polygons, with the
 * local width at every point: for Orca-style gap infill.
 *
 * The polygon is triangulated (earcut, refined toward the constrained
 * Delaunay triangulation). In a narrow shape the inner edges of such a
 * triangulation run across it, so joining their midpoints gives the centre
 * line (the chordal axis) and their lengths give the width.
 */

import earcut, { refine } from '../ext/earcut.js';

// a closed ring of points with no segment longer than step
function densify(points, step, out) {
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const a = points[i], b = points[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const cnt = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k < cnt; k++) {
            out.push(a.x + (b.x - a.x) * k / cnt, a.y + (b.y - a.y) * k / cnt);
        }
    }
}

/**
 * @param {Polygon} poly outline with poly.inner holes
 * @param {object} opt { minW, maxW, step, minLen }
 * @returns {number[][]} polylines as flat [x, y, width, x, y, width, ...]
 */
export function centerLines(poly, opt) {
    const { minW = 0, maxW = Infinity, minLen = 0 } = opt;
    const step = opt.step || Math.max(0.05, Math.min(0.2, maxW / 3));
    const coords = [], holes = [], rings = [];
    const addRing = pts => {
        const start = coords.length / 2;
        densify(pts, step, coords);
        rings.push([ start, coords.length / 2 ]);
        return start;
    };
    addRing(poly.points);
    for (const h of poly.inner || []) holes.push(addRing(h.points));
    const nv = coords.length / 2;
    if (nv < 3) return [];
    const tris = earcut(coords, holes.length ? holes : null, 2);
    if (!tris.length) return [];
    refine(tris, coords, 2);

    // boundary edges are the ones between neighbours on a ring
    const ringOf = new Int32Array(nv);
    rings.forEach(([s, e], r) => { for (let i = s; i < e; i++) ringOf[i] = r; });
    const isBoundary = (a, b) => {
        const [s, e] = rings[ringOf[a]];
        if (ringOf[a] !== ringOf[b]) return false;
        const n = e - s, d = (b - a + n) % n;
        return d === 1 || d === n - 1;
    };
    const X = i => coords[i * 2], Y = i => coords[i * 2 + 1];

    // graph nodes: the middle of every inner edge (key lo*nv+hi), triangle
    // junctions and end points; node = [x, y, width]
    const nodes = new Map();
    const adj = new Map();
    let nextId = -1;
    const edgeNode = (a, b) => {
        const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv + hi;
        if (!nodes.has(key)) nodes.set(key, [ (X(a) + X(b)) / 2, (Y(a) + Y(b)) / 2, Math.hypot(X(a) - X(b), Y(a) - Y(b)) ]);
        return key;
    };
    const link = (p, q) => {
        if (!adj.has(p)) adj.set(p, []);
        if (!adj.has(q)) adj.set(q, []);
        adj.get(p).push(q);
        adj.get(q).push(p);
    };
    for (let t = 0; t < tris.length; t += 3) {
        const v = [ tris[t], tris[t + 1], tris[t + 2] ];
        const inner = [];
        for (let k = 0; k < 3; k++) {
            const a = v[k], b = v[(k + 1) % 3];
            if (!isBoundary(a, b)) inner.push([ a, b, v[(k + 2) % 3] ]);
        }
        if (inner.length === 2) {
            link(edgeNode(inner[0][0], inner[0][1]), edgeNode(inner[1][0], inner[1][1]));
        } else if (inner.length === 3) {
            const ks = inner.map(([a, b]) => edgeNode(a, b));
            const ws = ks.map(k => nodes.get(k)[2]);
            const id = nextId--;
            nodes.set(id, [ (X(v[0]) + X(v[1]) + X(v[2])) / 3, (Y(v[0]) + Y(v[1]) + Y(v[2])) / 3, Math.max(...ws) ]);
            ks.forEach(k => link(id, k));
        } else if (inner.length === 1) {
            // the end of a strip: run on toward the tip, stopping half a width short
            const [ a, b, c ] = inner[0];
            const k = edgeNode(a, b), [ mx, my, w ] = nodes.get(k);
            const dx = X(c) - mx, dy = Y(c) - my, d = Math.hypot(dx, dy);
            const run = d - w / 2;
            if (run > 0.01) {
                const id = nextId--;
                nodes.set(id, [ mx + dx * run / d, my + dy * run / d, w ]);
                link(k, id);
            }
        }
    }

    // prune short side branches (the spurs square ends and corners leave):
    // a run from an end to a junction shorter than the widest gap line
    const unlink = (p, q) => {
        adj.set(p, adj.get(p).filter(n => n !== q));
        adj.set(q, adj.get(q).filter(n => n !== p));
    };
    const spur = opt.spur ?? (isFinite(maxW) ? maxW : 0);
    const cut = [];
    for (const [ id, nb ] of adj) {
        if (nb.length !== 1) continue;
        const run = [ id ];
        let prev = id, cur = nb[0], len = 0;
        while (true) {
            const [ px, py ] = nodes.get(prev), [ cx, cy ] = nodes.get(cur);
            len += Math.hypot(cx - px, cy - py);
            if (len >= spur) break;
            const cn = adj.get(cur);
            if (cn.length >= 3) {
                for (let i = 0; i < run.length; i++) cut.push([ run[i], run[i + 1] ?? cur ]);
                break;
            }
            if (cn.length !== 2) break;
            run.push(cur);
            const nx = cn[0] === prev ? cn[1] : cn[0];
            prev = cur; cur = nx;
        }
    }

    // (all at once, so both spurs of a square end go)
    for (const [ p, q ] of cut) unlink(p, q);

    // walk the graph into polylines, breaking at junctions and ends
    const used = new Set();
    const ekey = (p, q) => p < q ? `${p},${q}` : `${q},${p}`;
    const lines = [];
    const walk = (start, next) => {
        const path = [ start ];
        let prev = start, cur = next;
        used.add(ekey(prev, cur));
        while (true) {
            path.push(cur);
            const nb = adj.get(cur);
            if (nb.length !== 2) break;
            const nx = nb[0] === prev ? nb[1] : nb[0];
            if (used.has(ekey(cur, nx))) break;
            used.add(ekey(cur, nx));
            prev = cur; cur = nx;
        }
        lines.push(path);
    };
    for (const [ id, nb ] of adj) if (nb.length && nb.length !== 2) for (const q of nb) if (!used.has(ekey(id, q))) walk(id, q);
    // closed loops (no junction or end anywhere)
    for (const [ id, nb ] of adj) for (const q of nb) if (!used.has(ekey(id, q))) walk(id, q);

    // Douglas-Peucker on position and width: keep a point when dropping it
    // would move the line or change the width by more than tol
    const tol = opt.tol ?? 0.025, wtol = opt.wtol ?? 0.05;
    const simplify = flat => {
        const n = flat.length / 3;
        if (n < 3) return flat;
        const keep = new Uint8Array(n);
        keep[0] = keep[n - 1] = 1;
        const stack = [[ 0, n - 1 ]];
        while (stack.length) {
            const [ a, b ] = stack.pop();
            const ax = flat[a * 3], ay = flat[a * 3 + 1], aw = flat[a * 3 + 2];
            const bx = flat[b * 3], by = flat[b * 3 + 1], bw = flat[b * 3 + 2];
            const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
            let worst = -1, wd = tol;
            for (let i = a + 1; i < b; i++) {
                const px = flat[i * 3], py = flat[i * 3 + 1], pw = flat[i * 3 + 2];
                const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
                const d = Math.max(Math.hypot(px - ax - t * dx, py - ay - t * dy), Math.abs(pw - (aw + t * (bw - aw))) * tol / wtol);
                if (d > wd) { wd = d; worst = i; }
            }
            if (worst > 0) { keep[worst] = 1; stack.push([ a, worst ], [ worst, b ]); }
        }
        const out = [];
        for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]);
        return out;
    };

    // widths clamped to the gap fill range; too thin points split a line
    const out = [];
    for (const path of lines) {
        let cur = [], len = 0;
        const flush = () => {
            if (cur.length >= 6 && len >= minLen) out.push(simplify(cur));
            cur = []; len = 0;
        };
        for (const id of path) {
            const [ x, y, w ] = nodes.get(id);
            if (w < minW) { flush(); continue; }
            if (cur.length) len += Math.hypot(x - cur[cur.length - 3], y - cur[cur.length - 2]);
            cur.push(x, y, Math.min(w, maxW));
        }
        flush();
    }
    return out;
}
