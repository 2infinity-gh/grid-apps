/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { FDM } from './init-work.js';
import { base, util } from '../../../../geo/base.js';
import { poly2polyEmit, tip2tipEmit } from '../../../../geo/paths.js';
import { newBounds } from '../../../../geo/bounds.js';
import { newPoint, Point } from '../../../../geo/point.js';
import { newPolygon, Polygon } from '../../../../geo/polygon.js';
import { polygons as POLY, fillArea } from '../../../../geo/polygons.js';
import { newPrint } from '../../../core/print.js';
import { newSlice } from '../../../core/slice.js';
import { newWidget } from '../../../core/widget.js';
import { render } from '../../../core/render.js';
import { getRangeParameters } from '../core/params.js';

const { numOrDefault } = util;

/**
 * DRIVER PRINT CONTRACT
 *
 * @param {Function} update progress callback
 * @returns {Object[]} returns array of render objects
 */
export async function fdm_prepare(widgets, settings, update) {
    // filter ignored widgets
    widgets = widgets.filter(w => !w.track.ignore && !w.meta.disabled);

    let { device, process, controller, bounds } = settings,
        { sliceHeight, firstSliceHeight, firstLayerRate, sliceSupportNozzle } = process,
        { outputSeekrate, outputDraftShield, outputPurgeTower } = process,
        { bedWidth, bedDepth } = device,
        { lineType } = controller,
        printPoint = newPoint(0,0,0),
        print = self.kiri_worker.current.print = newPrint(settings, widgets),
        nozzle = process.sliceLineWidth || device.extruders[0].extNozzle,
        isBelt = device.bedBelt,
        isThin = lineType === "line",
        isFlat = lineType === "flat",
        useRaft = process.outputRaft || false,
        firstLayerHeight = isBelt ? sliceHeight : firstSliceHeight || sliceHeight,
        layerno = 0,
        zneg = 0,
        zoff = 0,
        zmin = 0,
        zmax = 0,
        shield,
        output = [],
        layerout = [];

    // wait for safe eval setup
    await print.ready();

    // compute bounds if missing
    if (!bounds) {
        bounds = new THREE.Box3();
        for (let widget of widgets) {
            let wp = widget.track.pos;
            let wb = widget.bounds.clone();
            wb.min.x += wp.x;
            wb.max.x += wp.x;
            wb.min.y += wp.y;
            wb.max.y += wp.y;
            bounds.union(wb);
        }
        settings.bounds = bounds;
    }

    // brim, skirt and raft print with the filament of the lowest part, so
    // they need no swap (and are not some other slot's material)
    const baseWidget = widgets.filter(w => w.slices?.length).sort((a, b) => a.slices[0].z - b.slices[0].z)[0];
    const baseTool = baseWidget?.anno?.extruder ?? 0;
    let baseOut = false;
    // tree / organic supports stand on thin trunks: like Orca they get a brim
    // of their own (sliceSupportBrim mm), around the part's and the supports'
    // first layer together so it never runs into the part (not with a raft)
    let supportBrim = null;
    const supportBrimWidth = process.sliceSupportBrim ?? 3;
    if (!isBelt && !useRaft && supportBrimWidth > 0 && [ 'tree', 'organic' ].includes(process.sliceSupportType)) {
        let base = [], has = false;
        for (let widget of widgets.filter(w => w.slices?.length)) {
            let first = widget.slices[0];
            for (let top of first.tops || []) base.push(top.poly.clone().move(widget.track.pos));
            for (let poly of first.supports || []) { base.push(poly.clone().move(widget.track.pos)); has = true; }
        }
        if (has) supportBrim = { base: POLY.union(base, 0, true), count: Math.max(1, Math.round(supportBrimWidth / nozzle)) };
    }
    // create brim, skirt, raft if specificed in FDM mode (code shared by laser)
    if (!isBelt && (process.outputBrimCount || useRaft || supportBrim)) {
        baseOut = true;
        let brims = [],
            offset = process.outputBrimOffset || (useRaft ? 4 : 0);

        // compute first brim
        widgets.filter(w => w.slices.length).forEach(function(widget) {
            let tops = [];
            let slices = [];
            if (outputDraftShield) {
                slices.appendAll(widget.slices);
            } else {
                slices.push(widget.slices[0]);
            }
            let withSupports = false;
            for (let slice of slices) {
                // collect top outer polygons
                if (slice.tops)
                slice.tops.forEach(function(top) {
                    tops.push(top.poly.clone());
                });
                // a raft goes under the supports too: they start on the
                // part's first layer, which is raised above the bed by the raft
                if (useRaft && slice.supports?.length) {
                    slice.supports.forEach(poly => tops.push(poly.clone()));
                    withSupports = true;
                }
            }
            if (outputDraftShield || withSupports) {
                tops = POLY.union(tops,1,true);
            }
            // nest and offset tops
            POLY.nest(tops).forEach((poly) => {
                let off = poly.offset(-offset + nozzle / 2);
                if (off) off.forEach(function(brim) {
                    brim.move(widget.track.pos);
                    brims.push(brim);
                });
            });
        });

        // merge brims
        brims = POLY.union(brims, undefined, true);

        // if brim is offset, over-expand then shrink to induce brims to merge
        if (brims.length > 1 && offset >= nozzle) {
            let extra = process.sliceSupportExtra + 2;
            let zheight = brims[0].getZ();
            brims = POLY.expand(brims, extra, zheight, null, 1);
            brims = POLY.expand(brims, -extra, zheight, null, 1);
        }

        // create raft when specified
        if (useRaft) {
            let offset = newPoint(0,0,0),
                height = nozzle,
                angle = process.sliceFillAngle,
                rate1 = firstLayerRate / 3,
                rate2 = process.outputFeedrate,
                rafts = process.outputBrimCount ?
                    POLY.expand(brims, nozzle * 4, 0, null, 1) : brims;

            function raft(height, angle, spacing, speed, extrude, outline) {
                let slice = newSlice(zoff + height / 2);
                slice.extruder = baseTool;
                for (let brim of rafts) {
                    // use first point of first brim as start point
                    if (printPoint === null) printPoint = brim.first();
                    let t = slice.addTop(brim);
                    if (outline) t.traces = [ brim ];
                    t.inner = POLY.expand([ brim ], nozzle * -0.8, 0, null, 1);
                    t.fill_lines = fillArea(t.inner, angle, spacing, []);
                    t.isRaft = true;
                }
                offset.z = slice.z;
                printPoint = slicePrintPath(print, slice, printPoint, offset, layerout, {
                    speed,
                    mult: extrude,
                });
                layerout.z = zoff + height;
                layerout.height = height;
                layerout.print_time = printPoint.layer_time;
                output.append(layerout);

                layerout = [];
                zoff += height;
                zneg = height / 2;
            };

            // cause first point of raft to be used
            printPoint = null;

            // emit raft layers
            raft(nozzle * 1.5, angle +  0, nozzle * 6.00, rate1, 2.50, true);
            raft(nozzle * 0.5, angle + 90, nozzle * 2.00, rate2, 1.50, true);
            raft(nozzle * 0.5, angle +  0, nozzle * 1.00, rate2, 1.00);
            raft(nozzle * 0.5, angle + 90, nozzle * 0.75, rate2, 0.75);

            // raise first layer off raft slightly to lessen adhesion
            firstLayerHeight += process.outputRaftSpacing || 0;
            zoff += process.outputRaftSpacing || 0;

            // retract after last raft layer
            output.last().last().retract = true;
        }

        // support brim: loops around the first layer of parts and supports
        if (supportBrim) {
            let polys = [], preout = [];
            POLY.offset(supportBrim.base, nozzle, {
                outs: polys,
                flat: true,
                count: supportBrim.count,
                z: firstLayerHeight / 2 + zoff - zneg
            });
            print.setType('brim');
            printPoint = poly2polyEmit(polys, printPoint, (poly, index, count, startPoint) => {
                return print.polyPrintPath(poly, startPoint, preout, {
                    tool: baseTool,
                    rate: firstLayerRate,
                    onfirst: function(point) {
                        if (preout.length && point.distTo2D(startPoint) > 2) preout.last().retract = true;
                    }
                });
            });
            print.addPrintPoints(preout, layerout);
            if (preout.length) preout.last().retract = true;
        }

        // if using brim or skirt
        if (process.outputBrimCount) {
            let polys = [],
                preout = [];

            // offset specified # of brims
            POLY.offset(brims, nozzle, {
                outs: polys,
                flat: true,
                count: process.outputBrimCount,
                z: firstLayerHeight / 2 + zoff - zneg
            });

            print.setType('brim');
            shield = POLY.nest(polys.clone(), true).clone();

            // output brim points
            let brimStart = offset < nozzle * 2 ? newPoint(-bedWidth, -bedDepth, 0) : printPoint;
            printPoint = poly2polyEmit(polys, brimStart, (poly, index, count, startPoint) => {
                return print.polyPrintPath(poly, startPoint, preout, {
                    tool: baseTool,
                    rate: firstLayerRate,
                    onfirst: function(point) {
                        if (preout.length && point.distTo2D(startPoint) > 2) {
                            // retract between brims
                            preout.last().retract = true;
                        }
                    }
                });
            });

            print.addPrintPoints(preout, layerout);

            if (preout.length) {
                // retract between brims and print
                preout.last().retract = true;
            }
        }

        // recompute bounds for purge block offsets
        if (supportBrim) brims.push(...supportBrim.base);
        let bbounds = newBounds();
        brims.forEach(brim => {
            bbounds.merge(brim.bounds);
        });
        bounds.min.x = Math.min(bounds.min.x, bbounds.minx);
        bounds.min.y = Math.min(bounds.min.y, bbounds.miny);
        bounds.max.x = Math.max(bounds.max.x, bbounds.maxx);
        bounds.max.y = Math.max(bounds.max.y, bbounds.maxy);
    }

    let lastPoly;
    let lastLayer;
    let lastOffset;
    let extruders = print.extruders = [];
    let extcount = 0;

    // find max layers (for updates)
    // generate list of used extruders for purge blocks
    for (let extruder of widgets.map(w => w.anno.extruder ?? 0)) {
        if (!extruders[extruder]) {
            extruders[extruder] = {};
            extcount++;
        }
    }
    // add tools used by colour painted regions and colour by height
    for (let widget of widgets) {
        for (let slice of widget.slices || []) {
            if (slice.extruder >= 0 && !extruders[slice.extruder]) {
                extruders[slice.extruder] = {};
                extcount++;
            }
            for (let top of slice.tops || []) {
                if (top.tool >= 0 && !extruders[top.tool]) {
                    extruders[top.tool] = {};
                    extcount++;
                }
            }
        }
    }
    // support tool: 0 = the object's own (as Orca's "default"), n = slot n;
    // only a separate support slot that is really used needs a purge block
    const supportTool = widget => sliceSupportNozzle > 0 ? sliceSupportNozzle - 1 : (widget.anno.extruder ?? 0);
    for (let widget of widgets) {
        if (!(widget.slices || []).some(slice => slice.supports?.length)) continue;
        const tool = supportTool(widget);
        if (!extruders[tool]) {
            extruders[tool] = {};
            extcount++;
        }
    }

    // determine size/location of purge blocks
    let blokw = Math.sqrt(outputPurgeTower || 0);
    let blokh = blokw;
    let blokpos, walkpos, blok;

    /**
     * mkblok() - Calculate purge tower block positions and layout
     *
     * Sets up the geometric layout for purge tower blocks. Each extruder swap requires
     * a purge block, so we create (extcount-1) blocks arranged either horizontally or
     * vertically depending on the print bed orientation.
     *
     * @param {number} w - width of each purge block
     * @param {number} h - height of each purge block
     *
     * Sets module-level variables:
     * - blokpos: starting position {x,y} for first block
     * - walkpos: step vector {x,y} between blocks
     * - blok: dimensions {x,y} of each block
     */
    function mkblok(w,h) {
        let count = extcount - 1;
        let gap = nozzle;
        if (isBelt) {
            let step = w + gap;
            let mp = (bounds.max.y + bounds.min.y) / 2;         // part y midpoint
            let sp = (bounds.max.y - bounds.min.y);             // part y span
            let ts = (w * count) + (gap * (count - 1));         // tower y span
            let ty = -ts + w/2 - gap/2;                         // tower start y
            blokpos = { y:ty, x: bounds.max.x + 2 + h / 2};     // first block pos
            walkpos = { y:step, x:0 };
            blok = { x:h, y:w };
        } else if (bounds.min.x < bounds.min.y) {
            let step = h + gap;
            let mp = (bounds.max.x + bounds.min.x) / 2;         // part y midpoint
            let sp = (bounds.max.x - bounds.min.x);             // part y span
            let ts = (h * count) + (gap * (count - 1));         // tower y span
            let tx = mp - ts / 2 + step / 2;                    // tower start y
            blokpos = { x:tx, y: bounds.max.y + 2 + w / 2};     // first block pos
            walkpos = { x:step, y:0 };
            blok = { x:w, y:h };
        } else {
            let step = w + gap;
            let mp = (bounds.max.y + bounds.min.y) / 2;         // part y midpoint
            let sp = (bounds.max.y - bounds.min.y);             // part y span
            let ts = (w * count) + (gap * (count - 1));         // tower y span
            let ty = mp - ts / 2 + step / 2;                    // tower start y
            blokpos = { y:ty, x: bounds.max.x + 2 + h / 2};     // first block pos
            walkpos = { y:step, x:0 };
            blok = { x:w, y:h };
        }
    }

    /**
     * mkrec() - Create a purge tower block record for a specific extruder
     *
     * Generates the geometry for one purge block including outline, dense fill,
     * and sparse fill patterns. Position is calculated based on the block index.
     *
     * @param {number} i - extruder index in device.extruders array (NOT sparse extruders index)
     * @param {number} angle - fill pattern angle in degrees (default 45)
     * @param {number} thin - spacing multiplier for sparse fill (default 6)
     * @returns {Object} purge block record with:
     *   - extruder: extruder index
     *   - diameter: nozzle diameter
     *   - rect: outer rectangle polygon
     *   - full: dense fill pattern for first layer or tool changes
     *   - sparse: sparse fill pattern for maintaining tower structure
     *   - pause: position for any pause commands
     */
    function mkrec(i, angle = 45, thin = 6) {
        let exi = device.extruders[i],
            noz = exi.extNozzle,
            pos = {x:blokpos.x + walkpos.x * i, y:blokpos.y + walkpos.y * i, z:0},
            rect = newPolygon().centerRectangle(pos, blok.x, blok.y),
            full = linesToPoly(fillArea([
                newPolygon().centerRectangle(pos, blok.x - noz, blok.y - noz)
            ], angle, noz)),
            sparse = rect.area() > 10 ? linesToPoly(fillArea([
                newPolygon().centerRectangle(pos, blok.x - noz, blok.y - noz)
            ], angle + 90, noz * thin)) : newPolygon(),
            rec = {
                extruder: i,
                diameter: exi.extNozzle,
                rect,
                full,
                sparse,
                pause: newPoint(pos.x + walkpos.y, pos.y + walkpos.x, pos.z)
            };
        return rec;
    }

    mkblok(blokw, blokh);

    // allocate tower space for extruders-1 locations
    // for example, with colors, you only need to swap once
    // on each layer then start the next layer on the
    // currently selected tool.
    // IMPORTANT: must use actual extruder indices, not array indices,
    // to handle non-contiguous tool usage (e.g., tool 0 + tool 2)
    let usedExtruderIndices = [];
    for (let i = 0; i < extruders.length; i++) {
        if (extruders[i]) {
            usedExtruderIndices.push(i);
        }
    }
    let towers = usedExtruderIndices.slice(1).map((extruderIndex, blockIndex) => {
        return mkrec(extruderIndex, 45 + blockIndex * 90);
    });

    // console.log({
    //     extruders: extruders.slice(),
    //     towers: towers.slice()
    // });

    function linesToPoly(points) {
        let poly = newPolygon().setOpen();
        let ping = 0;
        for (let i=0; i<points.length; i += 2) {
            let p1 = points[i];
            let p2 = points[i+1];
            if (ping++ % 2 === 0) {
                poly.push(p1);
                poly.push(p2);
            } else {
                poly.push(p2);
                poly.push(p1);
            }
        }
        return poly;
    }

    let purgedFirst = false;
    let lastPurgeTool;

    /**
     * purge() - Generate purge tower block output for a given tool
     *
     * Called in two contexts:
     * 1. Real purge: When switching tools during printing (using=undefined)
     * 2. Fill-in: At layer end to maintain unused blocks (using=actual tool index)
     *
     * The function consumes one purge block from the track array and generates:
     * - Outline perimeter (with extrusion)
     * - Fill pattern (dense for real purges, sparse for fill-ins)
     * - Retract
     * - Optional wipe move (outline without extrusion)
     *
     * @param {number} nozzle - The extruder index that needs purging/filling
     * @param {Array} track - Array of available purge block records (mutated via shift())
     * @param {Array} layer - Output layer array to append print moves to
     * @param {Point} start - Current print head position
     * @param {number} z - Z height for this layer
     * @param {number} using - Optional override tool index:
     *                         - undefined/negative: real purge (use nozzle param)
     *                         - >= 0: fill-in mode (use this tool instead)
     * @param {Object} offset - Position offset for belt printers
     * @returns {Point} Updated print head position after purge block
     *
     * Fill pattern selection:
     * - Dense fill (rec.full): Used for first layer or real tool changes
     * - Sparse fill (rec.sparse): Used for fill-ins or consecutive same-tool purges
     */
    function purge(nozzle, track, layer, start, z, using, offset) {
        if (!outputPurgeTower || extcount < 2) {
            return start;
        }
        // Get next available purge block (consumes from track array)
        let rec = track.shift();

        // Use sparse fill if: filling someone else's block OR same tool as last purge
        let thin = using >= 0 || lastPurgeTool === nozzle;

        // Actual tool to use: override tool for fill-ins, otherwise the nozzle being purged
        let tool = using >= 0 ? using : nozzle;

        // Detect first layer for special handling
        let first = isBelt ? !purgedFirst && layer.slice.index >= 0 : layer.slice.index === 0;
        let rate = first ? process.firstLayerRate : process.outputFeedrate;
        let wipe = true;
        lastPurgeTool = tool;

        if (rec) {
            print.setType('purge tower');
            if (layer.last()) {
                layer.last().retract = true;
            }
            purgedFirst = purgedFirst || first;

            // Use dense fill for first layer or real purges (when thin=false)
            let purgeOn = first || !thin;

            // Belt printer: scale tower size for negative Z (before belt contact)
            if (isBelt && z < 0) {
                let scale = 1 - ((z / zmin));
                mkblok(blokw * scale, blokh);
                rec = mkrec(rec.extruder, 0, 10);
                rate = (process.outputFeedrate - process.firstLayerRate) * scale + process.firstLayerRate;
                wipe = false;
            }
            // Prepare geometry: outline, pause point, and fill pattern (dense or sparse)
            let box = rec.rect.clone().setZ(z);
            let pause = rec.pause.clone().setZ(z);
            let fill = (z >= 0 && purgeOn ? rec.full : rec.sparse).clone().setZ(z);

            // Belt printer: apply Y/Z coordinate transformations
            if (isBelt) {
                let bmove = {x:0, y:z, z:0};
                box.move(bmove);
                pause.move(bmove);
                if (fill) {
                    fill.move(bmove);
                }
                if (offset) {
                    let bo = { x:0, y:offset.y, z:offset.z };
                    box.move(bo);
                    pause.move(bo);
                    if (fill) fill.move(bo);
                }
            }

            // Output sequence: 1. Outline perimeter (with extrusion)
            start = print.polyPrintPath(box, start, layer, {
                tool,
                rate,
                simple: true,
                open: false,
                onfirstout: (out => out.overate = (isBelt ? rate : 0))
            });

            // Output sequence: 2. Fill pattern (with extrusion, dense or sparse)
            if (fill && fill.length) {
                start = print.polyPrintPath(fill, start, layer, {
                    tool,
                    rate,
                    simple: true,
                    open: true,
                    onfirst: (point) => { point.purgeOn = purgeOn ? pause : undefined }
                });
            }

            // Output sequence: 3. Retract after fill
            layer.last().retract = true;

            // Output sequence: 4. Post-retract wipe (outline without extrusion)
            if (wipe) start = print.polyPrintPath(box, start, layer, {
                tool,
                rate,
                simple: true,
                open: false,
                extrude: 0
            });
            layer.last().overate = 0;
            return start;
        } else {
            console.log({no_purge_tower_for: nozzle, using, track, layer});
            return start;
        }
    }

    /**
     * Establish widget offsets
     *
     * For belt printers: Apply trigonometric transformation from Y-axis position
     * to inclined belt coordinate system using widget.belt properties (cosf, sinf, ypos)
     *
     * For normal printers: Use widget position plus any raft offset
     *
     * Note: This must run BEFORE support widgets are created, as they inherit
     * both the offset and belt properties from their parent widget.
     */
    for (let widget of widgets) {
        let { belt } = widget;
        let offset = Object.clone(widget.track.pos);
        if (isBelt) {
            offset = {
                x: belt.xpos,
                y: belt.ypos * belt.cosf,  // Y component of inclined belt
                z: belt.ypos * belt.sinf   // Z component of inclined belt
            };
        } else {
            // when rafts used this is non-zero
            offset.z = zoff;
        }
        widget.offset = offset;
    }

    /**
     * Extract support structures into separate synthetic widgets
     *
     * Support structures use a different extruder (sliceSupportNozzle) and need
     * to be processed independently. This creates new "virtual" widgets containing
     * only support geometry.
     *
     * CRITICAL for belt mode: Must copy belt properties to maintain proper positioning
     * - widget.belt: Required for offset calculations if widget list is reprocessed
     * - slice.belt.anchor: Used to mark layers that touch the belt (line 667)
     * - slice.belt.touch: Affects print start position logic (line 676)
     *
     * Without belt property copying, supports render in incorrect positions because
     * the belt coordinate transformations (cosf, sinf, ypos) are not applied.
     */
    for (let widget of widgets.slice()) {
        let slices = [];
        for (let slice of widget.slices) {
            if (slice.supports) {
                let nslice = newSlice(slice.z);
                nslice.belt = slice.belt;
                nslice.height = slice.height;
                nslice.index = slice.index;
                nslice.supports = slice.supports;
                nslice.extruder = supportTool(widget);
                slices.push(nslice);
            }
        }
        if (slices.length) {
            let nwid = newWidget(null, widget.group);
            nwid.support = true;
            nwid.slices = slices;
            nwid.offset = widget.offset;  // inherit calculated offset from parent
            nwid.belt = widget.belt; // inherit any belt transformations
            widgets.push(nwid);
        }
    }

    // ironing needs what lies above each layer (all colours): snapshot it
    // before colour painted layers are split into separate widgets
    if (process.outputIronType && process.outputIronType !== 'none') {
        for (let widget of widgets) {
            for (let slice of widget.slices || []) {
                slice.upPolys = slice.up?.tops?.length ? slice.up.topPolys() : [];
            }
        }
    }

    // Split colour painted layers into one synthetic widget per extra filament
    // (like supports above). Painted tops carry top.tool from the slicer; the
    // parent widget keeps the tops printed with its own extruder.
    for (let widget of widgets.slice()) {
        if (widget.support) continue;
        let byTool = {};
        for (let slice of widget.slices) {
            if (!slice.tops?.some(top => top.tool >= 0 && top.tool !== slice.extruder)) continue;
            let keep = [];
            let split = {};
            for (let top of slice.tops) {
                let tool = top.tool ?? slice.extruder;
                if (tool === slice.extruder) {
                    keep.push(top);
                    continue;
                }
                let nslice = split[tool];
                if (!nslice) {
                    nslice = split[tool] = newSlice(slice.z);
                    nslice.belt = slice.belt;
                    nslice.height = slice.height;
                    nslice.index = slice.index;
                    nslice.params = slice.params;
                    nslice.isFlatsLayer = slice.isFlatsLayer;
                    nslice.isBridgeLayer = slice.isBridgeLayer;
                    nslice.extruder = tool;
                    nslice.upPolys = slice.upPolys;
                    (byTool[tool] = byTool[tool] || []).push(nslice);
                }
                nslice.tops.push(top);
            }
            slice.tops = keep;
        }
        for (let [tool, slices] of Object.entries(byTool)) {
            let nwid = newWidget(null, widget.group);
            nwid.slices = slices;
            nwid.offset = widget.offset;
            nwid.belt = widget.belt;
            nwid.anno.extruder = parseInt(tool);
            nwid.meta.file = widget.meta?.file;
            // export labels it with the parent's object id, so cancel covers all colours
            nwid.colorOf = widget;
            widgets.push(nwid);
        }
    }

    // create shuffled slice cake by z offset (slice.z + offset.z)
    let cake = [];
    let zrec = {};
    for (let widget of widgets) {
        for (let slice of widget.slices) {
            slice.widget = widget;
            let z = (slice.z + widget.offset.z).round(2);
            let rec = zrec[z] = zrec[z] || {z, slices:[]};
            if (rec.slices.length === 0) {
                cake.push(rec);
            }
            rec.slices.push(slice);
        }
    }
    cake.sort((a, b) => {
        return a.z - b.z;
    });

    let firstTool = baseOut ? baseTool : undefined;  // First extruder used (determines starting extruder)
    let lastWidget;     // Last widget printed (for retraction decisions)
    let lastExt = firstTool;  // Last extruder used (for minimizing tool changes)
    let lastOut;        // Last output slice (for tracking state)

    print.zmax = zmax;
    print.total_time = 0;

    /**
     * MAIN PRINT LOOP: Walk cake layers bottom up
     *
     * The "cake" is a sorted array of layers where each layer contains all slices
     * at that Z height from all widgets. This loop processes layers in Z order.
     *
     * For each layer:
     * 1. Process all slices using greedy nearest-neighbor with extruder penalties
     * 2. Generate purge tower blocks on extruder changes
     * 3. Add optional draft shield around perimeter
     * 4. Fill any unused purge blocks to maintain tower structure
     * 5. Append completed layer to output and update progress
     *
     * Key optimization: Minimize travel and extruder changes by:
     * - Prioritizing slices using the same extruder (10000x distance penalty for changes)
     * - Choosing nearest slice within same-extruder group
     * - Starting first object with extruder 0 when possible
     */
    for (let layer of cake) {
        // Clone towers array to track available purge blocks for this layer
        // Each purge block can only be used once per layer
        let track = towers.slice();

        /**
         * INNER LOOP: Process all slices in this layer
         *
         * Uses greedy nearest-neighbor algorithm with extruder awareness:
         * - Builds a priority queue of unprinted slices
         * - Heavily penalizes extruder changes (10000x distance multiplier)
         * - Selects closest slice with preferred extruder
         * - Marks as prep'd and removes from consideration
         * - Repeats until all slices processed (order.length === 0)
         */
        for (;;) {
            // Build priority queue of unprinted slices with weighted distances
            let order = [];

            // Evaluate each unprinted slice in this layer
            for (let slice of layer.slices) {
                if (slice.prep) {
                    continue; // Skip already processed slices
                }
                let offset = lastOffset = slice.widget.offset;
                let find = slice.findClosestPointTo(printPoint.sub(offset));
                if (find) {
                    let ext = slice.extruder;
                    let lex = lastExt;
                    let dst = Math.abs(find.distance);

                    // CRITICAL: Heavily penalize extruder changes to minimize purging
                    // 10000x multiplier makes any same-extruder slice preferred over a swap
                    if (ext !== lex) {
                        dst *= 10000;
                    }

                    // CRITICAL: For first slice in print, prefer extruder 0
                    // Ensures print starts with primary extruder when possible
                    if (lastExt === undefined && ext > 0) {
                        dst *= 10000;
                    }

                    order.push({dst, slice, offset, z: layer.z});
                }
            }

            // All slices processed for this layer - exit inner loop
            if (order.length === 0) {
                break;
            }

            // Sort by weighted distance (extruder penalty + travel distance)
            order.sort((a,b) => {
                return a.dst - b.dst;
            });

            // Select nearest slice (considering extruder penalties)
            let { z, slice, offset } = order[0];
            // Track the first tool used to determine print starting extruder
            if (firstTool === undefined) {
                firstTool = slice.extruder;
            }

            // Force retraction when switching between different widgets
            // Prevents stringing during travel moves between objects
            let forceRetract = lastOut && lastOut.widget !== slice.widget;
            if (forceRetract && output.length) {
                output.last().last().retract = true;
            }

            // Get any layer-specific parameter overrides for this slice
            let params = getRangeParameters(process, slice.index);

            // Mark slice as processed so it won't be selected again
            slice.prep = true;

            // Retract between widgets within the same layer
            if (layerout.length && slice.widget !== lastWidget) {
                layerout.last().retract = true;
            }

            // Update layer metadata for this slice
            lastWidget = slice.widget;
            layerout.z = z + slice.height / 2;
            layerout.height = layerout.height || slice.height;
            layerout.slice = slice;
            layerout.params = params;
            layerout.anchor = slice.belt && slice.belt.anchor; // Belt anchor flag

            // PURGE TOWER: Generate purge block on extruder change
            // Only purge when switching to a different extruder
            if (!lastOut || lastOut.extruder !== slice.extruder) {
                if (slice.extruder >= 0)
                printPoint = purge(slice.extruder, track, layerout, printPoint, slice.z, undefined, offset);
            }
            let wtb = slice.widget.track.box;
            let beltStart = slice.belt && slice.belt.touch;

            // PRINT THIS SLICE: Generate all toolpaths (shells, infill, etc.)
            print.setType('layer');
            print.setWidget(lastWidget);
            printPoint = slicePrintPath(
                print,
                slice,
                // Belt prints start from far corner, others from current position
                beltStart ? newPoint(-5000, 5000, 0) : printPoint.sub(offset),
                offset,
                layerout,
                {
                    first: slice.index === 0,
                    onBelt: beltStart,
                    params, // layer-specific parameter overrides
                    pretract: (wipeDist) => {
                        // Optional wipe move before retraction
                        if (!(lastLayer && lastLayer.length)) {
                            return;
                        }
                        let lastOut = lastLayer.last().set_retract();
                        if (wipeDist && lastPoly && lastOut.point) {
                            let center = lastPoly.center(true).add(offset);
                            let maxDist = lastOut.point.distTo2D(center);
                            let useDist = Math.min(wipeDist, maxDist);
                            let endpoint = lastOut.point.followTo(center, useDist);
                            if (endpoint.inPolygon(lastPoly)) {
                                print.addOutput(lastLayer, endpoint, null, null, lastOut.tool);
                            }
                        }
                    },
                    routeAround: process.outputAvoidGaps,
                    seedPoint: printPoint.sub(offset),
                    zmax,
                }
            );

            // Update print time statistics
            layerout.print_time = printPoint.layer_time;
            print.total_time += printPoint.layer_time;
            print.setWidget(null);

            // Update state for next iteration
            lastOut = slice;
            lastExt = lastOut.extruder;
            lastPoly = slice.lastPoly;
            lastLayer = layerout;

            // Optional retraction after every layer
            if (params.outputLayerRetract && layerout.length) {
                layerout.last().retract = true;
            }
        }
        // End of inner loop - all slices in this layer have been processed

        /**
         * POST-PROCESSING: Layer finalization steps
         */

        // Clear prep flags to allow re-preview in different modes
        // Only clear real widget slices, not synthesized support widgets
        for (let widget of widgets) {
            if (!widget.mesh) {
                continue; // Skip synthesized support widgets
            }
            for (let slice of widget.slices) {
                slice.prep = false;
            }
        }

        // DRAFT SHIELD: Print perimeter around all objects (layers 1+)
        // Helps contain heat and protects from drafts for better print quality
        if (layerno > 0 && shield && outputDraftShield) {
            print.setType('shield');
            shield = POLY.setZ(shield.clone(), printPoint.z);
            let preout = [];
            printPoint = poly2polyEmit(shield, printPoint, (poly, index, count, startPoint) => {
                return print.polyPrintPath(poly, startPoint, preout, {
                    onfirst: function(point) {
                        if (preout.length && point.distTo2D(startPoint) > 2) {
                            preout.last().retract = true;
                        }
                    }
                });
            });
            preout.last().retract = true;
            layerout.appendAll(preout);
        }

        // FILL UNUSED PURGE BLOCKS: Maintain structural integrity of purge tower
        // Any purge blocks not used for real tool changes get filled with sparse
        // infill using the current extruder. This keeps the tower solid for support.
        if (lastOut) track.slice().forEach(ext => {
            // using=lastExt means "fill with current tool" (sparse fill mode)
            printPoint = purge(ext.extruder, track, layerout, printPoint, lastOut.z, lastExt, lastOffset);
        });

        // Append completed layer to output array
        if (layerout.length) {
            // top of this layer in the objects' own z (colour by height picks it)
            layerout.wz = (layer.z + (layer.slices[0]?.height || 0) / 2).round(3);
            output.append(layerout);
        }

        // Final retraction after last layer of print
        if (layerno === cake.length - 1 && layerout.length) {
            layerout.last().retract = true;
        }

        // Update progress callback (prepare phase is 0-50%)
        layerout.layer = layerno++;
        update((layerno / cake.length) * 0.5, "prepare");

        // Reset for next layer
        layerout = [];
        layerout.height = sliceHeight;
    }

    print.output = output;
    print.layerZ = output.map(l => l.wz ?? null);
    print.firstTool = firstTool;

    // post-process for base extrusions (touching the bed)
    if (isBelt) {
        // all widgets should have the same belt scaling constants
        let belt = widgets[0].belt;
        // tune base threshold
        let thresh = Infinity;
        for (let layer of output) {
            for (let rec of layer) {
                let point = rec.point;
                thresh = Math.min(thresh, (belt.slope * point.z) - point.y);
            }
        }
        // store this offset to be removed from Y values in export
        print.belty = thresh;
        thresh = Math.max(0, thresh) + firstLayerHeight * belt.slope;
        // track last layer out b/c it might be connected to the current
        // layer first point, in which case the injected brim will cause a long print line
        let lastLayerOut;
        // iterate over layers, find extrusion on belt and
        // apply corrections and add brim when specified
        for (let layer of output) {
            let params = getRangeParameters(process, layer.layer || 0);
            let brimHalf = params.firstLayerBrim < 0;
            let firstLayerBrim = Math.abs(params.firstLayerBrim);
            let firstLayerBrimIn = params.firstLayerBrimIn || 0;
            let firstLayerBrimTrig = params.firstLayerBrimTrig || 0;
            let firstLayerBrimGap = params.firstLayerBrimGap || 0;
            let lastout, first = false;
            let minz = Infinity, maxy = -Infinity, minx = Infinity, maxx = -Infinity;
            let mins = Infinity;
            let miny = Infinity;
            let pads = [];
            let overate = 0;

            for (let rec of layer) {
                overate = rec.overate >= 0 ? rec.overate : overate;
                let bmult = params.firstLayerBeltFact ?? 1;
                let brate = params.firstLayerRate || firstLayerRate;
                let point = rec.point;
                let belty = rec.belty = -point.y + (point.z * belt.slope);
                let lowrate = belty <= thresh ? brate : overate || brate;
                miny = Math.min(miny, belty);
                if (layer.anchor) {
                    // apply base rate to entire anchor (including bump)
                    rec.speed = Math.min(rec.speed, lowrate);
                }
                if (rec.emit && belty <= thresh && lastout && Math.abs(lastout.belty - belty) < 0.01) {
                    // apply base speed to segments touching belt
                    rec.speed = params.firstLayerRate || Math.min(rec.speed, lowrate);
                    rec.fan = params.firstLayerFanSpeed;
                    // apply base flowrate multiplier to segments touching belt
                    rec.emit *= bmult;
                    minx = Math.min(minx, point.x, lastout.point.x);
                    maxx = Math.max(maxx, point.x, lastout.point.x);
                    maxy = Math.max(maxy, point.y);
                    minz = Math.min(minz, point.z);
                    first = rec;
                    // find length of shortest bed-facing segment
                    mins = Math.min(mins, lastout.point.distTo2D(rec.point));
                    // add to pads list if > 1mm long
                    if (point.x - lastout.point.x > 1) {
                        pads.push([lastout.point.x, point.x]);
                    }
                }
                lastout = rec;
            }
            // do not add brims to anchor layers
            if (!first || layer.anchor) {
                continue;
            }
            let tmpout = [];
            let trigmet = firstLayerBrimTrig === 0 || (firstLayerBrimTrig && mins <= firstLayerBrimTrig);
            let brimax = Math.max(firstLayerBrim, firstLayerBrimIn);
            // add brim when all conditions met
            if (brimax && trigmet) {
                let { emit, tool } = first;
                let y = maxy;
                let z = minz;
                let g = firstLayerBrimGap || 0;
                let b = Math.max(firstLayerBrim, 1) + g;
                let bi = Math.max(firstLayerBrimIn, 1) + g;
                let lastLayerOut = layer.last();
                lastLayerOut.retract = true;
                // if routaround selected, move to belt before moving to brim start
                if (process.outputAvoidGaps) {
                    let beltPoint = lastLayerOut.point.clone();
                    beltPoint.y = y;
                    print.addOutput(tmpout, beltPoint, 0, outputSeekrate, tool);
                }
                // outside brim
                if (firstLayerBrim && !brimHalf) {
                    print.addOutput(tmpout, newPoint(maxx + b, y, z), 0,    outputSeekrate, tool);
                    print.addOutput(tmpout, newPoint(maxx + g, y, z), emit, firstLayerRate, tool,{retract: true})
                }
                // inside brim
                if (firstLayerBrimIn && pads.length > 1) {
                    let gaps = [];
                    let lpad = pads[0];
                    for (let pad of pads.slice(1)) {
                        let x0 = lpad[1];
                        let x1 = pad[0];
                        lpad = pad;
                        if (x1 - x0 > bi * 2) {
                            // over 2x brim so emit two segments
                            print.addOutput(tmpout, newPoint(x1 - g, y, z), 0,    outputSeekrate, tool);
                            print.addOutput(tmpout, newPoint(x1 - bi, y, z), emit, firstLayerRate, tool, {retract: true});
                            print.addOutput(tmpout, newPoint(x0 + bi, y, z), 0,    outputSeekrate, tool);
                            print.addOutput(tmpout, newPoint(x0 + g, y, z), emit, firstLayerRate, tool, {retract: true});
                        } else if (x1 - x0 > bi / 3) {
                            // over 1/3rd brim length emit single segment
                            print.addOutput(tmpout, newPoint(x1 - g, y, z), 0,    outputSeekrate, tool);
                            print.addOutput(tmpout, newPoint(x0 + g, y, z), emit, firstLayerRate, tool, {retract: true});
                        }
                    }
                }
                // outside brim
                if (firstLayerBrim) {
                    print.addOutput(tmpout, newPoint(minx - b, y, z), 0,    outputSeekrate, tool);
                    print.addOutput(tmpout, newPoint(minx - g, y, z), emit, firstLayerRate, tool, {retract: true});
                }
                // when there is a printing move between layers
                // inject non-printing move to after brim to prevent erroneous extrusion
                if (layer[0].emit && lastLayerOut) {
                    print.addOutput(tmpout, layer[0].point.clone(), 0, outputSeekrate, tool);
                }
                layer.splice(0,0,...tmpout);
            } else {
                // for any layer touching belt, ensure start point is nearest origin
                // print.addOutput(tmpout, newPoint(minx, maxy, minz), 0, outputSeekrate, first.tool);
                // print.lastPoint = newPoint(minx, maxy, minz);
            }
            lastLayerOut = layer.peek();
        }
    }

    // render if not explicitly disabled
    if (settings.render !== false) {
        await render.path(output, (progress, layer) => {
            update(0.5 + progress * 0.5, "render", layer);
        }, {
            lineWidth: settings.process.sliceLineWidth,
            toolMode: settings.pmode === 2,
            tools: device.extruders,
            thin: isThin,
            flat: isFlat,
            fdm: true
        });
    }
};


