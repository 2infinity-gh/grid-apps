/**
 * Save buttons under the Profile selector. Editing a setting changes only the
 * working copy (settings.process); the named profile is updated when the user
 * saves it, or stored under a new name with "save as". Revert drops the edits.
 */

import { api } from './api.js';

let row, label, saveBtn, revertBtn;

function current() {
    const set = api.conf.get();
    const name = set.process?.processName;
    return { set, name, saved: set.sproc?.[set.mode]?.[name] };
}

// does the working copy differ from the stored profile?
export function modified() {
    const { set, name, saved } = current();
    if (!saved || name === 'default') return false;
    const keys = new Set([ ...Object.keys(saved), ...Object.keys(set.process) ]);
    keys.delete('processName');
    for (const key of keys) {
        const a = saved[key], b = set.process[key];
        // empty fields come back as null
        if ((a === '' || a == null) && (b === '' || b == null)) continue;
        if (typeof a === 'object' || typeof b === 'object') {
            if (JSON.stringify(a) !== JSON.stringify(b)) return true;
        } else if (a != b) {
            return true;
        }
    }
    return false;
}

// keep the selector's list and choice in step with the stored profiles
function syncSelector() {
    const { set, name } = current();
    const select = api.ui.modeProfile;
    const names = Object.keys(set.sproc?.[set.mode] || {});
    if ([...select.options].map(o => o.value).join('\n') !== names.join('\n')) {
        select.innerHTML = '';
        for (const n of names) select.appendChild(new Option(n, n));
    }
    if (name && select.value !== name) select.value = name;
}

function refresh() {
    if (!row) return;
    syncSelector();
    const { name } = current();
    const dirty = modified();
    label.textContent = dirty ? `• unsaved changes to "${name}"` : '';
    saveBtn.disabled = revertBtn.disabled = !dirty;
    saveBtn.style.opacity = revertBtn.style.opacity = dirty ? '1' : '.45';
    saveBtn.style.background = dirty ? '#3b82f6' : '#f6f6f6';
    saveBtn.style.color = dirty ? '#fff' : '#222';
}

function save() {
    const { set, name } = current();
    if (!name || name === 'default') return saveAs();
    set.sproc[set.mode][name] = JSON.parse(JSON.stringify(set.process));
    api.conf.save();
    api.show.alert(`saved profile "${name}"`, 2);
    refresh();
}

function saveAs() {
    const { name } = current();
    api.uc.prompt('Save profile as', name && name !== 'default' ? `${name} (copy)` : 'my profile').then(newName => {
        newName = (newName || '').trim();
        if (!newName) return;
        const { set } = current();
        const store = () => {
            set.process.processName = newName;
            set.sproc[set.mode][newName] = JSON.parse(JSON.stringify(set.process));
            set.cproc[set.mode] = newName;
            set.devproc[set.device.deviceName] = newName;
            api.conf.save();
            api.conf.update();
            api.event.settings();
            api.show.alert(`saved as new profile "${newName}"`, 2);
            refresh();
        };
        if (set.sproc[set.mode][newName] && newName !== name) {
            api.uc.confirm(`Replace profile "${newName}"?`).then(yes => yes && store());
        } else {
            store();
        }
    });
}

function revert() {
    const { name } = current();
    api.uc.confirm(`Discard the unsaved changes to "${name}"?`).then(yes => {
        if (yes) api.conf.load(undefined, name, true);
        refresh();
    });
}

// switching profile from the selector: ask first when there are unsaved edits
export function confirmSwitch(selector) {
    const { name } = current();
    if (!modified()) return Promise.resolve(true);
    return api.uc.confirm(`"${name}" has unsaved changes. Switch profile and discard them?`).then(yes => {
        if (!yes) selector.value = name;
        return yes;
    });
}

export function initProcessSave() {
    const select = api.ui.modeProfile;
    const anchor = select?.closest('.var-row') || select?.parentElement;
    if (!anchor) return;
    const button = (text, title, onclick) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'display:inline-block;padding:2px 8px;border:1px solid #bbb;border-radius:4px;background:#f6f6f6;color:#222;cursor:pointer;font:12px sans-serif;text-transform:none';
        b.onclick = ev => { ev.stopPropagation(); onclick(); };
        return b;
    };
    row = document.createElement('div');
    row.id = 'process-save';
    row.style.cssText = 'display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px;padding:3px 6px;box-sizing:border-box;width:100%';
    saveBtn = button('save', 'save the changes into this profile', save);
    revertBtn = button('revert', 'discard the unsaved changes', revert);
    const asBtn = button('save as…', 'store the current settings as a new profile', saveAs);
    label = document.createElement('span');
    label.style.cssText = 'display:block;flex-basis:100%;color:#c77700;font:11px sans-serif;text-transform:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    row.append(saveBtn, asBtn, revertBtn, label);
    anchor.after(row);
    for (const ev of [ 'settings.saved', 'settings.load', 'settings' ]) api.event.on(ev, refresh);
    refresh();
}

export const processSave = { init: initProcessSave, modified, confirmSwitch };
