import {StencilMode} from '../gl/stencil_mode';
import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {
    backgroundUniformValues,
    backgroundPatternUniformValues
} from './program/background_program';

import type {Painter, RenderOptions} from './painter';
import type {SourceCache} from '../source/source_cache';
import {BackgroundStyleLayer} from '../style/style_layer/background_style_layer';
import {type OverscaledTileID} from '../source/tile_id';
import {coveringTiles} from '../geo/projection/covering_tiles';
import { RenderPass, Buffer, UniformBufferLayout } from '@luma.gl/core';
import {
    BufferSpec,
    RenderData,
    blendAdditiveParameters,
    blendOpaqueParameters,
    defaultParameters,
    transparentDepthParameters,
    opaqueDepthParameters
} from '../render/render_data';
import { Program } from './program';
import { Mesh } from './mesh';
import { Tile } from '../source/tile';
import { CrossFaded } from '../style/properties';
import { ResolvedImage } from '@maplibre/maplibre-gl-style-spec';
import { pixelsToTileUnits } from '../source/pixels_to_tile_units';

class BackgroundRenderData extends RenderData<BackgroundStyleLayer> {
    propertyBuffer: Buffer;

    static propertyBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'BackgroundUniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_color': 'vec4<f32>',
            'u_opacity': 'f32',
        })
    };

    constructor(painter: Painter, layer: BackgroundStyleLayer, program: Program<any>, mesh: Mesh, opaquePass: boolean) {
        super(painter, layer, program,
            {
                ...defaultParameters,
                ...(opaquePass ? blendOpaqueParameters : blendAdditiveParameters),
                ...(opaquePass ? opaqueDepthParameters : transparentDepthParameters)
            },
            [BackgroundRenderData.propertyBuffer.binding]
        );

        this.propertyBuffer = painter.context.device.createBuffer({
            byteLength: BackgroundRenderData.propertyBuffer.layout.byteLength,
            usage: Buffer.UNIFORM
        });

        this.vertexArray.setBuffer(0, mesh.vertexBuffer.lumaBuffer);
        this.vertexArray.setIndexBuffer(mesh.indexBuffer.lumaBuffer);
    }

    updateBuffers(layer: BackgroundStyleLayer) {
        const color = layer.paint.get('background-color');
        this.propertyBuffer.write(BackgroundRenderData.propertyBuffer.layout.getData({
            'u_color': [color.r, color.g, color.b, color.a],
            'u_opacity': layer.paint.get('background-opacity')
        }));
    }
}

class BackgroundPatternRenderData extends RenderData<BackgroundStyleLayer> {
    propertyBuffer: Buffer;

