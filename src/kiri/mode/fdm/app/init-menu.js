/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { api } from '../../../app/api.js';

let LANG = api.language.current;
let { FDM } = api.const.MODES,
    { $ } = api.web,
    { uc, ui } = api,
    { bound, toInt, toFloat } = uc,
    { newBlank, newButton, newBoolean, newGroup, newInput, newSelect, newRow } = uc,
    driven = true,
    hideable = true,
    separator = true,
    trigger = true
    ;

function onBooleanClick(el) {
    api.event.emit('click.boolean', el);
}

function onButtonClick(el) {
    api.event.emit('click.button', el);
}

function thinWallSave() {
    let opt = ui.sliceDetectThin;
    let level = opt.options[opt.selectedIndex];
    if (level) {
        api.conf.get().process.sliceDetectThin = level.value;
        api.conf.save();
    }
}

function isMultiHead() {
    let dev = api.conf.get().device;
    return isNotBelt() && dev.extruders && dev.extruders.length > 1;
}

function optSelected(sel) {
    let opt = sel.options[sel.selectedIndex];
    return opt ? opt.value : undefined;
}

function manualSupport() {
    return api.conf.proc().sliceSupportType === 'manual';
}

function hasInfill() {
    return optSelected(ui.sliceFillType) !== 'none'
}

function fillIsLinear() {
    return hasInfill() && optSelected(ui.sliceFillType) === 'linear';
}

function zIntShow() {
    return api.conf.get().controller.devel;
}

function isBelt() {
    return api.device.isBelt();
}

function isNotBelt() {
    return !isBelt();
}

function isTree() {
    return [ 'tree', 'organic' ].includes(api.conf.proc().sliceSupportType);
}

function notFwRetract() {
    return !api.conf.get().device.fwRetract;
}

