/** Tell the surroundings that G-code went to the printer (kx-bridge) */

import { api } from './api.js';

// inside the skoren.nl portal the parent page switches to its printer tab
const PORTAL = 'https://skoren.nl';

export function printerSent(files, print) {
    api.event.emit('printer.sent', { files, print });
    if (window.parent !== window) {
        window.parent.postMessage({ type: 'kiri:sent', files, print: !!print }, PORTAL);
    } else {
        api.show.alert(`${print ? 'printing' : 'sent to the printer'}: ${files.join(', ')}`, 5);
    }
}
