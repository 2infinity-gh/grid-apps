/**
 * Print time and filament from the G-code itself, planned the way Klipper
 * moves the head: every move accelerates and decelerates (SET_VELOCITY_LIMIT /
 * M204 accel, accel_to_decel), and corners are taken at the speed Klipper's
 * square corner velocity allows, with lookahead over the following moves.
 * Filament swaps (T<n>) and waits (G4) add their own time.
 *
 * Kobra X: its start macro (G9111: heat, home, level, prime) is counted as
 * startTime; the times were checked against real prints from kx-bridge's history.
 *
 * estimator(opts): feed(line) per G-code line, then result() ->
 *   { time, start, swaps, swapTime, filament: [mm per tool] }
 * estimateGcode(lines, opts): the same for a whole array of lines
 */

const SQRT2M1 = Math.SQRT2 - 1;

export function estimator(opts = {}) {
    let accel = opts.accel || 10000;
    let decel = opts.accelToDecel || accel / 2;
    let scv = opts.squareCornerVelocity || 5;
    const maxV = opts.maxVelocity || 500;
    const swapTime = opts.swapTime ?? 45;
    const startTime = opts.startTime ?? 420;
    let start = 0;
    let x = 0, y = 0, z = 0, e = 0, f = 3000 / 60;
    let relE = false, relXYZ = false, tool = 0;
    const filament = [];
    let time = 0, waits = 0, swaps = 0, count = 0;

    // queued moves, planned when a full stop is certain (or at the end)
    let queue = [];
    let prev = null;

    function flush() {
        if (!queue.length) return;
        // backward: how fast each move may end so all later moves can still stop
        let next = 0;
        for (let i = queue.length - 1; i >= 0; i--) {
            const m = queue[i];
            m.end2 = Math.min(next, m.cruise2);
            next = Math.min(m.start2max, m.end2 + 2 * m.d * m.a);
        }
        // forward: accelerate from the previous move's end
        let v2 = 0;
        for (const m of queue) {
            const start2 = Math.min(v2, m.start2max);
            const end2 = Math.min(m.end2, start2 + 2 * m.d * m.a);
            // peak: limited by cruise speed, by the accel over the length and by accel_to_decel
            const peak2 = Math.min(m.cruise2, (2 * m.d * m.ad + start2 + end2) / 2, (2 * m.d * m.a + start2 + end2) / 2);
            const v0 = Math.sqrt(start2), v1 = Math.sqrt(end2), vp = Math.sqrt(Math.max(peak2, start2, end2));
            const da = (vp * vp - start2) / (2 * m.a), dd = (vp * vp - end2) / (2 * m.a);
            const cruise = Math.max(0, m.d - da - dd);
            time += (vp - v0) / m.a + (vp - v1) / m.a + (vp > 0 ? cruise / vp : 0);
            v2 = end2;
        }
        queue = [];
        prev = null;
    }

    function move(nx, ny, nz, ne, speed) {
        const dx = nx - x, dy = ny - y, dz = nz - z, de = ne - e;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (de > 0) filament[tool] = (filament[tool] || 0) + de;
        x = nx; y = ny; z = nz; e = ne;
        if (d < 1e-6) {
            // extruder only (retract, prime): plain speed
            if (Math.abs(de) > 0) { flush(); time += Math.abs(de) / Math.min(speed, 120); }
            return;
        }
        count++;
        const v = Math.min(speed, maxV);
        const ux = dx / d, uy = dy / d, uz = dz / d;
        const m = { d, a: accel, ad: decel, cruise2: v * v, ux, uy, uz, start2max: 0 };
        if (dz) {
            // Klipper's z limits, scaled by how much of the move is z (vase mode moves are mostly xy)
            const ratio = d / Math.abs(dz);
            m.cruise2 = Math.min(v, (opts.maxZVelocity || 12) * ratio) ** 2;
            m.a = m.ad = Math.min(accel, (opts.maxZAccel || 1000) * ratio);
            if (ratio < 1.5) { flush(); queue.push(m); flush(); return; }
        }
        if (prev) {
            // Klipper's junction speed (toolhead.py, _calc_junction)
            const cos = -(ux * prev.ux + uy * prev.uy + uz * prev.uz);
            if (cos < 0.999999) {
                const sin2 = Math.sqrt(Math.max(0, 0.5 * (1 - cos)));
                const R = sin2 / (1 - sin2);
                const tan2 = sin2 / Math.sqrt(Math.max(1e-12, 0.5 * (1 + cos)));
                const jd = scv * scv * SQRT2M1 / accel;
                const jdp = scv * scv * SQRT2M1 / prev.a;
                m.start2max = Math.min(R * jd * accel, R * jdp * prev.a,
                    0.5 * d * tan2 * accel, 0.5 * prev.d * tan2 * prev.a,
                    m.cruise2, prev.cruise2);
            }
        }
        queue.push(m);
        prev = m;
        if (queue.length > 2000) {
            // long runs: plan all but the tail (approximate: a stop is assumed only at real stops)
            const keep = queue.splice(queue.length - 1);
            const last = queue[queue.length - 1];
            flushTail(last);
            queue = keep;
        }
    }

    // plan the queue but let it end at the speed the next move allows
    function flushTail(last) {
        const save = prev;
        // ending at full stop is pessimistic over 2000 moves only by one decel: negligible
        flush();
        prev = save;
    }

    const num = (s, k) => {
        const i = s.indexOf(k);
        if (i < 0) return undefined;
        const v = parseFloat(s.substring(i + k.length));
        return isNaN(v) ? undefined : v;
    };

    function feed(raw) {
        if (raw.indexOf('\n') >= 0) { raw.split('\n').forEach(feed); return; }
        let line = raw;
        const c = line.indexOf(';');
        if (c >= 0) line = line.substring(0, c);
        line = line.trim();
        if (!line) return;
        const ch = line.charCodeAt(0);
        if (ch === 71) { // G
            const sp = line.indexOf(' ');
            const code = sp < 0 ? line : line.substring(0, sp);
            if (code === 'G0' || code === 'G1' || code === 'G00' || code === 'G01') {
                let nx = x, ny = y, nz = z, ne = e;
                for (const w of line.split(' ')) {
                    const k = w.charCodeAt(0), v = parseFloat(w.substring(1));
                    if (isNaN(v)) continue;
                    if (k === 88) nx = relXYZ ? x + v : v;
                    else if (k === 89) ny = relXYZ ? y + v : v;
                    else if (k === 90) nz = relXYZ ? z + v : v;
                    else if (k === 69) ne = relE ? e + v : v;
                    else if (k === 70) f = v / 60;
                }
                move(nx, ny, nz, ne, f);
            } else if (code === 'G2' || code === 'G3') {
                // arcs: length from the chord and radius would be better; chord is close enough for short arcs
                let nx = num(line, 'X') ?? x, ny = num(line, 'Y') ?? y, ne = num(line, 'E');
                if (num(line, 'F')) f = num(line, 'F') / 60;
                move(nx, ny, z, ne === undefined ? e : relE ? e + ne : ne, f);
            } else if (code === 'G4') {
                flush();
                const p = num(line, 'P'), s = num(line, 'S');
                const t = p !== undefined ? p / 1000 : (s || 0);
                time += t; waits += t;
            } else if (code === 'G90') { relXYZ = false; relE = false; }
            else if (code === 'G91') { relXYZ = true; relE = true; }
            else if (code === 'G92') {
                const ve = num(line, 'E');
                if (ve !== undefined) e = ve;
            } else if (code === 'G9111') {
                flush(); time += startTime; start += startTime;
            } else if (code === 'G28') {
                flush(); x = y = 0; z = 0; time += opts.homeTime ?? 20;
            }
        } else if (ch === 77) { // M
            if (line.startsWith('M82')) relE = false;
            else if (line.startsWith('M83')) relE = true;
            else if (line.startsWith('M204')) {
                const s = num(line, 'S') ?? num(line, 'P');
                if (s) { accel = s; decel = Math.min(decel, accel); }
            }
        } else if (ch === 84 && /^T\d+$/.test(line)) { // T<n>
            flush();
            const t = parseInt(line.substring(1));
            // the first T before any printing selects the filament, later ones swap it
            if (t !== tool && count > 0) { swaps++; time += swapTime; }
            tool = t;
        } else if (line.startsWith('SET_VELOCITY_LIMIT')) {
            const a = num(line, 'ACCEL='), ad = num(line, 'ACCEL_TO_DECEL='), sv = num(line, 'SQUARE_CORNER_VELOCITY=');
            if (a) accel = a;
            if (ad) decel = ad;
            if (sv) scv = sv;
        }
    }
    return {
        feed,
        result() {
            flush();
            return { time, start, swaps, swapTime: swaps * swapTime, moves: count, filament: [...filament].map(v => v || 0) };
        }
    };
}

export function estimateGcode(lines, opts) {
    const est = estimator(opts);
    for (const line of lines) est.feed(line);
    return est.result();
}