export function menu() {

    return {

    /** Left Side Menu */

    _____:               newGroup(LANG.sl_menu, $('fdm-layers'), { modes:FDM, driven, hideable, separator, group:"fdm-layers" }),
    sliceHeight:         newInput(LANG.sl_lahi_s, { title:LANG.sl_lahi_l, convert:toFloat }),
    sliceMinHeight:      newInput(LANG.ad_minl_s, { title:LANG.ad_minl_l, convert:toFloat, bound:bound(0,3.0), show:() => ui.sliceAdaptive.checked }),
    sliceTopLayers:      newInput(LANG.sl_ltop_s, { title:LANG.sl_ltop_l, convert:toInt }),
    sliceBottomLayers:   newInput(LANG.sl_lbot_s, { title:LANG.sl_lbot_l, convert:toInt }),
    sliceTopThickness:   newInput(LANG.sl_ttop_s, { title:LANG.sl_ttop_l, convert:toFloat, bound:bound(0,20) }),
    sliceBottomThickness:newInput(LANG.sl_tbot_s, { title:LANG.sl_tbot_l, convert:toFloat, bound:bound(0,20) }),
    sliceVerticalShells: newBoolean(LANG.sl_vsh_s, onBooleanClick, { title:LANG.sl_vsh_l }),
    sliceOneWallTop:     newBoolean(LANG.sl_owt_s, onBooleanClick, { title:LANG.sl_owt_l }),
    outputMonotonic:     newBoolean(LANG.sl_mono_s, onBooleanClick, { title:LANG.sl_mono_l }),
    separator:           newBlank({ class:"set-sep", driven }),
    sliceAdaptive:       newBoolean(LANG.ad_adap_s, onBooleanClick, { title: LANG.ad_adap_l }),
    outputLayerRetract:  newBoolean(LANG.ad_lret_s, onBooleanClick, {title:LANG.ad_lret_l}),
    sliceLayerStart:     newSelect(LANG.sl_strt_s, {title:LANG.sl_strt_l}, "start"),
    _____:               newGroup(LANG.sw_menu, $('fdm-walls'), { modes:FDM, driven, hideable, separator, group:"fdm-walls" }),
    sliceShells:         newInput(LANG.sl_shel_s, { title:LANG.sl_shel_l, convert:toFloat }),
    sliceLineWidth:      newInput(LANG.sl_line_s, { title:LANG.sl_line_l, convert:toFloat, bound:bound(0,5) }),
    sliceLineWidthOuter: newInput(LANG.sl_lwou_s, { title:LANG.sl_lwft_l, convert:toFloat, bound:bound(0,5) }),
    sliceLineWidthInner: newInput(LANG.sl_lwin_s, { title:LANG.sl_lwft_l, convert:toFloat, bound:bound(0,5) }),
    sliceLineWidthSolid: newInput(LANG.sl_lwso_s, { title:LANG.sl_lwft_l, convert:toFloat, bound:bound(0,5) }),
    sliceLineWidthSparse:newInput(LANG.sl_lwsp_s, { title:LANG.sl_lwft_l, convert:toFloat, bound:bound(0,5) }),
    sliceLineWidthFirst: newInput(LANG.sl_lwfi_s, { title:LANG.sl_lwft_l, convert:toFloat, bound:bound(0,5) }),
    sliceFillOverlap:    newInput(LANG.fi_over_s, {title:LANG.fi_over_l, convert:toFloat, bound:bound(0.0,1.0)}),
    separator:           newBlank({ class:"set-sep", driven }),
    sliceShellOrder:     newSelect(LANG.sl_ordr_s, { title:LANG.sl_ordr_l}, "shell"),
    sliceDetectThin:     newSelect(LANG.ad_thin_s, { title: LANG.ad_thin_l, action: thinWallSave }, "thin"),
    outputAlternating:   newBoolean(LANG.ad_altr_s, onBooleanClick, {title:LANG.ad_altr_l}),
    sliceZInterleave:    newBoolean(LANG.ad_zint_s, onBooleanClick, {title:LANG.ad_zint_l, show:() => zIntShow() }),
    _____:               newGroup(LANG.fs_menu, $('fdm-solid'), { modes:FDM, driven, hideable, separator, group:"fdm-solid" }),
    sliceFillAngle:      newInput(LANG.fi_angl_s, {title:LANG.fi_angl_l, convert:toFloat}),
    sliceFillGrow:       newInput(LANG.fi_grow_s, {title:LANG.fi_grow_l, convert:toFloat}),
    sliceSolidMinArea:   newInput(LANG.ad_msol_s, {title:LANG.ad_msol_l, convert:toFloat}),
    sliceSolidMinThick:  newInput(LANG.ad_mthk_s, {title:LANG.ad_mthk_l, convert:toFloat}),
    _____:               newGroup(LANG.fi_menu, $('fdm-fill'), { modes:FDM, driven, hideable, separator, group:"fdm-fill" }),
    sliceFillType:       newSelect(LANG.fi_type, {trigger}, "infill"),
    sliceFillSparse:     newInput(LANG.fi_pcnt_s, {title:LANG.fi_pcnt_l, convert:toFloat, bound:bound(0.0,1.0), show:hasInfill}),
    sliceFillRepeat:     newInput(LANG.fi_rept_s, {title:LANG.fi_rept_l, convert:toInt,   bound:bound(1,10),    show:fillIsLinear}),
    _____:               newGroup(LANG.fh_menu, $('fdm-heat'), { modes:FDM, driven, hideable, separator, group:"fdm-heat" }),
    outputTemp:          newInput(LANG.ou_nozl_s, {title:LANG.ou_nozl_l, convert:toInt}),
    outputBedTemp:       newInput(LANG.ou_bedd_s, {title:LANG.ou_bedd_l, convert:toInt}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputDraftShield:   newBoolean(LANG.fr_draf_s, onBooleanClick, {title:LANG.fr_draf_l, trigger, show:() => isNotBelt()}),
    _____:               newGroup(LANG.fc_menu, $('fdm-cool'), { modes:FDM, driven, hideable, separator, group:"fdm-cool" }),
    outputFanLayer:      newInput(LANG.ou_fanl_s, { title:LANG.ou_fanl_l, convert:toInt,   bound:bound(0,255) }),
    outputFanSpeed:      newInput(LANG.ou_fans_s, {title:LANG.ou_fans_l, convert:toInt, bound:bound(0,255)}),
    outputMinLayerTime:  newInput(LANG.ou_layt_s, { title:LANG.ou_layt_l, convert:toInt,   bound:bound(0,200) }),
    outputFanMin:        newInput(LANG.ou_fmin_s, { title:LANG.ou_fmin_l, convert:toInt,   bound:bound(0,100) }),
    outputFanLayerTime:  newInput(LANG.ou_fcol_s, { title:LANG.ou_fcol_l, convert:toInt,   bound:bound(0,1000) }),
    outputOverhangFan:   newInput(LANG.ou_fovr_s, { title:LANG.ou_fovr_l, convert:toInt,   bound:bound(-1,100) }),
    outputOverhangFanThreshold: newInput(LANG.ou_fovt_s, { title:LANG.ou_fovt_l, convert:toFloat, bound:bound(0,1) }),
    _____:               newGroup(LANG.sp_menu, $('fdm-support'), { modes:FDM, driven, hideable, separator, group:"fdm-supp" }),
    sliceSupportType:    newSelect(LANG.sp_type_s, {title:LANG.sp_type_l, trigger}, "support"),
    sliceSupportNozzle:  newSelect(LANG.sp_nozl_s, {title:LANG.sp_nozl_l, show:isMultiHead}, "extruders"),
    separator:           newBlank({ class:"set-sep", driven }),
    sliceSupportAngle:   newInput(LANG.sp_angl_s, {title:LANG.sp_angl_l, convert:toFloat, bound:bound(0.0,90.0)}),
    sliceSupportDensity: newInput(LANG.sp_dens_s, {title:LANG.sp_dens_l, convert:toFloat, bound:bound(0.0,1.0)}),
    sliceSupportOffset:  newInput(LANG.sp_offs_s, {title:LANG.sp_offs_l, convert:toFloat, bound:bound(0.0,200.0)}),
    sliceSupportExtra:   newInput(LANG.sp_xpnd_s, {title:LANG.sp_xpnd_l, convert:toFloat, bound:bound(0.0,10.0)}),
    // sliceSupportSpan:    newInput(LANG.sp_span_s, {title:LANG.sp_span_l, convert:toFloat, bound:bound(0.0,200.0), show:() => ui.sliceSupportEnable.checked }),
    separator:           newBlank({ class:"set-sep", driven }),
    sliceSupportOutline: newBoolean(LANG.sp_outl_s, onBooleanClick, {title:LANG.sp_outl_l, xshow: () => !isTree() }),
    sliceSupportGapTop:  newInput(LANG.sp_gtop_s, {title:LANG.sp_gtop_l, convert:toFloat, bound:bound(0.0,5.0)}),
    sliceSupportInterface: newInput(LANG.sp_ifly_s, {title:LANG.sp_ifly_l, convert:toInt, bound:bound(0,20)}),
    sliceSupportInterfaceDensity: newInput(LANG.sp_ifdn_s, {title:LANG.sp_ifdn_l, convert:toFloat, bound:bound(0.05,1.0)}),
    sliceSupportGapBottom: newInput(LANG.sp_gbot_s, {title:LANG.sp_gbot_l, convert:toFloat, bound:bound(0.0,5.0)}),
    sliceSupportTreeAngle:   newInput(LANG.sp_tran_s, {title:LANG.sp_tran_l, convert:toFloat, bound:bound(5.0,75.0), show:isTree}),
    sliceSupportTreeTip:     newInput(LANG.sp_trtp_s, {title:LANG.sp_trtp_l, convert:toFloat, bound:bound(0.4,10.0), show:isTree}),
    sliceSupportTreeBranch:  newInput(LANG.sp_trbr_s, {title:LANG.sp_trbr_l, convert:toFloat, bound:bound(0.4,30.0), show:isTree}),
    sliceSupportTreeGrow:    newInput(LANG.sp_trgr_s, {title:LANG.sp_trgr_l, convert:toFloat, bound:bound(0.0,30.0), show:isTree}),
    sliceSupportTreeSpacing: newInput(LANG.sp_trsp_s, {title:LANG.sp_trsp_l, convert:toFloat, bound:bound(1.0,50.0), show:isTree}),
    sliceSupportBrim:    newInput(LANG.sp_trbm_s, {title:LANG.sp_trbm_l, convert:toFloat, bound:bound(0.0,20.0), show:isTree}),
    separator:           newBlank({ class:"set-sep", driven, show:manualSupport }),
    sliceSupportManual: newRow([
        (ui.ssmAdd = newButton(undefined, onButtonClick, {icon:'<i class="fas fa-plus"></i>'})),
        (ui.ssmDel = newButton(undefined, onButtonClick, {icon:'<i class="fas fa-minus"></i>'})),
        (ui.ssmClr = newButton(undefined, onButtonClick, {icon:'<i class="fas fa-trash-alt"></i>'}))
    ], {class:"ext-buttons f-row", show:manualSupport}),
    _____:               newGroup(LANG.fl_menu, $('fdm-base'), { modes:FDM, driven, hideable, separator, group:"fdm-base" }),
    firstSliceHeight:    newInput(LANG.fl_lahi_s, {title:LANG.fl_lahi_l, convert:toFloat, show:isNotBelt}),
    firstLayerNozzleTemp:newInput(LANG.fl_nozl_s, {title:LANG.fl_nozl_l, convert:toInt,   show:isNotBelt}),
    firstLayerBedTemp:   newInput(LANG.fl_bedd_s, {title:LANG.fl_bedd_l, convert:toInt,   show:isNotBelt}),
    firstLayerElephant:  newInput(LANG.fl_elef_s, {title:LANG.fl_elef_l, convert:toFloat, bound:bound(0,2), show:isNotBelt}),
    separator:           newBlank({ class:"set-sep", driven }),
    firstLayerFanSpeed:  newInput(LANG.ou_fans_s, {title:LANG.ou_fans_l, convert:toInt,   bound:bound(0,255), show:isBelt}),
    firstLayerYOffset:   newInput(LANG.fl_zoff_s, {title:LANG.fl_zoff_l, convert:toFloat, show:isBelt}),
    firstLayerFlatten:   newInput(LANG.fl_flat_s, {title:LANG.fl_flat_l, convert:toFloat, show:isBelt}),
    firstLayerBeltFact:  newInput(LANG.fl_mult_s, {title:LANG.fl_mult_l, convert:toFloat, bound:bound(0, 2), show:isBelt}),
    firstLayerRate:      newInput(LANG.fl_rate_s, {title:LANG.fl_rate_l, convert:toFloat}),
    firstLayerFillRate:  newInput(LANG.fl_frat_s, {title:LANG.fl_frat_l, convert:toFloat, show:isNotBelt}),
    separator:           newBlank({ class:"set-sep", driven, show:isBelt }),
    firstLayerBrim:      newInput(LANG.fl_brim_s, {title:LANG.fl_brim_l, convert:toInt,   show:isBelt}),
    firstLayerBrimIn:    newInput(LANG.fl_brin_s, {title:LANG.fl_brin_l, convert:toInt,   show:isBelt}),
    firstLayerBrimTrig:  newInput(LANG.fl_brmn_s, {title:LANG.fl_brmn_l, convert:toInt,   show:isBelt}),
    firstLayerBrimGap:   newInput(LANG.fl_brgp_s, {title:LANG.fl_brgp_l, convert:toFloat, show:isBelt}),
    separator:           newBlank({ class:"set-sep", driven, show:isBelt }),
    firstLayerBeltLead:  newInput(LANG.fl_bled_s, {title:LANG.fl_bled_l, convert:toFloat, show:isBelt}),
    firstLayerBeltBump:  newInput(LANG.fl_blmp_s, {title:LANG.fl_blmp_l, convert:toFloat, bound:bound(0, 10), show:isBelt}),
    separator:           newBlank({ class:"set-sep", driven, show:isNotBelt }),
    outputBrimCount:     newInput(LANG.fl_skrt_s, {title:LANG.fl_skrt_l, convert:toInt,   show:isNotBelt}),
    outputBrimOffset:    newInput(LANG.fl_skro_s, {title:LANG.fl_skro_l, convert:toFloat, show:isNotBelt}),
    outputRaftSpacing:   newInput(LANG.fr_spac_s, {title:LANG.fr_spac_l, convert:toFloat, bound:bound(0.0,3.0), show:() => ui.outputRaft.checked && isNotBelt() }),
    separator:           newBlank({ class:"set-sep", driven, show:isNotBelt }),
    outputRaft:          newBoolean(LANG.fr_nabl_s, onBooleanClick, {title:LANG.fr_nabl_l, trigger, show:() => isNotBelt()}),
    _____:               newGroup(LANG.ou_menu, $('fdm-output'), { modes:FDM, driven, hideable, separator, group:"fdm-out" }),
    outputFeedrate:      newInput(LANG.ou_feed_s, {title:LANG.ou_feed_l, convert:toInt}),
    outputFinishrate:    newInput(LANG.ou_fini_s, {title:LANG.ou_fini_l, convert:toInt}),
    outputSeekrate:      newInput(LANG.ou_move_s, {title:LANG.ou_move_l, convert:toInt}),
    outputSpeedTop:      newInput(LANG.ou_stop_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedSolid:    newInput(LANG.ou_ssol_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedSparse:   newInput(LANG.ou_sspa_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedBridge:   newInput(LANG.ou_sbri_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedGap:      newInput(LANG.ou_sgap_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedSupport:  newInput(LANG.ou_ssup_s, {title:LANG.ou_sfeat_l, convert:toInt}),
    outputSpeedSmall:    newInput(LANG.ou_ssma_s, {title:LANG.ou_ssma_l, convert:toInt}),
    outputSmallRadius:   newInput(LANG.ou_srad_s, {title:LANG.ou_ssma_l, convert:toFloat, bound:bound(0,50)}),
    outputSpeedOver1:    newInput(LANG.ou_sov1_s, {title:LANG.ou_sovr_l, convert:toInt}),
    outputSpeedOver2:    newInput(LANG.ou_sov2_s, {title:LANG.ou_sovr_l, convert:toInt}),
    outputSpeedOver3:    newInput(LANG.ou_sov3_s, {title:LANG.ou_sovr_l, convert:toInt}),
    outputSpeedOver4:    newInput(LANG.ou_sov4_s, {title:LANG.ou_sovr_l, convert:toInt}),
    outputBridgeFlow:    newInput(LANG.ou_bflo_s, {title:LANG.ou_bflo_l, convert:toFloat, bound:bound(0.1,3)}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputFuzzyThickness:newInput(LANG.ou_fzth_s, {title:LANG.ou_fzth_l, convert:toFloat, bound:bound(0,2)}),
    outputFuzzyDistance: newInput(LANG.ou_fzdi_s, {title:LANG.ou_fzth_l, convert:toFloat, bound:bound(0.1,5), show:() => ui.outputFuzzyThickness?.value > 0}),
    outputFuzzyAll:      newBoolean(LANG.ou_fzal_s, onBooleanClick, {title:LANG.ou_fzth_l, show:() => ui.outputFuzzyThickness?.value > 0}),
    outputFuzzyFirst:    newBoolean(LANG.ou_fzfi_s, onBooleanClick, {title:LANG.ou_fzth_l, show:() => ui.outputFuzzyThickness?.value > 0}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputShellMult:     newInput(LANG.ou_shml_s, {title:LANG.ou_exml_l, convert:toFloat, bound:bound(0.0,2.0)}),
    outputFillMult:      newInput(LANG.ou_flml_s, {title:LANG.ou_exml_l, convert:toFloat, bound:bound(0.0,2.0)}),
    outputSparseMult:    newInput(LANG.ou_spml_s, {title:LANG.ou_exml_l, convert:toFloat, bound:bound(0.0,2.0)}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputRetractDist:   newInput(LANG.ad_rdst_s, {title:LANG.ad_rdst_l, convert:toFloat, show:notFwRetract}),
    outputRetractSpeed:  newInput(LANG.ad_rrat_s, {title:LANG.ad_rrat_l, convert:toInt,   show:notFwRetract}),
    outputRetractWipe:   newInput(LANG.ad_wpln_s, {title:LANG.ad_wpln_l, convert:toFloat, bound:bound(0.0,10)}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputAccel:         newInput("accel default", {title:["default acceleration in mm/s²","0 = machine setting"], convert:toInt, bound:bound(0,100000)}),
    outputAccelOuter:    newInput("accel outer wall", {title:["outer wall acceleration in mm/s²","0 = use default"], convert:toInt, bound:bound(0,100000)}),
    outputAccelInner:    newInput("accel inner wall", {title:["inner wall acceleration in mm/s²","0 = use default"], convert:toInt, bound:bound(0,100000)}),
    outputAccelFill:     newInput("accel infill", {title:["sparse and solid infill acceleration","in mm/s², 0 = use default"], convert:toInt, bound:bound(0,100000)}),
    outputAccelTop:      newInput("accel top surface", {title:["top surface acceleration in mm/s²","0 = use default"], convert:toInt, bound:bound(0,100000)}),
    outputAccelTravel:   newInput("accel travel", {title:["travel acceleration in mm/s²","0 = use default"], convert:toInt, bound:bound(0,100000)}),
    outputAccelFirst:    newInput("accel first layer", {title:["first layer acceleration in mm/s²","overrides the others on layer 1","0 = off"], convert:toInt, bound:bound(0,100000)}),
    separator:           newBlank({ class:"set-sep", driven }),
    outputIronType:      newSelect("ironing", {title:["iron top surfaces: a second pass","with very little flow to smooth them","top = every top surface","topmost = only the highest"], trigger}, "iron"),
    outputIronFlow:      newInput("ironing flow", {title:["ironing flow as a fraction","of a normal line, e.g. 0.1"], convert:toFloat, bound:bound(0,1), show:() => ui.outputIronType && optSelected(ui.outputIronType) !== 'none'}),
    outputIronSpacing:   newInput("ironing spacing", {title:["distance between ironing lines in mm"], convert:toFloat, bound:bound(0.05,1), show:() => ui.outputIronType && optSelected(ui.outputIronType) !== 'none'}),
    outputIronSpeed:     newInput("ironing speed", {title:["ironing speed in mm/s"], convert:toInt, bound:bound(1,300), show:() => ui.outputIronType && optSelected(ui.outputIronType) !== 'none'}),
    separator:           newBlank({ class:"set-sep", driven }),
    fdmArcEnabled:       newBoolean(LANG.cx_arce_s, onBooleanClick, { title:LANG.cx_arce_l }),
    fdmArcTolerance:     newInput(LANG.cx_arct_s, {title:LANG.cx_arct_l, convert:toFloat, bound:bound(0,100), trigger, show:() => ui.fdmArcEnabled.checked}),
    fdmArcResolution:    newInput(LANG.cx_arcr_s, {title:LANG.cx_arcr_l, convert:toFloat, bound:bound(0,180), trigger, show:() => ui.fdmArcEnabled.checked}),
    separator:           newBlank({ class:"set-sep", driven, show:() => ui.fdmArcEnabled.checked}),
    outputAvoidGaps:     newBoolean(LANG.ad_agap_s, onBooleanClick, {title:LANG.ad_agap_l}),
    sliceSolidify:       newBoolean(LANG.ad_sold_s, onBooleanClick, {title:LANG.ad_sold_l}),
    separator:           newBlank({ class:"set-sep", driven, show:isBelt }),
    outputBeltFirst:     newBoolean(LANG.ad_lbir_s, onBooleanClick, {title:LANG.ad_lbir_l, show:isBelt}),
    _____:               newGroup(LANG.ad_menu, $('fdm-expert'), { modes:FDM, driven, hideable, separator, group:"fdm-xprt" }),
    sliceAngle:          newInput(LANG.sl_angl_s, {title:LANG.sl_angl_l, convert:toFloat, show:isBelt}),
    antiBacklash:        newInput(LANG.ad_abkl_s, {title:LANG.ad_abkl_l, convert:toFloat, bound:bound(0,3)}),
    outputRetractDwell:  newInput(LANG.ad_rdwl_s, {title:LANG.ad_rdwl_l, convert:toInt}),
    outputMinSpeed:      newInput(LANG.ad_mins_s, {title:LANG.ad_mins_l, convert:toFloat, bound:bound(1,200)}),
    outputMaxFlowrate:   newInput(LANG.ad_maxf_s, {title:LANG.ad_maxf_l, convert:toFloat, bound:bound(1,200)}),
    outputPurgeTower:    newInput(LANG.ad_purg_s, {title:LANG.ad_purg_l, convert:toInt,   bound:bound(0,1000)}),
    outputScarfLength:   newInput(LANG.ad_scar_s, {title:LANG.ad_scar_l, convert:toFloat, bound:bound(0,1000)}),
    outputShortPoly:     newInput(LANG.ad_spol_s, {title:LANG.ad_spol_l, convert:toFloat, bound:bound(0,10000)}),
    outputCoastDist:     newInput(LANG.ad_scst_s, {title:LANG.ad_scst_l, convert:toFloat, bound:bound(0.0,10)}),
    sliceCompInner:      newInput(LANG.sl_ofin_s, {title:LANG.sl_ofin_l, convert:toFloat, bound:bound(-10.0,10.0)}),
    sliceCompOuter:      newInput(LANG.sl_ofot_s, {title:LANG.sl_ofot_l, convert:toFloat, bound:bound(-10.0,10.0)}),
    zHopDistance:        newInput(LANG.ad_zhop_s, {title:LANG.ad_zhop_l, convert:toFloat, bound:bound(0,3.0)}),
    outputLoops:         newInput(LANG.ag_loop_s, {title:LANG.ag_loop_l, convert:toInt,   bound:bound(-1,1000), show:isBelt}),

    fdmRanges:    $('fdm-ranges'),

    };
}
