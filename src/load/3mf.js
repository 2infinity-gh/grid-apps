/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

'use strict';

import { THREE } from '../ext/three.js';
import { JSZip } from '../ext/jszip-esm.js';

let { BufferAttribute, Matrix4 } = THREE;

let scaleMap = {
    "inch": (1 / 25.4),
    "foot": (1 / 304.8),
    "micron": (1 / 1000),
    "meter": 1000,
    "millimeter": 1,
    "centimeter": (1 / 10)
};

export function query(node, path, fn) {
    let collect = {};
    let match = path[0].split('|').map(key => {
        if (key[0] === '+') {
            key = key.slice(1);
            collect[key] = true;
        }
        return key;
    });
    for (let child of [...node.childNodes]) {
        let { tagName } = child;
        if (match.indexOf(tagName) >= 0) {
            if (collect[tagName]) {
                fn(tagName, child);
            }
            if (path.length > 1) {
                query(child, path.slice(1), fn);
            }
        }
    }
}

function transform(def, mesh) {
    let pos = new BufferAttribute(mesh.toFloat32(), 3);
    let mat = def.split(' ').map(v => parseFloat(v));
    mat = [
        ...mat.slice(0,3), 0,
        ...mat.slice(3,6), 0,
        ...mat.slice(6,9), 0,
        ...mat.slice(9,12), 1
    ];
    pos.applyMatrix4(new Matrix4().fromArray(mat));
    return pos.array;
}

/** find matching attribute regardless of namespace */
function getLocalAttribute(node, name) {
    for (let attr of node.attributes) {
        if (attr.localName === name) {
            return attr.value;
        }
    }
    return undefined;
}

function loadModel(doc) {
    let items = [];
    let objects = {};

    return new Promise((resolve, reject) => {
        let scale = 1;
        query(doc, ["+model","resources","+object"], (type, node) => {
            switch (type) {
                case "model":
                    let units = node.getAttribute("unit");
                    if (units) {
                        scale = scaleMap[units] || 1;
                    }
                    query(node, ["build","+item"], (type, node) => {
                        items.push({
                            oid: node.getAttribute('objectid'),
                            xform: node.getAttribute('transform')
                        });
                    });
                    break;
                case "object":
                    let object = {
                        name: node.getAttribute("name")
                    };
                    objects[node.getAttribute("id")] = object;
                    // object are allowed one mest or one or more components
                    query(node, ["+mesh"], (type, node) => {
                        let vertices = [];
                        query(node, ["vertices","+vertex"], (type, vertex) => {
                            vertices.push([
                                parseFloat(vertex.getAttribute("x")) * scale,
                                parseFloat(vertex.getAttribute("y")) * scale,
                                parseFloat(vertex.getAttribute("z")) * scale
                            ]);
                        });
                        let mesh = object.mesh = [];
                        let paint = object.paint = [];
                        query(node, ["triangles","+triangle"], (type, triangle) => {
                            let v1 = parseInt(triangle.getAttribute("v1"));
                            let v2 = parseInt(triangle.getAttribute("v2"));
                            let v3 = parseInt(triangle.getAttribute("v3"));
                            mesh.appendAll(vertices[v1]);
                            mesh.appendAll(vertices[v2]);
                            mesh.appendAll(vertices[v3]);
                            // OrcaSlicer / PrusaSlicer multi-material painting
                            paint.push(triangle.getAttribute("paint_color")
                                || triangle.getAttribute("slic3rpe:mmu_segmentation") || null);
                        });
                    });
                    if (object.mesh) {
                        return;
                    } else {
                        object.components = [];
                    }
                    query(node, ["components","+component"], (type, node) => {
                        object.components.push({
                            oid: node.getAttribute('objectid'),
                            path: getLocalAttribute(node, "path"),
                            xform: node.getAttribute('transform'),
                        });
                    });
                    break;
            }
        });

        return resolve({ objects, items });

        // create object mesh from components
        for (let object of Object.values(objects)) {
            let { mesh, components } = object;
            if (mesh) {
                continue;
            }
            mesh = object.mesh = [];
            for (let component of components) {
                let { oid, xform } = component;
                let ref = objects[oid];
                if (!ref) {
                    console.log({ missing_ref: oid, objects, components, doc });
                } else if (xform) {
                    mesh.appendAll(transform(xform, ref.mesh));
                } else {
                    mesh.appendAll(ref.mesh);
                }
            }
        }

        // create export items from object references
        for (let item of items) {
            let { oid, xform } = item;
            let { name, mesh } = objects[oid];
            item.name = name;
            if (xform) {
                item.faces = transform(xform, mesh);
            } else {
                item.faces = mesh;
            }
        }

        // return array: [{ name, faces }, { name, faces }]
        resolve(items);
    });
}

