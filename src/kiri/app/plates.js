/** Build plates from multi-plate OrcaSlicer / Bambu Studio projects */

// ask which plate of a project to load: resolves a plate id, 'all', or null (cancelled)
export function choosePlate(plates, file) {
    return new Promise(resolve => {
        const el = (tag, css, text) => {
            const e = document.createElement(tag);
            e.style.cssText = css || '';
            if (text !== undefined) e.textContent = text;
            return e;
        };
        const wrap = el('div', 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center');
        wrap.id = 'plate-dialog';
        const box = el('div', 'display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:min(380px,94vw);background:#fff;color:#222;border-radius:10px;padding:16px 18px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)');
        wrap.appendChild(box);
        box.appendChild(el('div', 'display:block;font-weight:bold;font-size:16px', 'Which plate?'));
        box.appendChild(el('div', 'display:block;color:#666;font-size:12px;margin-bottom:4px', `${file || 'This project'} has ${plates.length} plates.`));
        const done = value => { wrap.remove(); resolve(value); };
        const button = (text, value, primary) => {
            const b = el('button', `display:block;width:100%;text-align:left;padding:8px 12px;border-radius:6px;border:1px solid ${primary ? '#3b82f6' : '#ccc'};background:${primary ? '#eff6ff' : '#f7f7f7'};color:#222;cursor:pointer;font:14px sans-serif`, text);
            b.onclick = () => done(value);
            box.appendChild(b);
        };
        for (const p of plates) {
            button(`Plate ${p.id}${p.name ? ' · ' + p.name : ''} — ${p.count} object${p.count === 1 ? '' : 's'}`, p.id, true);
        }
        button('All plates together', 'all');
        button('Cancel', null);
        wrap.onclick = ev => { if (ev.target === wrap) done(null) };
        document.body.appendChild(wrap);
    });
}
