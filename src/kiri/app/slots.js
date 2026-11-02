/** Filament slots of the attached printer (kx-bridge /kx/filament/slots, proxied on /printer-api) */

const SLOTS_URL = '/printer-api/kx/filament/slots';
const SELECTED_TINT = 0xbbff00;

let slots = [];
let listeners = [];

// fetch the printer's slot colours/materials; silently does nothing when
// no kx-bridge is reachable (e.g. local development)
export function loadSlots() {
    return fetch(SLOTS_URL, { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null)
        .then(json => {
            if (!Array.isArray(json?.result)) return;
            slots = json.result.map(s => ({
                color: parseInt((s.color_hex || '').replace('#', ''), 16),
                material: s.material || '',
                name: s.filament_name || '',
                loaded: s.status === 'loaded'
            }));
            listeners.forEach(fn => fn(slots));
        })
        .catch(() => {});
}

export function onSlots(fn) {
    listeners.push(fn);
}

export function slotInfo(index) {
    return slots[index];
}

// "Slot 2 · PLA+" or the plain extruder name when slots are unknown
export function slotLabel(index) {
    const slot = slots[index];
    return slot ? `slot ${index + 1} · ${slot.material || '?'}` : `extruder ${index}`;
}

// filament colour for a slot, tinted when the widget is selected
export function slotColor(index, selected, avgc) {
    const slot = slots[index];
    if (!slot || isNaN(slot.color)) return undefined;
    return selected ? avgc(slot.color, SELECTED_TINT, 2) : slot.color;
}

export function isSelectedScheme(colors) {
    return colors[0] === SELECTED_TINT;
}