function extractItems(records) {
    let outItems = [];
    let models = Object.values(records);

    // create object mesh from components
    for (let model of models) {
        let { objects } = model;
        for (let object of Object.values(objects)) {
            let { mesh, components } = object;
            if (mesh) {
                continue;
            }
            mesh = object.mesh = [];
            object.paint = [];
            object.parts = [];
            for (let component of components) {
                let { oid, path, xform } = component;
                let omap = objects;
                if (path) {
                    omap = records[path.substring(1)].objects;
                    // console.log({ component_from_ob_path: path, using: omap });
                }
                let ref = omap[oid];
                if (!ref) {
                    console.log({ missing_ref: oid, objects, components });
                    continue;
                }
                let start = mesh.length / 9;
                if (xform) {
                    mesh.appendAll(transform(xform, ref.mesh));
                } else {
                    mesh.appendAll(ref.mesh);
                }
                object.paint.appendAll(ref.paint || new Array(ref.mesh.length / 9).fill(null));
                object.parts.push({ id: oid, start, end: mesh.length / 9 });
            }
        }
    }

    // create export items from object references
    for (let model of models) {
        let { items, objects } = model;
        for (let item of items || []) {
            let { oid, xform } = item;
            let { name, mesh, paint, parts } = objects[oid];
            item.name = name;
            item.paint = paint;
            item.parts = parts;
            if (xform) {
                item.faces = transform(xform, mesh);
            } else {
                item.faces = mesh;
            }
        }
        outItems.push(...items);
    }

    return outItems;
}

/**
 * Export vertex array(s) to 3MF format
 * @param {Array} recs - array of {file: string, varr: Float32Array} records
 * @param {Object} options - encoding options
 * @param {String} [options.unit='millimeter'] - unit of measurement
 * @param {String} [options.title='Model'] - model title
 * @returns {Promise<Blob>} 3MF file as a Blob
 */
export async function encode(recs, options = {}) {
    const {
        unit = 'millimeter',
        title = 'Model'
    } = options;

    // Build the 3D model XML
    let objectId = 1;
    let resources = [];
    let buildItems = [];

    for (let rec of recs) {
        let { file, varr } = rec;
        let name = file || `object-${objectId}`;

        // Extract unique vertices and build triangle indices
        let vertices = [];
        let triangles = [];
        let vertexMap = new Map(); // map "x,y,z" -> vertex index
        let vertexIndex = 0;

        // Process triangles (every 9 floats = 3 vertices = 1 triangle)
        for (let i = 0; i < varr.length; i += 9) {
            let triIndices = [];

            // Process 3 vertices per triangle
            for (let j = 0; j < 3; j++) {
                let vi = i + j * 3;
                let x = varr[vi];
                let y = varr[vi + 1];
                let z = varr[vi + 2];

                // Create vertex key for deduplication
                let key = `${x},${y},${z}`;
                let idx = vertexMap.get(key);

                if (idx === undefined) {
                    idx = vertexIndex++;
                    vertexMap.set(key, idx);
                    vertices.push({ x, y, z });
                }

                triIndices.push(idx);
            }

            triangles.push(triIndices);
        }

        // Generate object XML
        let objectXml = [`    <object id="${objectId}" name="${name}" type="model">`];
        objectXml.push('      <mesh>');
        objectXml.push('        <vertices>');

        for (let v of vertices) {
            objectXml.push(`          <vertex x="${v.x}" y="${v.y}" z="${v.z}"/>`);
        }

        objectXml.push('        </vertices>');
        objectXml.push('        <triangles>');

        for (let tri of triangles) {
            objectXml.push(`          <triangle v1="${tri[0]}" v2="${tri[1]}" v3="${tri[2]}"/>`);
        }

        objectXml.push('        </triangles>');
        objectXml.push('      </mesh>');
        objectXml.push('    </object>');

        resources.push(objectXml.join('\n'));
        buildItems.push(`    <item objectid="${objectId}"/>`);

        objectId++;
    }

    // Construct the complete 3D model XML
    let modelXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
        '  <resources>',
        resources.join('\n'),
        '  </resources>',
        '  <build>',
        buildItems.join('\n'),
        '  </build>',
        '</model>'
    ].join('\n');

    // Create [Content_Types].xml
    let contentTypes = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
        '</Types>'
    ].join('\n');

    // Create _rels/.rels
    let rels = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
        '</Relationships>'
    ].join('\n');

    // Create ZIP archive
    let zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rels);
    zip.file('3D/3dmodel.model', modelXml);

    // Generate the 3MF file as a blob
    return await zip.generateAsync({
        type: "uint8array",
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        streamFiles: true
    });
}

/**
 * @param {Object} data binary file
 * @returns {Array} vertex face array
 */