    static propertyBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'BackgroundPatternUniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_pattern_tl_a': 'vec2<f32>',
            'u_pattern_br_a': 'vec2<f32>',
            'u_pattern_tl_b': 'vec2<f32>',
            'u_pattern_br_b': 'vec2<f32>',
            'u_texsize': 'vec2<f32>',
            'u_pattern_size_a': 'vec2<f32>',
            'u_pattern_size_b': 'vec2<f32>',
            'u_pixel_coord_upper': 'vec2<f32>',
            'u_pixel_coord_lower': 'vec2<f32>',
            'u_mix': 'f32',
            'u_opacity': 'f32',
            'u_scale_a': 'f32',
            'u_scale_b': 'f32',
            'u_tile_units_to_pixels': 'f32',
        })
    };

    constructor(painter: Painter, layer: BackgroundStyleLayer, program: Program<any>, mesh: Mesh, opaquePass: boolean) {
        super(painter, layer, program,
            {
                ...defaultParameters,
                ...(opaquePass ? blendOpaqueParameters : blendAdditiveParameters),
                ...(opaquePass ? opaqueDepthParameters : transparentDepthParameters)
            },
            [BackgroundRenderData.propertyBuffer.binding]
        );

        this.propertyBuffer = painter.context.device.createBuffer({
            byteLength: BackgroundRenderData.propertyBuffer.layout.byteLength,
            usage: Buffer.UNIFORM
        });

        this.vertexArray.setBuffer(0, mesh.vertexBuffer.lumaBuffer);
        this.vertexArray.setIndexBuffer(mesh.indexBuffer.lumaBuffer);
    }

    updateBuffers(
        painter: Painter,
        layer: BackgroundStyleLayer,
        tile: {
            tileID: OverscaledTileID;
            tileSize: number;
        },
        image: CrossFaded<ResolvedImage>
    ) {
        const imagePosA = painter.imageManager.getPattern(image.from.toString());
        const imagePosB = painter.imageManager.getPattern(image.to.toString());
        const {width, height} = painter.imageManager.getPixelSize();

        const numTiles = Math.pow(2, tile.tileID.overscaledZ);
        const tileSizeAtNearestZoom = tile.tileSize * Math.pow(2, painter.transform.tileZoom) / numTiles;

        const pixelX = tileSizeAtNearestZoom * (tile.tileID.canonical.x + tile.tileID.wrap * numTiles);
        const pixelY = tileSizeAtNearestZoom * tile.tileID.canonical.y;

        const crossfade = layer.getCrossfadeParameters();

        this.propertyBuffer.write(BackgroundRenderData.propertyBuffer.layout.getData({
            'u_pattern_tl_a': (imagePosA as any).tl,
            'u_pattern_br_a': (imagePosA as any).br,
            'u_pattern_tl_b': (imagePosB as any).tl,
            'u_pattern_br_b': (imagePosB as any).br,
            'u_texsize': [width, height],
            'u_pattern_size_a': (imagePosA as any).displaySize,
            'u_pattern_size_b': (imagePosB as any).displaySize,
            'u_pixel_coord_upper': [pixelX >> 16, pixelY >> 16],
            'u_pixel_coord_lower': [pixelX & 0xFFFF, pixelY & 0xFFFF],
            'u_mix': crossfade.t,
            'u_opacity': layer.paint.get('background-opacity'),
            'u_scale_a': crossfade.fromScale,
            'u_scale_b': crossfade.toScale,
            'u_tile_units_to_pixels': 1 / pixelsToTileUnits(tile, 1, painter.transform.tileZoom),
        }));
    }
}

const lumaData: {[_: string]: RenderData<BackgroundStyleLayer>} = {};
function getOrCreateRenderData(painter: Painter, layer: BackgroundStyleLayer, program: Program<any>, mesh: Mesh, isOpaquePass: boolean, isPattern: boolean, onCreated?: (_: RenderData<any>) => void): RenderData<any> {
    const data = lumaData[layer.id];
    if (data) {
        return data;
    }

    let renderData = isPattern ? new BackgroundPatternRenderData(painter, layer, program, mesh, isOpaquePass) : new BackgroundRenderData(painter, layer, program, mesh, isOpaquePass);

    renderData.vertexArray.setBuffer(0, mesh.vertexBuffer.getLumaBuffer());
    renderData.vertexArray.setIndexBuffer(mesh.indexBuffer.getLumaBuffer());
    onCreated(renderData);
    
    lumaData[layer.id] = renderData
    return renderData;
}