/**
 * Output and route Slice (shell,fill) paths for a single Slice
 *
 * @param {*} print Print output Object
 * @param {*} slice current slice being Output
 * @param {*} startPoint starting point for this layer
 * @param {*} offset start point offset
 * @param {*} output output prebuffer
 * @param {*} opt options
 */
// bead cross section (as export.js extrudePerMM): width x height with round sides
function beadArea(w, h) {
    return w > h ? (w - h) * h + Math.PI * h * h / 4 : Math.PI * w * w / 4 * (h / w);
}

function insideRing(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

// the part on one layer, for "is this point over it, and how far off"
// (segments bucketed on a 2 mm grid)
function layerProbe(polys) {
    const cell = 2, grid = new Map(), rings = [];
    for (const poly of polys || []) {
        for (const ring of [ poly, ...(poly.inner || []) ]) {
            const pts = ring.points;
            rings.push({ poly, pts, hole: ring !== poly });
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                const x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
                const y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
                for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                    const k = x * 100003 + y;
                    let l = grid.get(k); if (!l) grid.set(k, l = []);
                    l.push(a, b);
                }
            }
        }
    }
    return {
        inside(x, y) {
            for (const poly of polys || []) {
                if (!insideRing(poly.points, x, y)) continue;
                if (!(poly.inner || []).some(h => insideRing(h.points, x, y))) return true;
            }
            return false;
        },
        // distance to the nearest outline within range (Infinity beyond)
        dist(x, y, range) {
            let best = Infinity;
            const r = Math.ceil(range / cell), cx = Math.floor(x / cell), cy = Math.floor(y / cell);
            for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
                const l = grid.get((cx + i) * 100003 + cy + j);
                if (!l) continue;
                for (let k = 0; k < l.length; k += 2) {
                    const a = l[k], b = l[k + 1], dx = b.x - a.x, dy = b.y - a.y;
                    const len = dx * dx + dy * dy;
                    const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
                    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
                }
            }
            return best;
        }
    };
}