export function parseAsync(data) {
    return new Promise(async (resolve, reject) => {
        let zip = await new JSZip().loadAsync(data);
        let models = {};
        let config;
        for (let [key, value] of Object.entries(zip.files)) {
            if (key.endsWith(".model")) {
                let xml = await value.async("string");
                let { objects, items } = await loadModel(new DOMParser().parseFromString(xml, "text/xml"));
                models[key] = { objects, items };
            } else if (key.endsWith("model_settings.config")) {
                config = readSlicerConfig(new DOMParser().parseFromString(await value.async("string"), "text/xml"));
            }
        }
        resolve(colourItems(extractItems(models), config));
    });
}

/**
 * OrcaSlicer / Bambu Studio project settings: filament (extruder, 1-based)
 * per object and per part. Returns { objectId: { extruder, parts: { partId: extruder } } }
 */
function readSlicerConfig(doc) {
    let out = {};
    let meta = (node, key) => {
        for (let child of [...node.childNodes]) {
            if (child.tagName === 'metadata' && child.getAttribute('key') === key) {
                return parseInt(child.getAttribute('value')) || undefined;
            }
        }
    };
    for (let object of [...doc.getElementsByTagName('object')]) {
        let rec = out[object.getAttribute('id')] = { extruder: meta(object, 'extruder'), parts: {} };
        for (let part of [...object.getElementsByTagName('part')]) {
            rec.parts[part.getAttribute('id')] = meta(part, 'extruder');
        }
    }
    return out;
}

/**
 * Attach colour info to items: { extruder } (1-based filament) and
 * { paint: [ { state, tri: [9 floats] } ] } for painted (sub)triangles.
 * Objects whose parts use different filaments are split into one item per
 * part, flagged { part: true } so they load as a group.
 */
function colourItems(items, config = {}) {
    let out = [];
    for (let item of items) {
        let cfg = config[item.oid] || {};
        let parts = (item.parts || []).map(part => ({ ...part, extruder: cfg.parts?.[part.id] || cfg.extruder }));
        let split = parts.length > 1 && new Set(parts.map(p => p.extruder || 0)).size > 1;
        let ranges = split ? parts : [ { start: 0, end: item.faces.length / 9, extruder: cfg.extruder || parts[0]?.extruder } ];
        for (let range of ranges) {
            let faces = item.faces.slice(range.start * 9, range.end * 9);
            let paint = [];
            for (let t = range.start; t < range.end; t++) {
                let code = item.paint?.[t];
                if (code) paint.appendAll(decodePaint(code, item.faces.slice(t * 9, t * 9 + 9)));
            }
            out.push({
                name: item.name,
                faces,
                extruder: range.extruder,
                paint: paint.length ? paint : undefined,
                part: split
            });
        }
    }
    return out;
}

/**
 * Decode one triangle's paint string (OrcaSlicer TriangleSelector serialization)
 * into painted leaf triangles. The hex string is read from the end, one nibble
 * per character: bits 0-1 = split sides (0 = leaf), bits 2-3 = leaf state or
 * special side; leaf state 3+ continues in the next nibble. Children of a split
 * are stored last child first.
 */
export function decodePaint(code, tri) {
    let nibbles = [...code].reverse().map(ch => parseInt(ch, 16));
    let pos = 0;
    let next = () => {
        if (pos >= nibbles.length) throw new Error('paint data too short');
        return nibbles[pos++];
    };
    let mid = (a, b) => [ (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 ];
    let out = [];
    let walk = (verts) => {
        let n = next();
        let sides = n & 0b11;
        if (sides === 0) {
            let state = (n & 0b1100) === 0b1100 ? (v => v === 0b1111 ? next() + 18 : v + 3)(next()) : n >> 2;
            if (state > 0) out.push({ state, tri: verts.flat() });
            return;
        }
        let special = sides === 3 ? 0 : n >> 2;
        // rotate so the special side comes first, as TriangleSelector::perform_split
        let v = [0, 1, 2].map(j => verts[(special + j) % 3]);
        let children;
        if (sides === 1) {
            let m = mid(v[2], v[1]);
            children = [ [v[0], v[1], m], [m, v[2], v[0]] ];
        } else if (sides === 2) {
            let m1 = mid(v[1], v[0]);
            let m2 = mid(v[0], v[2]);
            children = [ [v[0], m1, m2], [m1, v[1], m2], [v[1], v[2], m2] ];
        } else {
            let m01 = mid(v[1], v[0]);
            let m12 = mid(v[2], v[1]);
            let m20 = mid(v[0], v[2]);
            children = [ [v[0], m01, m20], [m01, v[1], m12], [m12, v[2], m20], [m01, m12, m20] ];
        }
        for (let i = children.length - 1; i >= 0; i--) {
            walk(children[i]);
        }
    };
    try {
        // plain arrays: faces may be a Float32Array, which flat() would not unpack
        walk([ Array.from(tri.slice(0, 3)), Array.from(tri.slice(3, 6)), Array.from(tri.slice(6, 9)) ]);
    } catch (e) {
        return [];
    }
    return out;
}

