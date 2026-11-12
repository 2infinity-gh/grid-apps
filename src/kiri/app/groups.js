/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { api } from './api.js';
import { selection } from './selected.js';
import { Widget } from './widget.js';

// after a change in grouping: refresh boxes, list, selection colours, save
function regrouped(widgets) {
    for (const w of widgets) {
        w.moveMesh(0, 0, 0);    // recompute track.box from the (new) group bounds
        w.setModified('group');
        w.saveState();
    }
    api.platform.changed();
    api.platform.update_bounds();
    api.space.auto_save();
    api.space.update?.();
}

/**
 * Merge selected widgets into a group.
 * Grouped widgets move together as a unit.
 */
function groupMerge() {
    const widgets = selection.widgets(false);
    if (widgets.map(w => w.group).uniq().length < 2) return false;
    Widget.Groups.merge(widgets);
    const all = widgets[0].group.slice();
    regrouped(all);
    api.platform.deselect();
    api.platform.select(all[0]);    // selects the whole group
    api.event.emit('group.merge', all);
    return true;
}

/**
 * Split grouped widgets back into individual widgets, each with its own
 * position at the centre of its own footprint (members of a group all share
 * the group's position, with their geometry offset from it).
 */
function groupSplit() {
    const widgets = selection.widgets(false);
    const groups = widgets.map(w => w.group).uniq().filter(g => g.length > 1);
    if (!groups.length) return false;
    const parts = groups.flat();
    Widget.Groups.split(parts);
    for (const w of parts) {
        const bb = w.mesh.getBoundingBox(true);
        const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
        const p = w.track.pos;
        w.moveMesh(cx, cy, 0);
        w._move(p.x + cx, p.y + cy, p.z, true);
    }
    regrouped(parts);
    api.platform.deselect();
    parts.forEach(w => api.platform.select(w, true, false));
    api.event.emit('group.split', parts);
    return true;
}

/**
 * Selection state for a group toggle: 'split' when the selection holds a
 * group, 'merge' when it holds two or more separate objects, else null.
 */
function groupState() {
    const widgets = selection.widgets(false);
    if (widgets.some(w => w.group.length > 1)) return 'split';
    if (widgets.map(w => w.group).uniq().length > 1) return 'merge';
    return null;
}

export const group = {
    merge: groupMerge,
    split: groupSplit,
    state: groupState,
};
