import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {type ColorMode} from '../gl/color_mode';
import {
    fillUniformValues,
    fillPatternUniformValues,
    fillOutlineUniformValues,
    fillOutlinePatternUniformValues
} from './program/fill_program';

import type {Painter, RenderOptions} from './painter';
import type {SourceCache} from '../source/source_cache';
import type {FillStyleLayer} from '../style/style_layer/fill_style_layer';
import type {FillBucket} from '../data/bucket/fill_bucket';
import type {OverscaledTileID} from '../source/tile_id';
import {updatePatternPositionsInProgram} from './update_pattern_positions_in_program';
import {translatePosition} from '../util/util';

import type {RenderPass as LumaPass} from '@luma.gl/core';

export function drawFillLuma(painter: Painter, sourceCache: SourceCache, layer: FillStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions, renderPass: LumaPass) {
    const color = layer.paint.get('fill-color');
    const opacity = layer.paint.get('fill-opacity');

    if (opacity.constantOr(1) === 0) {
        return;
    }

    const {isRenderingToTexture} = renderOptions;
    const colorMode = painter.colorModeForRenderPass();
    const pattern = layer.paint.get('fill-pattern');
    const pass = painter.opaquePassEnabledForLayer() &&
        (!pattern.constantOr(1 as any) &&
            color.constantOr(Color.transparent).a === 1 &&
            opacity.constantOr(0) === 1) ? 'opaque' : 'translucent';
    
    // Draw fill
    if (painter.renderPass === pass) {
        const depthMode = painter.getDepthModeForSublayer(
            1, painter.renderPass === 'opaque' ? DepthMode.ReadWrite : DepthMode.ReadOnly);
        drawFillTilesLuma(painter, sourceCache, layer, coords, depthMode, colorMode, false, isRenderingToTexture, renderOptions, renderPass);
    }

    // Draw stroke
    if (painter.renderPass === 'translucent' && layer.paint.get('fill-antialias')) {

        // If we defined a different color for the fill outline, we are
        // going to ignore the bits in 0x07 and just care about the global
        // clipping mask.
        // Otherwise, we only want to drawFill the antialiased parts that are
        // *outside* the current shape. This is important in case the fill
        // or stroke color is translucent. If we wouldn't clip to outside
        // the current shape, some pixels from the outline stroke overlapped
        // the (non-antialiased) fill.
        const depthMode = painter.getDepthModeForSublayer(
            layer.getPaintProperty('fill-outline-color') ? 2 : 0, DepthMode.ReadOnly);
        drawFillTilesLuma(painter, sourceCache, layer, coords, depthMode, colorMode, true, isRenderingToTexture, renderOptions, renderPass);
    }
}

function drawFillTilesLuma(
    painter: Painter,
    sourceCache: SourceCache,
    layer: FillStyleLayer,
    coords: Array<OverscaledTileID>,
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    isOutline: boolean,
    isRenderingToTexture: boolean,
    renderOptions: RenderOptions,
    renderPass: LumaPass) {
    const gl = painter.context.gl;
    const fillPropertyName = 'fill-pattern';
    const patternProperty = layer.paint.get(fillPropertyName);
    const image = patternProperty && patternProperty.constantOr(1 as any);
    const crossfade = layer.getCrossfadeParameters();
    let drawMode, programName, segments;

    const transform = painter.transform;

    const propertyFillTranslate = layer.paint.get('fill-translate');
    const propertyFillTranslateAnchor = layer.paint.get('fill-translate-anchor');

    if (!isOutline) {
        programName = image ? 'luma_fillPattern' : 'luma_fill';
        drawMode = 'triangle-list';
    } else {
        programName = image && !layer.getPaintProperty('fill-outline-color') ? 'luma_fillOutlinePattern' : 'luma_fillOutline';
        drawMode = 'lines';
    }

    if (isOutline || image) {
        return; // TODO
    }

    const constantPattern = patternProperty.constantOr(null);

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        if (image && !tile.patternsLoaded()) continue;

        const bucket: FillBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram(programName, programConfiguration, null, null, true);
        const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(coord);

        if (image) {
            painter.context.activeTexture.set(gl.TEXTURE0);
            tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(painter.context, crossfade);
        }

        updatePatternPositionsInProgram(programConfiguration, fillPropertyName, constantPattern, tile, layer);

        const translateForUniforms = translatePosition(transform, tile, propertyFillTranslate, propertyFillTranslateAnchor);

        if (!isOutline) {
            segments = bucket.segments;
            //uniformValues = image ? fillPatternUniformValues(painter, crossfade, tile, translateForUniforms) : fillUniformValues(translateForUniforms);
        } else {
            segments = bucket.segments2;
            //const drawingBufferSize = [gl.drawingBufferWidth, gl.drawingBufferHeight] as [number, number];
           /* uniformValues = (programName === 'fillOutlinePattern' && image) ?
                fillOutlinePatternUniformValues(painter, crossfade, tile, drawingBufferSize, translateForUniforms) :
                fillOutlineUniformValues(drawingBufferSize, translateForUniforms);*/
        }

        const stencil = painter.stencilModeForClipping(coord); // TODO

        const renderData = bucket.getOrCreateRenderData(painter, layer, program, isOutline, image && true);
        renderData.updateBuffers(painter, layer, bucket);
        renderData.pipeline.setBindings({
            'ProjectionParameterUBO': painter.getProjectionParameterBuffer(coord, {
                isRenderingGlobe: renderOptions.isRenderingGlobe, isRenderingToTexture: renderOptions.isRenderingToTexture, isRenderingLuma: true}),
            'GlobeProjectionUBO': painter.getGlobeBuffer(tile, 0, propertyFillTranslate, propertyFillTranslateAnchor),
            'FillEvaluatedPropsUBO': renderData.propertyBuffer
        });

        for (const segment of segments.get()) {
            renderData.pipeline.draw({
                topology: 'triangle-list',
                renderPass: renderPass,
                vertexArray: renderData.vertexArray,
                firstVertex: segment.primitiveOffset * 3 * 2,
                vertexCount: segment.primitiveLength * 3,
            });
        }

        /*program.draw(painter.context, drawMode, depthMode,
            stencil, colorMode, CullFaceMode.backCCW, uniformValues, terrainData, projectionData,
            layer.id, bucket.layoutVertexBuffer, indexBuffer, segments,
            layer.paint, painter.transform.zoom, programConfiguration);*/
    }
}

