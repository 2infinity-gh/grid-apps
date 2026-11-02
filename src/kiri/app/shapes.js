/** Basic shapes (box, cylinder, cone, sphere) added straight onto the platform */

import { THREE } from '../../ext/three.js';
import { api } from './api.js';

const SHAPES = {
    box: {
        ask: 'Box size X,Y,Z (mm)',
        def: '20,20,20',
        make([x, y, z]) {
            return new THREE.BoxGeometry(x, y || x, z || y || x);
        }
    },
    cylinder: {
        ask: 'Cylinder diameter,height (mm)',
        def: '20,20',
        make([d, h]) {
            return upright(new THREE.CylinderGeometry(d / 2, d / 2, h || d, facets(d)));
        }
    },
    cone: {
        ask: 'Cone bottom diameter,top diameter,height (mm)',
        def: '20,0,20',
        make([d1, d2, h]) {
            return upright(new THREE.CylinderGeometry((d2 || 0) / 2, d1 / 2, h || d1, facets(d1)));
        }
    },
    sphere: {
        ask: 'Sphere diameter (mm)',
        def: '20',
        make([d]) {
            return new THREE.SphereGeometry(d / 2, facets(d), Math.ceil(facets(d) / 2));
        }
    }
};

// enough facets for a smooth wall without bloating small shapes
function facets(diameter) {
    return Math.max(24, Math.min(180, Math.round(diameter * 3)));
}

// THREE builds round shapes along Y; the platform is Z-up
function upright(geo) {
    return geo.rotateX(Math.PI / 2);
}

export function addShape(type) {
    const shape = SHAPES[type];
    if (!shape) return;
    api.uc.prompt(shape.ask, shape.def).then(answer => {
        if (!answer) return;
        // keep zeros (a cone's top diameter may be 0), drop empty/garbage entries
        const dims = answer.split(',').map(v => parseFloat(v)).filter(v => v >= 0);
        if (!(dims[0] > 0)) return api.show.alert(`invalid size "${answer}"`, 3);
        const geo = shape.make(dims).toNonIndexed();
        const name = `${type} ${dims.join('x')}`;
        api.platform.load_verts(undefined, Array.from(geo.attributes.position.array), name);
        geo.dispose();
    });
}

export const shapes = { add: addShape, types: Object.keys(SHAPES) };
