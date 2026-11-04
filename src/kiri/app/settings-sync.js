/**
 * Keeps Kiri's settings (devices, process and filament profiles) on the
 * server per logged-in user (kiri-sync behind the skoren.nl login), so every
 * device and browser shares them. localStorage stays the working copy:
 *
 * - at start: when the server has a newer version than this browser last
 *   synced, take it and reload; when there is none yet, upload ours
 * - after every settings save: upload (debounced), unless only the camera moved
 * - back on the tab: offer to reload when another device saved meanwhile
 *
 * Without the endpoint (a plain Kiri install) this does nothing.
 */

import { api } from './api.js';
import { local } from '../../data/local.js';

const URL = '/kiri-sync/settings';
const STAMP = 'kiri-sync-stamp';   // server version this browser has
const DIRTY = 'kiri-sync-dirty';   // local changes not uploaded yet

let ready = false;       // initial sync done
let early = false;       // saved while the initial sync was running
let lastText;            // what we last uploaded (or took), without the camera view
let timer;

// the settings as synced: the camera position is per device
function syncText(settings) {
    const { view, ...controller } = settings.controller || {};
    return JSON.stringify({ ...settings, controller });
}

async function fetchServer() {
    const res = await fetch(URL, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
    if (res.status === 404) return { none: true };
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error(`sync ${res.status}`);
    return res.json();
}

async function upload() {
    const settings = api.conf.get();
    const text = syncText(settings);
    if (text === lastText) { local.removeItem(DIRTY); return; }
    const res = await fetch(URL, {
        method: 'PUT', credentials: 'same-origin', redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: `{"settings":${text}}`
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);
    const { stamp } = await res.json();
    lastText = text;
    local.setItem(STAMP, String(stamp));
    local.removeItem(DIRTY);
}

function scheduleUpload() {
    clearTimeout(timer);
    timer = setTimeout(() => upload().catch(e => console.log('settings sync: upload failed', e.message)), 2000);
}

// replace this browser's settings with the server's (keeping our camera view) and restart
function adopt(server) {
    const mine = api.conf.get();
    const theirs = server.settings;
    theirs.controller = { ...(theirs.controller || {}), view: mine.controller?.view };
    const text = JSON.stringify(theirs);
    const write = () => {
        local.setItem('ws-settings', text);
        local.setItem(STAMP, String(server.stamp));
        local.removeItem(DIRTY);
    };
    write();
    // Kiri may still save its old settings before the page is gone: write ours last
    window.addEventListener('pagehide', write);
    location.reload();
}

function onSaved(settings) {
    if (!ready) { early = true; return; }
    if (syncText(settings) === lastText) return;
    local.setItem(DIRTY, '1');
    scheduleUpload();
}

async function start() {
    api.event.on('settings.saved', onSaved);
    let server;
    try {
        server = await fetchServer();
    } catch (e) {
        console.log('settings sync: not available', e.message);
        return;
    }
    const have = parseInt(local.getItem(STAMP)) || 0;
    const dirty = !!local.getItem(DIRTY);
    if (server.none) {
        // first device: this browser's settings become the shared ones
        await upload().catch(e => console.log('settings sync: upload failed', e.message));
    } else if (server.stamp > have && !dirty) {
        return adopt(server);
    } else if (dirty) {
        // changed here while the upload failed (offline): ours are the latest
        await upload().catch(e => console.log('settings sync: upload failed', e.message));
    } else {
        lastText = syncText(server.settings);
    }
    ready = true;
    // a change made while we were still talking to the server
    if (early) onSaved(api.conf.get());
    document.addEventListener('visibilitychange', checkNewer);
}

// another device saved while this tab was in the background
let asking = false;
async function checkNewer() {
    if (document.visibilityState !== 'visible' || asking || local.getItem(DIRTY)) return;
    let server;
    try { server = await fetchServer(); } catch { return; }
    if (server.none || server.stamp <= (parseInt(local.getItem(STAMP)) || 0)) return;
    asking = true;
    const yes = await api.uc.confirm('Profiles were changed on another device. Load them now?');
    asking = false;
    if (yes) adopt(server);
    // not now: ask again next time; our next save overwrites theirs
}

export const settingsSync = { start, ready: () => ready, upload };