// fuzzy skin (Orca): the loop resampled every `dist` mm, each point moved a
// random amount (within `thick`) across the wall; seeded, so slicing again
// gives the same skin
function fuzzyLoop(poly, thick, dist, seed) {
    let rnd = seed * 9301 + 49297;
    const rand = () => (rnd = (rnd * 9301 + 49297) % 233280) / 233280;
    const pts = poly.points, out = newPolygon();
    out.depth = poly.depth;
    const n = pts.length;
    let carry = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!len) continue;
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        for (let t = carry; t < len; t += dist) {
            const off = (rand() - 0.5) * thick;
            out.push(newPoint(a.x + (b.x - a.x) * t / len + nx * off, a.y + (b.y - a.y) * t / len + ny * off, a.z));
        }
        carry = (carry - len) % dist;
        if (carry < 0) carry += dist;
    }
    return out.length >= 3 ? out : poly;
}

function slicePrintPath(print, slice, startPoint, offset, output, opt = {}) {
    const { settings } = print;
    const { device } = settings;
    const { bedWidth, bedDepth, bedRound } = device;

    let preout = [],
        process = opt.params || settings.process,
        originCenter = device.originCenter || bedRound,
        extruder = parseInt(slice.extruder || 0),
        scarfLength = process.outputScarfLength || 0,
        minLayerTime = process.outputMinLayerTime || 0,
        nozzleSize = process.sliceLineWidth || device.extruders[extruder].extNozzle,
        nozzles = device.extruders.map(e => e.extNozzle),
        firstLayer = (opt.first || false),
        thinWall = nozzleSize * (opt.thinWall || 1.75),
        retractDist = opt.retractOver || (nozzleSize * 5),
        fillMult = opt.mult || process.outputFillMult,
        shellMult = opt.mult || process.outputShellMult || (process.ctSliceHeight >= 0 ? 1 : 0),
        shellOrder = {"out-in":-1,"in-out":1,"alternate":-2}[process.sliceShellOrder] || -1,
        sparseMult = process.outputSparseMult,
        coastDist = process.outputCoastDist || 0,
        fanSpeed = process.outputFanSpeed,
        firstShellSpeed = process.firstLayerRate,
        firstFillSpeed = process.firstLayerFillRate,
        finishSpeed = firstLayer ? firstShellSpeed : (opt.speed || process.outputFinishrate),
        printSpeed = opt.speed || (firstLayer ? firstShellSpeed : process.outputFeedrate),
        fillSpeed = opt.speed || opt.fillSpeed || (firstLayer ? firstFillSpeed || firstShellSpeed : process.outputFeedrate),
        infillSpeed = opt.infillSpeed || fillSpeed || printSpeed,
        moveSpeed = process.outputSeekrate,
        minSpeed = process.outputMinSpeed,
        origin = startPoint.add(offset),
        zhop = process.zHopDistance || 0,
        zmax = opt.zmax,
        antiBacklash = process.antiBacklash,
        maxFlowRate = process.outputMaxFlowrate,
        wipeDist = process.outputRetractWipe || 0,
        isBelt = device.bedBelt,
        { fdmArcEnabled, fdmArcTolerance, fdmArcResolution } = process,
        arcOpts = {
            tolerance: fdmArcTolerance,
            arcRes: fdmArcResolution
        },
        bedOffset = originCenter ? {
            x: 0,
            y: 0,
            z: 0
        } : {
            x: bedWidth/2,
            y: isBelt ? 0 : bedDepth/2,
            z: 0
        },
        beltFirst = process.outputBeltFirst || false,
        startClone = startPoint.clone(),
        seedPoint = opt.seedPoint || startPoint,
        switchTop = print.lastPoly && print.lastPoly.perimeter() < process.outputShortPoly,
        z = slice.z,
        lastPoly;

    // support alternating shell order
    if (Math.abs(shellOrder) > 1 && slice.index % 2 === 1) {
        shellOrder = -shellOrder;
    }

    // on flats layers also slow down shell print speed
    if (slice.isFlatsLayer) {
        printSpeed = finishSpeed || printSpeed;
    }

    // speeds per feature (Orca style; 0 = Kiri's own rules). Kiri knows per
    // layer, not per region, whether it holds a top surface or a bridge.
    const featureSpeeds = !firstLayer && !opt.speed;
    const { outputSpeedTop, outputSpeedSolid, outputSpeedSparse, outputSpeedBridge,
        outputSpeedGap, outputSpeedSupport, outputSpeedSmall, outputSmallRadius } = process;
    let gapSpeed = fillSpeed;
    if (featureSpeeds) {
        if (outputSpeedSolid && !opt.fillSpeed) fillSpeed = outputSpeedSolid;
        if (outputSpeedSparse && !opt.infillSpeed) infillSpeed = outputSpeedSparse;
        if (outputSpeedGap) gapSpeed = outputSpeedGap;
        if (outputSpeedTop && slice.isFlatsLayer) fillSpeed = outputSpeedTop;
    }

    // override: adapt bridge layer speed and flats
    // but not on the first layer which has it's own settings
    // (not when the top / bridge speed is set: then that speed applies)
    // bridge lines get their own speed per line (below), not the whole layer
    const lineBridges = !firstLayer && !opt.speed && slice.bridges?.length > 0;
    if (slice.index > 0 && ((slice.isBridgeLayer && !(featureSpeeds && outputSpeedBridge && lineBridges)) ||
        (slice.isFlatsLayer && !slice.isBridgeLayer && !(featureSpeeds && outputSpeedTop)))) {
        fillSpeed /= 2;
        printSpeed /= 2;
        finishSpeed /= 2;
    }
    if (!(featureSpeeds && outputSpeedGap)) gapSpeed = fillSpeed;
    // small perimeters (holes, pins): a loop shorter than a circle of this radius
    const smallLoop = featureSpeeds && outputSpeedSmall ? 2 * Math.PI * (outputSmallRadius || 6.5) : 0;

    // line widths per feature (Orca): extrusion scales with the bead's cross
    // section against the base line width export.js computes with
    const layerH = slice.height || process.sliceHeight;
    const widthOf = key => {
        const w = firstLayer && process.sliceLineWidthFirst > 0 ? process.sliceLineWidthFirst : process[key];
        return w > 0 ? w : nozzleSize;
    };
    const widthMult = key => beadArea(widthOf(key), layerH) / beadArea(nozzleSize, layerH);

    // bridges (Orca): solid lines over the air below get their own flow,
    // speed and fan; overhanging walls slow down and get the overhang fan
    const { outputBridgeFlow, outputOverhangFan, outputOverhangFanThreshold } = process;
    const overFan = outputOverhangFan >= 0 && !firstLayer ? Math.round(outputOverhangFan * 2.55) : undefined;
    const bridgeProbe = lineBridges ? layerProbe(slice.bridges) : null;
    const overSpeeds = [ process.outputSpeedOver1, process.outputSpeedOver2, process.outputSpeedOver3, process.outputSpeedOver4 ];
    const wantOverhang = !firstLayer && !opt.speed && slice.down && (overSpeeds.some(v => v > 0) || overFan !== undefined);
    const belowProbe = wantOverhang ? layerProbe(slice.down.topPolys ? slice.down.topPolys() : []) : null;

    // outputs from index `from` on: wall segments hanging past the layer below
    function markOverhangs(from, width) {
        if (!belowProbe) return;
        let lp = from > 0 ? preout[from - 1]?.point : null;
        for (let i = from; i < preout.length; i++) {
            const o = preout[i];
            const p = o.point;
            if (o.emit && p && lp) {
                const mx = (lp.x + p.x) / 2, my = (lp.y + p.y) / 2;
                let frac = 0;
                if (!belowProbe.inside(mx, my)) {
                    const d = belowProbe.dist(mx, my, width * 1.5);
                    frac = d === Infinity ? 1 : Math.min(1, (d + width / 2) / width);
                } else {
                    const d = belowProbe.dist(mx, my, width);
                    if (d < width / 2) frac = (width / 2 - d) / width;
                }
                if (frac > 0) {
                    const q = Math.min(3, Math.floor(frac * 4 - 1e-9));
                    if (overSpeeds[q] > 0) o.speed = Math.min(o.speed, overSpeeds[q]);
                    if (overFan !== undefined && frac >= (outputOverhangFanThreshold ?? 0.5)) o.fan = overFan;
                }
            }
            if (p) lp = p;
        }
    }

    function retract() {
        let array = preout.length ? preout : output;
        if (array.length) {
            let last = array.last();
            last.retract = true;
            if (wipeDist && lastPoly && last.point) {
                let center = lastPoly.center(true);
                let maxDist = last.point.distTo2D(center);
                let useDist = Math.min(wipeDist, maxDist);
                let endpoint = last.point.followTo(center, useDist);
                if (endpoint.inPolygon(lastPoly)) {
                    print.addOutput(array, endpoint, null, null, last.tool);
                }
            }
        } else if (opt.pretract) {
            opt.pretract(wipeDist);
        } else {
            console.log('unable to retract. no preout or output');
        }
    }

    // return true if move path from p1 to p2 intersects a
    // top and a path around the top (inside print) was not found
    function requiresRetract(p1, p2) {
        if (slice.index < 0) {
            return false;
        }
        let int = false;
        slice.topPolysFlat().forEach((poly) => {
            if (!int) poly.forEachSegment((s1, s2) => {
                if (util.intersect(p1,p2,s1,s2,base.key.SEGINT)) {
                    return int = true;
                }
            });
        });
        // if intersecting, look for a route around
        if (int && opt.routeAround) {
            return !routeAround(p1, p2);
        }
        return int;
    }

    // returns true if routed around or no retract requried
    function routeAround(p1, p2) {
        const dbug = false;
        if (dbug === slice.index) console.log(slice.index, {p1, p2, d: p1.distTo2D(p2)});

        let ints = [];
        let intk = new Set();
        let tops = slice.topRouteFlat();
        for (let poly of tops) {
            poly.forEachSegment((s1, s2) => {
                let ip = util.intersect(p1,p2,s1,s2,base.key.SEGINT);
                if (ip) ip._key = undefined;
                if (ip && !intk.has(ip.key)) {
                    ints.push({ip, poly});
                    intk.add(ip.key);
                    ip.p1.poly.hits = (ip.p1.poly.hits ?? 0) + 1;
                }
            });
        }
        ints = ints.filter(i => i.poly.hits === 2);

        // no intersections
        if (ints.length === 0) {
            if (dbug === slice.index) console.log(slice.index, 'no ints');
            return false;
        }

        // odd # of intersections ?!? do retraction
        if (ints.length && ints.length % 2 !== 0) {
            if (dbug === slice.index) console.log(slice.index, {odd_intersects: ints});
            return false;
        }

        // sort by distance
        ints.sort((a, b) => {
            return a.ip.dist - b.ip.dist;
        });

        if (dbug === slice.index) console.log(slice.index, {ints});

        // check pairs. eliminate too close points.
        // pairs must intersect same poly or retract.
        for (let i=0; i<ints.length; i += 2) {
            let i1 = ints[i];
            let i2 = ints[i+1];
            // different poly. force retract
            if (i1.poly !== i2.poly) {
                if (dbug === slice.index) console.log(slice.index, {int_diff_poly: ints, i});
                return false;
            }
            // mark invalid intersect pairs (low or zero dist, etc)
            // TODO: only if this is the outer pair and there are closer inner pairs
            if (i1.ip.distTo2D(i2.ip) < retractDist) {
                if (dbug === slice.index) console.log(slice.index, {int_dist_too_small: i1.ip.distTo2D(i2.ip), retractDist});
                ints[i] = undefined;
                ints[i+1] = undefined;
            }
        }
        // filter out invalid intersection pairs
        ints = ints.filter(i => i);

        if (ints.length > 2) {
            if (dbug === slice.index) console.log(slice.index, {complex_route: ints.length});
            return false;
        }

        if (ints.length === 2) {
            // can route around intersected top polys
            for (let i=0; i<ints.length; i += 2) {
                let i1 = ints[0];
                let i2 = ints[1];

                // output first point
                print.addOutput(preout, i1.ip, 0, moveSpeed, extruder);

                // create two loops around poly
                // find shortest of two paths and emit poly points
                let poly = i1.poly;
                let isCW = poly.isClockwise();
                let points = poly.points;

                let p1p = isCW ? points : points.slice().reverse(); // CW
                let p2p = isCW ? points.slice().reverse() : points; // CCW

                let r1s = p1p.indexOf(isCW ? i1.ip.p2 : i1.ip.p1);
                let r1e = p1p.indexOf(isCW ? i2.ip.p1 : i2.ip.p2);

                let r1 = r1s === r1e ?
                    [ p1p[r1s] ] : r1s < r1e ?
                    [ ...p1p.slice(r1s,r1e+1) ] :
                    [ ...p1p.slice(r1s), ...p1p.slice(0,r1e+1) ];

                let r1d = 0;
                for (let i=1; i<r1.length; i++) {
                    r1d += r1[i-1].distTo2D(r1[i]);
                }

                let r2s = p2p.indexOf(isCW ? i1.ip.p1 : i1.ip.p2);
                let r2e = p2p.indexOf(isCW ? i2.ip.p2 : i2.ip.p1);

                let r2 = r2s === r2e ?
                    [ p2p[r2s] ] : r2s < r2e ?
                    [ ...p2p.slice(r2s,r2e+1) ] :
                    [ ...p2p.slice(r2s), ...p2p.slice(0,r2e+1) ];

                let r2d = 0;
                for (let i=1; i<r2.length; i++) {
                    r2d += r2[i-1].distTo2D(r2[i]);
                }

                let route = r1d <= r2d ? r1 : r2;

                if (dbug === slice.index) console.log(slice.index, {
                    ints: ints.map(i=>i.ip.dist),
                    i1, i2, same: i1.poly === i2.poly,
                    route,
                    p1, p2, dist: p1.distTo2D(p2),
                    r1, r1d, r1s, r1e,
                    r2, r2d, r2s, r2e,
                    isCW});

                for (let p of route) {
                    print.addOutput(preout, p, 0, moveSpeed, extruder);
                }

                // output last point
                print.addOutput(preout, i2.ip, 0, moveSpeed, extruder);
            }
            return true;
        }

        return false;
    }

    // output shell wall
    function outputTraces(poly, opt = {}, traceNo = 0) {
        if (!poly) return;
        if (Array.isArray(poly)) {
            if (opt.sort) {
                let polys = poly.slice().sort((a,b) => {
                    return (a.perimeter() - b.perimeter()) * opt.sort;
                });
                let debug = polys.length > 3;
                let last;
                while (polys.length) {
                    let next;
                    for (let p of polys) {
                        if (!last) {
                            next = p;
                            break;
                        }
                        if (opt.sort > 0) {
                            // in-out
                            if (last.isInside(p)) {
                                next = p;
                                break;
                            }
                        } else {
                            // out-in
                            if (p.isInside(last)) {
                                next = p;
                                break;
                            }
                        }
                    }
                    if (next) {
                        last = next;
                        polys.remove(next);
                        outputTraces(next, opt, traceNo++);
                    } else {
                        last = null;
                    }
                }
            } else {
                outputOrderClosest(poly, function(next) {
                    outputTraces(next, opt, traceNo++);
                }, null);
            }
        } else {
            let finishShell = poly.depth === 0 && !firstLayer;
            let scarf = (slice.index > 0 && traceNo === 0 && z - startPoint?.z > 1e-3) ? scarfLength : 0;
            // mark outer vs inner walls so export can apply their own accelerations
            if (opt.shell) print.setType(poly.depth === 0 ? 'outer wall' : 'shells');
            const wallKey = poly.depth === 0 ? 'sliceLineWidthOuter' : 'sliceLineWidthInner';
            const from = preout.length;
            // fuzzy skin on the outer walls (or all walls)
            const fz = process.outputFuzzyThickness;
            if (opt.shell && fz > 0 && (!firstLayer || process.outputFuzzyFirst) && (poly.depth === 0 || process.outputFuzzyAll)) {
                poly = fuzzyLoop(poly, fz, process.outputFuzzyDistance || 0.8, slice.index * 31 + traceNo + 1);
            }
            startPoint = print.polyPrintPath(poly, startPoint, preout, {
                accel: finishShell,
                arcOpts: fdmArcEnabled ? arcOpts : undefined,
                ccw: opt.shell && process.outputAlternating && slice.index % 2,
                coast: firstLayer ? 0 : coastDist,
                extrude: numOrDefault(opt.extrude, shellMult) * (opt.shell ? widthMult(wallKey) : 1),
                nozzleSize,
                onfirst: (firstPoint, preout) => {
                    let from = seedPoint || startPoint;
                    if (from.distTo2D(firstPoint) > retractDist) {
                        if (requiresRetract(from, firstPoint)) {
                            retract();
                        }
                    }
                    seedPoint = null;
                },
                rate: smallLoop && poly.perimeter() < smallLoop ? Math.min(outputSpeedSmall, finishShell ? finishSpeed : printSpeed) :
                    finishShell ? finishSpeed : printSpeed,
                scarf,
                tool: extruder,
                zmax
            });
            if (opt.shell) markOverhangs(from, widthOf(wallKey));
            lastPoly = slice.lastPoly = poly;
        }
    }

    function minThinDist(np, trace) {
        return Math.min(
            Math.hypot(np.x - trace[0].x, np.y - trace[0].y),
            Math.hypot(np.x - trace.peek().x, np.y - trace.peek().y),
        );
    }

    function outputAdaptiveWalls(thin, sort) {
        // restore thin shell order annotation and sort on it
        thin.forEach((a,i) => a.shell = sort[i] * shellOrder);
        thin.forEach(t => t.shell = t.shell < 0 ? Math.abs(t.shell) + 0.5 : t.shell);
        thin.sort((a,b) => a.shell - b.shell);
        let np = print.lastPoint;
        // perform nearest poly to poly algorithm on shells
        for (;;) {
            let min = { dist: Infinity };
            for (let trace of thin) {
                if (!min.trace) {
                    min.trace = trace;
                } else if (np && min.trace.shell === trace.shell) {
                    let dist = minThinDist(np, trace);
                    if (dist < min.dist) min = { dist, trace };
                }
            }
            if (!min.trace) {
                startPoint = np;
                return;
            }
            let { trace } = min;
            let fp = trace[0];
            let lp = trace.peek();
            // reverse trace if far end closer
            if (np && Math.hypot(np.x - lp.x, np.y - lp.y) < Math.hypot(np.x - fp.x, np.y - fp.y)) {
                trace.reverse();
            }
            // remove emitted trace
            thin = thin.filter(t => t !== trace);
            // retract if moving > retractDist
            if (np && np.distTo2D(new Point(trace[0].x, trace[0].y)) > retractDist) {
                retract();
            }
            let outputSpeed = trace.shell === 1 || trace.shell === 1.5 ? finishSpeed : printSpeed;
            for (let pt of trace) {
                np = new Point(pt.x, pt.y, z);
                if (pt === trace[0]) {
                    print.addOutput(preout, np, 0, moveSpeed);
                } else {
                    print.addOutput(preout, np, ((pt.r * 2) / nozzleSize) * shellMult, outputSpeed);
                }
            }
        }
    }

    /**
     * output sparse infill
     * @param {Polygon[]} polys
     */
    // lines to iron on a top: the part of it not covered by the layer above
    // ("topmost" only irons where nothing at all is above), inset from the walls
    function ironLines(top) {
        const type = process.outputIronType;
        const above = slice.upPolys;
        if (!type || type === 'none' || !above) return;
        if (type === 'topmost' && above.length) return;
        let exposed = [ top.poly ];
        if (above.length) {
            exposed = [];
            POLY.subtract([ top.poly ], above, exposed, null, slice.z, nozzleSize * nozzleSize);
        }
        const inset = POLY.offset(exposed, -nozzleSize * 0.75, { z: slice.z });
        if (!inset?.length) return;
        return POLY.fillArea(inset, slice.index % 2 ? 45 : 135, process.outputIronSpacing || 0.15, null);
    }

    function outputSparse(polys, extrude, speed) {
        if (!polys) return;
        let proxy = polys.map((poly) => {
            return {poly: poly, first: poly.first(), last: poly.last()};
        });
        let lp = startPoint;
        startPoint = tip2tipEmit(proxy, startPoint, (el, point, count) => {
            let poly = el.poly;
            if (poly.last() === point) {
                poly.reverse();
            }
            poly.forEachPoint((p, i) => {
                let dist = lp.distTo2D(p);
                let rdst = dist > retractDist;
                let itop = rdst && requiresRetract(lp,p);
                let emit = extrude;
                // retract if dist trigger and crosses a slice top polygon
                if (i === 0) {
                    if (itop) {
                        retract();
                        emit = 0;
                    } else if (dist > nozzleSize) {
                        emit = 0;
                    }
                }
                // let emit = i === 0 ? 0 : extrude;
                // handle shallow cloned infill
                if (poly.z !== undefined) {
                    p = p.clone().setZ(poly.z);
                }
                print.addOutput(preout, p, emit, speed || printSpeed, extruder);
                lp = p;
            }, !poly.open);
            return lp;
        });
    }

    /**
     * convert cross-hatch thin-fill into lines by connecting short segment mid-points
     */
    function outputThin(lines) {
        if (!lines) {
            return;
        }
        let points = lines.group(2).map(grp => {
            let [ p1, p2 ] = grp;
            return newPoint(
                (p1.x + p2.x) / 2,
                (p1.y + p2.y) / 2,
                (p1.z + p2.z) / 2
            )
        });
        let order = util.orderClosest(points, (p1, p2) => p1.distTo2D(p2));
        if (order.length === 0) {
            return;
        }
        let first = points[0];
        let last = first;
        if (startPoint && startPoint.distTo2D(first) > thinWall && requiresRetract(startPoint, first)) {
            retract();
        }
        print.addOutput(preout, first, 0, moveSpeed, extruder);
        for (let p of order) {
            let dist = last ? last.distTo2D(p) : 0;
            if (dist > thinWall) {
                retract();
                print.addOutput(preout, p, 0, moveSpeed, extruder);
            }
            print.addOutput(preout, p, 1, gapSpeed, extruder);
            startPoint = last = p;
        }
        // close a circle
        if (last && last.distTo2D(first) <= thinWall) {
            print.addOutput(preout, first, 1, gapSpeed, extruder);
            startPoint = first;
        }
    }

    /**
     * output solid infill
     * @param {*} lines
     * @param {*} opt
     */
    function outputFills(lines, opt = {}) {
        if (!lines || lines.length === 0) {
            return;
        }
        let p, p1, p2, dist, len, found, group, mindist, t1, t2,
            marked = 0,
            start = 0,
            skip = false,
            lastIndex = -1,
            raft = opt.raft ?? false,
            flow = opt.flow || 1,
            near = opt.near ?? (antiBacklash ? false : true),
            fast = opt.fast ?? false, // support infill only!
            fill = (opt.fill >= 0 ? opt.fill : fillMult) * flow,
            thinDist = near ? thinWall : thinWall,
            bridges = opt.bridges;
        // a solid line over the air below: bridge flow, speed and fan
        const emitLine = (a, b) => {
            if (bridges && bridges.inside((a.x + b.x) / 2, (a.y + b.y) / 2)) {
                const out = print.addOutput(preout, b, fill * (outputBridgeFlow || 1), outputSpeedBridge || fillSpeed, extruder);
                if (overFan !== undefined && out) out.fan = overFan;
                return;
            }
            print.addOutput(preout, b, fill, fillSpeed, extruder);
        };

        // continue until all lines in array are "marked" as used
        while (lines && marked < lines.length) {
            group = null;
            found = false;
            mindist = Infinity;

            // use next nearest line endpoint strategy
            if (near)
            for (let i=0; i<lines.length; i += 2) {
                t1 = lines[i];
                if (t1.del) {
                    continue;
                }
                t2 = lines[i+1];
                let d1 = t1.distToSq2D(startPoint);
                let d2 = t2.distToSq2D(startPoint);
                // penalize next nearest point if it's not on an adjacent line
                let idiff = startPoint.index ? Math.abs(startPoint.index - t1.index) : 1;
                let min = Math.min(d1, d2) * (idiff !== 1 ? 10 : 1);
                if (min < mindist) {
                    if (d2 < d1) {
                        p2 = t1;
                        p1 = t2;
                    } else {
                        p1 = t1;
                        p2 = t2;
                    }
                    mindist = min;
                }
            }

            // use next line index strategy (perpendicular offset from origin)
            if (!near)
            for (let i=start; i<lines.length; i += 2) {
                p = lines[i];
                if (p.del) {
                    continue;
                }
                if (group === null && p.index > lastIndex) {
                    group = p.index;
                }
                if (group !== null) {
                    if (p.index !== group) {
                        break;
                    }
                    if (p.index % 2 === 0) {
                        t1 = lines[i];
                        t2 = lines[i+1];
                    } else {
                        t2 = lines[i];
                        t1 = lines[i+1];
                    }
                    dist = Math.min(t1.distTo2D(startPoint), t2.distTo2D(startPoint));
                    if (dist < mindist) {
                        p1 = t1;
                        p2 = t2;
                        mindist = dist;
                    }
                    start = i;
                    found = true;
                }
            }

            // go back to start and try again
            if (!near && !found) {
                if (start === 0 && lastIndex === -1) {
                    console.log('infinite loop', lines, {
                        marked, i, group, start, lastIndex,
                        points: lines.map(p => p.index).join(', ')
                    });
                    break;
                }
                start = 0;
                lastIndex = -1;
                continue;
            }

            dist = startPoint.distToSq2D(p1);
            len = p1.distToSq2D(p2);

            // go back to start when dist > retractDist
            if (!near && !fast && !skip && dist > retractDist) {
                skip = true;
                start = 0;
                lastIndex = -1;
                continue;
            }
            skip = false;

            // re-seek a new start index within fill array
            let restart = lastIndex < 0;

            // mark as used
            p1.del = true;
            p2.del = true;
            marked += 2;
            lastIndex = p1.index;

            // if dist to new segment is less than thinWall
            // and segment length is less than thinWall then
            // just extrude to midpoint of next segment. this is
            // to avoid shaking the printer to death.
            if (dist <= thinDist && len <= thinDist) {
                p2 = p1.midPointTo(p2);
                // this.addOutput(preout, p2, fill * (dist / thinWall), fillSpeed, extruder);
                print.addOutput(preout, p2, fill, fillSpeed, extruder);
            } else {
                // retract if dist trigger or crosses a slice top polygon
                if (!fast && dist > retractDist && (zhop || requiresRetract(startPoint, p1))) {
                    retract();
                }

                // anti-backlash on longer move
                if (!fast && antiBacklash && dist > retractDist) {
                    print.addOutput(preout, p1.add({x:antiBacklash,y:-antiBacklash,z:0}), 0, moveSpeed, extruder);
                }

                // bridge ends of fill when they're close together
                if (dist < thinDist) {
                    print.addOutput(preout, p1, fill, fillSpeed, extruder);
                } else if (raft && !restart) {
                    // connect raft lines unless it's a restart
                    print.addOutput(preout, p1, fill, fillSpeed, extruder);
                } else {
                    print.addOutput(preout, p1, 0, moveSpeed, extruder);
                }
                emitLine(p1, p2);
            }

            startPoint = p2;
        }

        // clear delete marks so we can re-print later
        if (lines) lines.forEach(p => { p.del = false });
    }

    /**
     * given array of polygons, emit them in next closest order with
     * the special exception that depth is considered into distance
     * so that inner polygons are emitted first.
     *
     * @param {Array} array of Polygons or Polygon wrappers (tops)
     * @param {Function} fn call to emit next candidate
     * @param {Function} fnp convert 'next' object into a Polygon for closeness
     */
    function outputOrderClosest(array, fn, fnp) {
        if (array.length === 1) {
            return fn(array[0]);
        }
        array = array.slice();
        let closest, find, next, order, poly, lastDepth = 0;
        for (;;) {
            order = [];
            closest = null;
            for (let i=0; i<array.length; i++) {
                next = array[i];
                if (!next) continue;
                poly = fnp ? fnp(next) : next;
                find = poly.findClosestPointTo(startPoint);
                order.push({
                    i: i,
                    n: next,
                    d: find.distance - (poly.depth * thinWall),
                });
            }
            if (order.length === 0) {
                return;
            }
            // when previous top is under a certain length
            // seek furthest top on layer switch
            if (switchTop) {
                switchTop = false;
                order.sort((a,b) => {
                    return b.d - a.d;
                });
            } else {
                order.sort((a,b) => {
                    return a.d - b.d;
                });
            }
            array[order[0].i] = null;
            fn(order[0].n);
        }
    }

    let out = [];
    if (slice.tops) {
        out.appendAll(slice.tops);
    }
    if (slice.supports && slice.widget.support) {
        out.appendAll(slice.supports);
    }

    let lastTop = null;
    outputOrderClosest(out, function(next) {
        if (next instanceof Polygon) {
            print.setType('support');
            // support polygon
            next.setZ(z);
            const saved = [ printSpeed, finishSpeed, fillSpeed ];
            if (featureSpeeds && outputSpeedSupport) printSpeed = finishSpeed = fillSpeed = outputSpeedSupport;
            if (process.sliceSupportOutline !== false) {
                outputTraces([next].appendAll(next.inner || []));
            }
            if (next.fill) {
                next.fill.forEach(p => { p.z = z });
                outputFills(next.fill, {fast: true, near: true});
            }
            [ printSpeed, finishSpeed, fillSpeed ] = saved;
        } else {
            // solid infill
            let top = next;
            let isRaft = top.isRaft;

            print.setType('shells');
            if (lastTop && lastTop !== next) {
                retract();
            }

            // control of layer start point (aligned / back apply to every island)
            if (!lastTop || process.sliceLayerStart === 'aligned' || process.sliceLayerStart === 'back')
            switch (process.sliceLayerStart) {
                case "spiral": {
                    let center = top.poly.bounds.center();
                    let angle = (Math.PI * 2) * (slice.z / print.zmax);
                    let x = center.x + Math.cos(angle)*10000;
                    let y = center.y + Math.sin(angle)*10000;
                    startPoint = newPoint(x,y,startPoint.z);
                    } break;
                case "last":
                    break;
                case "random":
                    let bounds = top.poly.bounds;
                    let center = bounds.center();
                    let radius = Math.max(bounds.width(), bounds.height());
                    let angle = Math.random()*Math.PI*2;
                    let x = center.x + Math.cos(angle)*radius;
                    let y = center.y + Math.sin(angle)*radius;
                    startPoint = newPoint(x,y,startPoint.z);
                    break;
                case "center":
                    startPoint = newPoint(0,0,startPoint.z);
                    break;
                case "back": {
                    // seam at the back (+Y) of each island
                    let center = top.poly.bounds.center();
                    startPoint = newPoint(center.x, center.y + 10000, startPoint.z);
                    } break;
                case "aligned": {
                    // seam in one fixed direction (rear left) so it stacks into a line
                    let center = top.poly.bounds.center();
                    startPoint = newPoint(center.x - 10000, center.y + 10000, startPoint.z);
                    } break;
                case "origin":
                    startPoint = newPoint(-bedOffset.x, -bedOffset.y, startPoint.z);
                    break;
                case "position":
                    startPoint = newPoint(-bedOffset.x+process.sliceLayerStartX, -bedOffset.y+process.sliceLayerStartY, startPoint.z);
                    break;
            }

            // optimize start point on belt for tops touching belt
            // and enforce optimal shell order (outer first)
            if (isBelt && opt.onBelt) {
                startPoint = startClone;
                if (beltFirst) {
                    shellOrder = -1;
                }
            }

            // raft
            if (top.traces) outputTraces(top.traces);

            // thin wall v3
            if (top.thin_wall) outputAdaptiveWalls(top.thin_wall, top.thin_sort);

            // innermost shells
            let inner = next.innerShells() || [];
            let shells = next.shells || [];

            // alternating winding option
            // if (process.outputAlternating || slice.index % 2) {
            //     console.log({alternating: slice, shells, inner});
            //     POLY.setWinding(inner, false);
            //     POLY.setWinding(shells, false);
            // }

            // output inner polygons
            if (shellOrder > 0) outputTraces(inner, { sort: shellOrder, shell: true });

            outputTraces(shells, { sort: shellOrder, shell: true });

            // output outer polygons
            if (shellOrder < 0) outputTraces(inner, { sort: shellOrder, shell: true });

            // output thin fill
            print.setType('thin fill');
            outputThin(next.thin_fill);

            // then output solid and sparse fill
            print.setType('solid fill');
            // monotonic (Orca): top surfaces line by line across the area in
            // one order, not hopping to the nearest end, so the lines lie evenly
            const monotonic = process.outputMonotonic && !isRaft && !firstLayer &&
                (slice.isFlatsLayer || !slice.up);
            outputFills(next.fill_lines, { flow: isRaft ? 1 : widthMult('sliceLineWidthSolid'), raft: isRaft,
                bridges: isRaft ? null : bridgeProbe, near: monotonic ? false : undefined });

            print.setType('sparse infill');
            outputSparse(next.fill_sparse, sparseMult * widthMult('sliceLineWidthSparse'), infillSpeed);

            // ironing: a low flow pass over the island's exposed top surface
            let iron = !firstLayer && !isRaft && ironLines(next);
            if (iron?.length) {
                print.setType('ironing');
                let saveSpeed = fillSpeed;
                fillSpeed = process.outputIronSpeed || fillSpeed;
                outputFills(iron, { fill: process.outputIronFlow ?? 0.1 });
                fillSpeed = saveSpeed;
            }

            lastTop = next;
        }
    }, function(obj) {
        // for tops, return the wrapped poly
        return obj instanceof Polygon ? obj : obj.poly;
    });

    // produce polishing paths when present
    if (slice.tops && slice.tops.length && slice.tops[0].polish) {
        let {x,y} = slice.tops[0].polish;
        if (x) {
            outputSparse(x, 0, process.polishSpeed);
        }
        if (y) {
            outputSparse(y, 0, process.polishSpeed);
        }
    }

    // adjust layer output speeds (by slowing them down)
    // if layer print time is less than minimum (required for cooling)
    let lp, td = 0, tt = 0;
    for (let p of preout) {
        if (!p.emit) continue;
        let mms = p.speed ?? 1;
        let dst = lp?.distTo2D(p.point) ?? 0;
        lp = p.point;
        if (dst) {
            tt += (dst/mms);
            td += dst;
            p.dst = dst;
        }
    }
    if (minLayerTime && tt < minLayerTime) {
        let fact = tt / minLayerTime;
        for (let p of preout) {
            if (p.emit) {
                p.speed = Math.max(p.speed * fact, minSpeed);
            }
        }
    }

    // apply speed damping when output exceeds volumetric flowrate cap
    if (maxFlowRate) {
        for (let p of preout) {
            if (p.emit && p.dst) {
                let vfr = nozzles[p.tool] * slice.height * p.speed;
                if (vfr > maxFlowRate) {
                    let old = p.speed;
                    let damp = maxFlowRate / vfr;
                    p.speed = p.speed * damp;
                    // console.log({ vfr, damp, old, new: p.speed });
                }
            }
        }
    }

    // offset print points
    for (let i=0; i<preout.length; i++) {
        preout[i].point = preout[i].point.add(offset);
    }

    // add offset points to total print
    print.addPrintPoints(preout, output);

    // (Kiri used to drop the fan to a third on bridge layers; bridges now get
    // the overhang fan per line, as in Orca)

    // create next layer start point and annotate
    // with print time for previous layer (hack to
    // avoid changing return signature rn)
    let newStart = startPoint.add(offset);
    newStart.layer_time = Math.max(tt, minLayerTime);
    return newStart;
}