export function drawBackgroundLuma(painter: Painter, sourceCache: SourceCache, layer: BackgroundStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions, renderPass: RenderPass) {
    const color = layer.paint.get('background-color');
    const opacity = layer.paint.get('background-opacity');

    if (opacity === 0) return;

    const context = painter.context;
    const projection = painter.style.projection;
    const transform = painter.transform;
    const tileSize = transform.tileSize;
    const image = layer.paint.get('background-pattern');

    if (painter.isPatternMissing(image)) return;

    const pass = (!image && color.a === 1 && opacity === 1 && painter.opaquePassEnabledForLayer()) ? 'opaque' : 'translucent';
    if (painter.renderPass !== pass) return;

    const program = painter.useProgram(image ? 'backgroundPattern' : 'background');
    const tileIDs = coords ? coords : coveringTiles(transform, {tileSize, terrain: painter.style.map.terrain});

    for (const tileID of tileIDs) {
        const projectionParamterBuffer = painter.getProjectionParameterBuffer(tileID, {
            isRenderingGlobe: renderOptions.isRenderingGlobe,
            isRenderingToTexture: renderOptions.isRenderingToTexture,
            isRenderingLuma: true
        }, 0);
        const globeBuffer = painter.getGlobeBuffer(null, 0, [0, 0], 'map');
        const mesh = projection.getMeshFromTileID(context, tileID.canonical, false, true, 'raster');
        const renderData = image ?
            getOrCreateRenderData(painter, layer, program, mesh, pass == 'opaque', true, (data: BackgroundPatternRenderData) => data.pipeline.setBindings({
                //'ProjectionParameterUBO': projectionParamterBuffer,
                //'GlobeProjectionUBO': globeBuffer,
                'BackgroundPatternUniforms': data.propertyBuffer,
                'u_image': painter.imageManager.atlasTexture.lumaTexture
            })) as BackgroundPatternRenderData :
            getOrCreateRenderData(painter, layer, program, mesh, pass == 'opaque', false, (data: BackgroundRenderData) => data.pipeline.setBindings({
                //'ProjectionParameterUBO': projectionParamterBuffer,
                //'GlobeProjectionUBO': globeBuffer,
                'BackgroundUniforms': data.propertyBuffer
            })) as BackgroundRenderData;
        
        if (image) {
            (renderData as BackgroundPatternRenderData).updateBuffers(painter, layer, {tileID, tileSize}, image);
        } else {
            (renderData as BackgroundRenderData).updateBuffers(layer);
        }

        // TODO
        // const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(tileID);

        // For globe rendering, background uses tile meshes *without* borders and no stencil clipping.
        // This works assuming the tileIDs list contains only tiles of the same zoom level.
        // This seems to always be the case for background layers, but I'm leaving this comment
        // here in case this assumption is false in the future.

        // In case background starts having tiny holes at tile boundaries, switch to meshes with borders
        // and also enable stencil clipping. Make sure to render a proper tile clipping mask into stencil
        // first though, as that doesn't seem to happen for background layers as of writing this.

        renderData.drawSegments(mesh.segments, renderPass);
    }
}

export function drawBackground(painter: Painter, sourceCache: SourceCache, layer: BackgroundStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    const color = layer.paint.get('background-color');
    const opacity = layer.paint.get('background-opacity');

    if (opacity === 0) return;

    const {isRenderingToTexture} = renderOptions;
    const context = painter.context;
    const gl = context.gl;
    const projection = painter.style.projection;
    const transform = painter.transform;
    const tileSize = transform.tileSize;
    const image = layer.paint.get('background-pattern');

    if (painter.isPatternMissing(image)) return;

    const pass = (!image && color.a === 1 && opacity === 1 && painter.opaquePassEnabledForLayer()) ? 'opaque' : 'translucent';
    if (painter.renderPass !== pass) return;

    const stencilMode = StencilMode.disabled;
    const depthMode = painter.getDepthModeForSublayer(0, pass === 'opaque' ? DepthMode.ReadWrite : DepthMode.ReadOnly);
    const colorMode = painter.colorModeForRenderPass();
    const program = painter.useProgram(image ? 'backgroundPattern' : 'background');
    const tileIDs = coords ? coords : coveringTiles(transform, {tileSize, terrain: painter.style.map.terrain});

    if (image) {
        context.activeTexture.set(gl.TEXTURE0);
        painter.imageManager.bind(painter.context);
    }

    const crossfade = layer.getCrossfadeParameters();
    
    for (const tileID of tileIDs) {
        const projectionData = transform.getProjectionData({
            overscaledTileID: tileID,
            applyGlobeMatrix: !isRenderingToTexture,
            applyTerrainMatrix: true
        });

        const uniformValues = image ?
            backgroundPatternUniformValues(opacity, painter, image, {tileID, tileSize}, crossfade) :
            backgroundUniformValues(opacity, color);
        const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(tileID);

        // For globe rendering, background uses tile meshes *without* borders and no stencil clipping.
        // This works assuming the tileIDs list contains only tiles of the same zoom level.
        // This seems to always be the case for background layers, but I'm leaving this comment
        // here in case this assumption is false in the future.

        // In case background starts having tiny holes at tile boundaries, switch to meshes with borders
        // and also enable stencil clipping. Make sure to render a proper tile clipping mask into stencil
        // first though, as that doesn't seem to happen for background layers as of writing this.

        const mesh = projection.getMeshFromTileID(context, tileID.canonical, false, true, 'raster');
        program.draw(context, gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.backCCW,
            uniformValues, terrainData, projectionData, layer.id,
            mesh.vertexBuffer, mesh.indexBuffer, mesh.segments);
    }
}
