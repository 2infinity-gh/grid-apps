/**
 * Adaptive pressure advance, as OrcaSlicer / Anycubic Slicer Next do it
 * (AdaptivePAInterpolator + PchipInterpolatorHelper).
 *
 * The model is one "PA,flow,acceleration" line per measurement (flow in
 * mm³/s). Lines are grouped by acceleration; a group needs two or more
 * flows. PA is interpolated over flow within each group (PCHIP, clamped
 * outside the measured range), then over acceleration between the groups.
 */

// monotone cubic (PCHIP) through sorted x / y, clamped at both ends
function pchip(xs, ys) {
    const pts = xs.map((x, i) => [ x, ys[i] ]).sort((a, b) => a[0] - b[0]);
    // the same x twice would divide by zero: average the duplicates
    const x = [], y = [], cnt = [];
    for (const [px, py] of pts) {
        const n = x.length - 1;
        if (n >= 0 && px === x[n]) { y[n] = (y[n] * cnt[n] + py) / (cnt[n] + 1); cnt[n]++; }
        else { x.push(px); y.push(py); cnt.push(1); }
    }
    if (x.length < 2) {
        const v = y[0];
        return () => v;
    }
    const n = x.length - 1, h = [], delta = [], d = [];
    for (let i = 0; i < n; i++) {
        h[i] = x[i + 1] - x[i];
        delta[i] = (y[i + 1] - y[i]) / h[i];
    }
    d[0] = delta[0];
    d[n] = delta[n - 1];
    for (let i = 1; i < n; i++) {
        if (delta[i - 1] * delta[i] > 0) {
            const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
            d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
        } else {
            d[i] = 0;
        }
    }
    return xi => {
        if (xi <= x[0]) return y[0];
        if (xi >= x[n]) return y[n];
        let i = 0;
        while (x[i + 1] < xi) i++;
        const t = (xi - x[i]) / h[i], t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h[i] * d[i]
            + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h[i] * d[i + 1];
    };
}

/**
 * Parse a model the way Orca does (the first three comma separated values
 * of each line; a typo like "0,02,4.54,2000" is read as PA 0, flow 2,
 * acceleration 4.54, exactly as Orca would). Returns pa(flow, accel), which
 * gives -1 when the model has no usable group, or null for an empty model.
 */
export function paModel(text) {
    if (!text || typeof text !== 'string') return null;
    const groups = new Map();
    for (const line of text.replace(/\\n/g, '\n').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [ pa, flow, accel ] = line.split(',').map(v => parseFloat(v) || 0);
        if (!groups.has(accel)) groups.set(accel, []);
        groups.get(accel).push([ flow, pa ]);
    }
    const curves = [ ...groups.entries() ]
        .filter(([, pts]) => pts.length > 1)
        .sort((a, b) => a[0] - b[0])
        .map(([accel, pts]) => [ accel, pchip(pts.map(p => p[0]), pts.map(p => p[1])) ]);
    if (!curves.length) return null;
    return (flow, accel) => {
        const accs = curves.map(c => c[0]);
        const pas = curves.map(c => c[1](flow));
        const v = pas.length === 1 ? pas[0] : pchip(accs, pas)(accel);
        return Math.round(v * 1000) / 1000;
    };
}