export function drawFill(painter: Painter, sourceCache: SourceCache, layer: FillStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    const color = layer.paint.get('fill-color');
    const opacity = layer.paint.get('fill-opacity');

    if (opacity.constantOr(1) === 0) {
        return;
    }

    const {isRenderingToTexture} = renderOptions;
    const colorMode = painter.colorModeForRenderPass();
    const pattern = layer.paint.get('fill-pattern');
    const pass = painter.opaquePassEnabledForLayer() &&
        (!pattern.constantOr(1 as any) &&
            color.constantOr(Color.transparent).a === 1 &&
            opacity.constantOr(0) === 1) ? 'opaque' : 'translucent';

    // Draw fill
    if (painter.renderPass === pass) {
        const depthMode = painter.getDepthModeForSublayer(
            1, painter.renderPass === 'opaque' ? DepthMode.ReadWrite : DepthMode.ReadOnly);
        drawFillTiles(painter, sourceCache, layer, coords, depthMode, colorMode, false, isRenderingToTexture);
    }

    // Draw stroke
    if (painter.renderPass === 'translucent' && layer.paint.get('fill-antialias')) {

        // If we defined a different color for the fill outline, we are
        // going to ignore the bits in 0x07 and just care about the global
        // clipping mask.
        // Otherwise, we only want to drawFill the antialiased parts that are
        // *outside* the current shape. This is important in case the fill
        // or stroke color is translucent. If we wouldn't clip to outside
        // the current shape, some pixels from the outline stroke overlapped
        // the (non-antialiased) fill.
        const depthMode = painter.getDepthModeForSublayer(
            layer.getPaintProperty('fill-outline-color') ? 2 : 0, DepthMode.ReadOnly);
        drawFillTiles(painter, sourceCache, layer, coords, depthMode, colorMode, true, isRenderingToTexture);
    }
}

function drawFillTiles(
    painter: Painter,
    sourceCache: SourceCache,
    layer: FillStyleLayer,
    coords: Array<OverscaledTileID>,
    depthMode: Readonly<DepthMode>,
    colorMode: Readonly<ColorMode>,
    isOutline: boolean,
    isRenderingToTexture: boolean) {
    const gl = painter.context.gl;
    const fillPropertyName = 'fill-pattern';
    const patternProperty = layer.paint.get(fillPropertyName);
    const image = patternProperty && patternProperty.constantOr(1 as any);
    const crossfade = layer.getCrossfadeParameters();
    let drawMode, programName, uniformValues, indexBuffer, segments;

    const transform = painter.transform;

    const propertyFillTranslate = layer.paint.get('fill-translate');
    const propertyFillTranslateAnchor = layer.paint.get('fill-translate-anchor');

    if (!isOutline) {
        programName = image ? 'fillPattern' : 'fill';
        drawMode = gl.TRIANGLES;
    } else {
        programName = image && !layer.getPaintProperty('fill-outline-color') ? 'fillOutlinePattern' : 'fillOutline';
        drawMode = gl.LINES;
    }

    const constantPattern = patternProperty.constantOr(null);

    for (const coord of coords) {
        const tile = sourceCache.getTile(coord);
        if (image && !tile.patternsLoaded()) continue;

        const bucket: FillBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram(programName, programConfiguration);
        const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(coord);

        if (image) {
            painter.context.activeTexture.set(gl.TEXTURE0);
            tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(painter.context, crossfade);
        }

        updatePatternPositionsInProgram(programConfiguration, fillPropertyName, constantPattern, tile, layer);

        const projectionData = transform.getProjectionData({
            overscaledTileID: coord,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        const translateForUniforms = translatePosition(transform, tile, propertyFillTranslate, propertyFillTranslateAnchor);

        if (!isOutline) {
            indexBuffer = bucket.indexBuffer;
            segments = bucket.segments;
            uniformValues = image ? fillPatternUniformValues(painter, crossfade, tile, translateForUniforms) : fillUniformValues(translateForUniforms);
        } else {
            indexBuffer = bucket.indexBuffer2;
            segments = bucket.segments2;
            const drawingBufferSize = [gl.drawingBufferWidth, gl.drawingBufferHeight] as [number, number];
            uniformValues = (programName === 'fillOutlinePattern' && image) ?
                fillOutlinePatternUniformValues(painter, crossfade, tile, drawingBufferSize, translateForUniforms) :
                fillOutlineUniformValues(drawingBufferSize, translateForUniforms);
        }

        const stencil = painter.stencilModeForClipping(coord);

        program.draw(painter.context, drawMode, depthMode,
            stencil, colorMode, CullFaceMode.backCCW, uniformValues, terrainData, projectionData,
            layer.id, bucket.layoutVertexBuffer, indexBuffer, segments,
            layer.paint, painter.transform.zoom, programConfiguration);
    }
}
