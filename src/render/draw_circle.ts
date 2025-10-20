import {StencilMode} from '../gl/stencil_mode';
import {DepthMode} from '../gl/depth_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {type Program} from './program';
import {circleUniformValues} from './program/circle_program';
import {SegmentVector} from '../data/segment';
import {type OverscaledTileID} from '../source/tile_id';
import type {Painter, RenderOptions} from './painter';
import type {SourceCache} from '../source/source_cache';
import type {CircleStyleLayer} from '../style/style_layer/circle_style_layer';
import type {CircleBucket} from '../data/bucket/circle_bucket';
import {type ProgramConfiguration} from '../data/program_configuration';
import type {VertexBuffer} from '../gl/vertex_buffer';
import type {IndexBuffer} from '../gl/index_buffer';
import {type UniformValues} from './uniform_binding';
import type {CircleUniformsType} from './program/circle_program';
import type {TerrainData} from '../render/terrain';
import {translatePosition} from '../util/util';
import type {ProjectionData} from '../geo/projection/projection_data';
import {EXTENT} from '../data/extent';
import {pixelsToTileUnits} from '../source/pixels_to_tile_units';
import {type Color} from '@maplibre/maplibre-gl-style-spec';

import {UniformBufferLayout, type UniformBufferBindingLayout, Buffer, type RenderPass as LumaPass, type BufferLayout, type ShaderLayout, type VertexFormat} from '@luma.gl/core';
import type {UniformValue, VariableShaderType} from '@luma.gl/core';

type TileRenderState = {
    programConfiguration: ProgramConfiguration;
    program: Program<any>;
    layoutVertexBuffer: VertexBuffer;
    indexBuffer: IndexBuffer;
    uniformValues: UniformValues<CircleUniformsType>;
    terrainData: TerrainData;
    projectionData: ProjectionData;
};

type SegmentsTileRenderState = {
    segments: SegmentVector;
    sortKey: number;
    state: TileRenderState;
};

export function drawCirclesLuma(painter: Painter, sourceCache: SourceCache, layer: CircleStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions, renderPass: LumaPass) {
    if (painter.renderPass !== 'translucent') return;
    if (!painter.context.device) {
        return;
    }

    const radiusCorrectionFactor = painter.transform.getCircleRadiusCorrection();

    for (let i = 0; i < coords.length; i++) {
        const coord = coords[i];
        const tile = sourceCache.getTile(coord);
        const bucket: CircleBucket<any> = (tile.getBucket(layer) as any);
        if (bucket === undefined) {
            continue;
        }

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram('luma_circle', programConfiguration, null, null, true);

        const styleTranslate = layer.paint.get('circle-translate');
        const styleTranslateAnchor = layer.paint.get('circle-translate-anchor');

        const projectionData = painter.transform.getProjectionData({
            overscaledTileID: coord,
            applyGlobeMatrix: !renderOptions.isRenderingToTexture,
            applyTerrainMatrix: true
        });

        let pitchWithMap: boolean, extrudeScale: [number, number];
        let globeExtrudeScale: number = 0;
        if (layer.paint.get('circle-pitch-alignment') === 'map') {
            const pixelRatio = pixelsToTileUnits(tile, 1, painter.transform.zoom);
            pitchWithMap = true;
            extrudeScale = [pixelRatio, pixelRatio];

            // For globe rendering we need to know how much to extrude the circle as an *angle*.
            // The calculation: (one pixel in tile units) / (earth circumference in tile units) * (2PI radians) * radiusCorrectionFactor
            globeExtrudeScale = pixelRatio / (EXTENT * Math.pow(2, tile.tileID.overscaledZ)) * 2.0 * Math.PI * radiusCorrectionFactor;
        } else {
            pitchWithMap = false;
            extrudeScale = painter.transform.pixelsToGLUnits;
        }

        const binderUniformValues = programConfiguration.getUniformPropertyValues(layer.paint, {zoom: (painter.transform.zoom as any)});

        const newUBO = (layout: Record<string, VariableShaderType>, values: Record<string, UniformValue>) => {
            return painter.context.device.createBuffer({
                data: (new UniformBufferLayout(layout)).getData(values),
                usage: Buffer.UNIFORM
            });
        };

        const projectionParamterBuffer = newUBO(
            {
                'u_projection_matrix': 'mat4x4<f32>',
                'u_projection_fallback_matrix': 'mat4x4<f32>',
                'u_projection_tile_mercator_coords': 'vec4<f32>',
                'u_projection_clipping_plane': 'vec4<f32>',
                'u_projection_transition': 'f32'
            },
            {
                'u_projection_matrix': projectionData.mainMatrix,
                'u_projection_fallback_matrix': projectionData.fallbackMatrix,
                'u_projection_tile_mercator_coords': projectionData.tileMercatorCoords,
                'u_projection_clipping_plane': projectionData.clippingPlane,
                'u_projection_transition': projectionData.projectionTransition
            }
        );

        const globeBuffer = newUBO(
            {
                'u_translate': 'vec2<f32>',
                'u_globe_extrude_scale': 'f32',
                'u_device_pixel_ratio': 'f32',
                'u_camera_to_center_distance': 'f32'
            },
            {
                'u_translate': translatePosition(painter.transform, tile, styleTranslate, styleTranslateAnchor),
                'u_globe_extrude_scale': globeExtrudeScale,
                'u_device_pixel_ratio': painter.pixelRatio,
                'u_camera_to_center_distance': painter.transform.cameraToCenterDistance
            }
        );

        const propBuffer = newUBO(
            {
                'u_color': 'vec4<f32>',
                'u_stroke_color': 'vec4<f32>',
                'u_radius': 'f32',
                'u_blur': 'f32',
                'u_opacity': 'f32',
                'u_stroke_width': 'f32',
                'u_stroke_opacity': 'f32',
                'u_scale_with_map': 'i32',
                'u_pitch_with_map': 'i32',
                'u_padding': 'i32'
            },
            {
                'u_color': binderUniformValues['circle-color'] || [0, 0, 0, 1],
                'u_stroke_color': binderUniformValues['circle-stroke-color'] ?
                    [
                        (binderUniformValues['circle-stroke-color'] as Color).r,
                        (binderUniformValues['circle-stroke-color'] as Color).g,
                        (binderUniformValues['circle-stroke-color'] as Color).b,
                        (binderUniformValues['circle-stroke-color'] as Color).a
                    ] : [0, 0, 0, 1],
                'u_radius': binderUniformValues['circle-radius'],
                'u_blur': binderUniformValues['circle-blur'],
                'u_opacity': binderUniformValues['circle-opacity'],
                'u_stroke_width': binderUniformValues['circle-stroke-width'],
                'u_stroke_opacity': binderUniformValues['circle-stroke-opacity'],
                'u_scale_with_map': +(layer.paint.get('circle-pitch-scale') === 'map'),
                'u_pitch_with_map': +(pitchWithMap),
            }
        );

        const drawBuffer = newUBO(
            {
                'u_extrude_scale': 'vec2<f32>'
            },
            {
                'u_extrude_scale': extrudeScale,
            }
        );

        const shaderLayout: ShaderLayout = {
            attributes: [
                {location: 0, name: 'a_pos', type: 'vec2<f16>', stepMode: 'vertex'},
                {location: 1, name: 'a_color', type: 'vec4<f32>', stepMode: 'vertex'},
                {location: 2, name: 'a_radius', type: 'vec2<f32>', stepMode: 'vertex'}
            ],
            bindings: [
                {
                    name: 'ProjectionParameterUBO',
                    group: 0,
                    location: 0,
                    minBindingSize: 164,
                    visibility: 3,
                    uniforms: [
                        {byteOffset: 0, format: 'mat4x4<f32>', name: 'u_projection_matrix', arrayLength: 1},
                        {byteOffset: 64, format: 'mat4x4<f32>', name: 'u_projection_fallback_matrix', arrayLength: 1},
                        {byteOffset: 128, format: 'vec4<f32>', name: 'u_projection_tile_mercator_coords', arrayLength: 1},
                        {byteOffset: 144, format: 'vec4<f32>', name: 'u_projection_clipping_plane', arrayLength: 1},
                        {byteOffset: 160, format: 'f32', name: 'u_projection_transition', arrayLength: 1},
                    ]
                } as UniformBufferBindingLayout,
                {
                    name: 'GlobeProjectionUBO',
                    group: 0,
                    location: 1,
                    minBindingSize: 20,
                    visibility: 3,
                    uniforms: [
                        {byteOffset: 0, format: 'vec2<f32>', name: 'u_translate', arrayLength: 1},
                        {byteOffset: 8, format: 'f32', name: 'u_globe_extrude_scale', arrayLength: 1},
                        {byteOffset: 12, format: 'f32', name: 'u_device_pixel_ratio', arrayLength: 1},
                        {byteOffset: 16, format: 'f32', name: 'u_camera_to_center_distance', arrayLength: 1},
                    ]
                } as UniformBufferBindingLayout,
                {
                    name: 'CircleEvaluatedPropsUBO',
                    group: 0,
                    location: 2,
                    minBindingSize: 64,
                    visibility: 3,
                    uniforms: [
                        {byteOffset: 0, format: 'vec4<f32>', name: 'u_color', arrayLength: 1},
                        {byteOffset: 16, format: 'vec4<f32>', name: 'u_stroke_color', arrayLength: 1},
                        {byteOffset: 32, format: 'f32', name: 'u_radius', arrayLength: 1},
                        {byteOffset: 36, format: 'f32', name: 'u_blur', arrayLength: 1},
                        {byteOffset: 40, format: 'f32', name: 'u_opacity', arrayLength: 1},
                        {byteOffset: 44, format: 'f32', name: 'u_stroke_width', arrayLength: 1},
                        {byteOffset: 48, format: 'f32', name: 'u_stroke_opacity', arrayLength: 1},
                        {byteOffset: 52, format: 'f32', name: 'u_scale_with_map', arrayLength: 1},
                        {byteOffset: 56, format: 'f32', name: 'u_pitch_with_map', arrayLength: 1},
                        {byteOffset: 60, format: 'f32', name: 'props_padding', arrayLength: 1},
                    ]
                } as UniformBufferBindingLayout,
                {
                    name: 'DrawUBO',
                    group: 0,
                    location: 3,
                    minBindingSize: 40,
                    visibility: 3,
                    uniforms: [
                        {byteOffset: 0, format: 'vec2<f32>', name: 'u_extrude_scale', arrayLength: 1},
                        {byteOffset: 8, format: 'f32', name: 'u_color_t', arrayLength: 1},
                        {byteOffset: 12, format: 'f32', name: 'u_radius_t', arrayLength: 1},
                        {byteOffset: 16, format: 'f32', name: 'u_blur_t', arrayLength: 1},
                        {byteOffset: 20, format: 'f32', name: 'u_opacity_t', arrayLength: 1},
                        {byteOffset: 24, format: 'f32', name: 'u_stroke_color_t', arrayLength: 1},
                        {byteOffset: 28, format: 'f32', name: 'u_stroke_width_t', arrayLength: 1},
                        {byteOffset: 32, format: 'f32', name: 'u_stroke_opacity_t', arrayLength: 1},
                        {byteOffset: 36, format: 'f32', name: 'draw_padding', arrayLength: 1}
                    ]
                } as UniformBufferBindingLayout
            ],
        };

        let bufferLayout: BufferLayout[] = [
            {name: 'a_pos', format: 'sint16x2', stepMode: 'vertex', byteStride: 4, attributes: [{attribute: 'a_pos', format: 'sint16x2', byteOffset: 0}]},
        ];

        const binderAttrs = programConfiguration.getAttributeMetadata();
        for (const attrName of programConfiguration.getBinderAttributes()) {
            const attrs = binderAttrs[attrName];
            const componentBytes = (attrs.type == 'Float32' || attrs.type == 'Int32' || attrs.type == 'Uint32') ? 4 :
                (attrs.type == 'Int16' || attrs.type == 'Uint16') ? 2 : 1;
            let format: VertexFormat;
            switch (attrs.type) {
                case 'Float32':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'float32x2'; break;
                            case 3: format = 'float32x3'; break;
                            case 4: format = 'float32x4'; break;
                        }
                    } else {
                        format = 'float32';
                    }
                    break;
                case 'Int32':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'sint32x2'; break;
                            case 3: format = 'sint32x3'; break;
                            case 4: format = 'sint32x4'; break;
                        }
                    } else {
                        format = 'sint32';
                    }
                    break;
                case 'Uint32':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'uint32x2'; break;
                            case 3: format = 'uint32x3'; break;
                            case 4: format = 'uint32x4'; break;
                        }
                    } else {
                        format = 'uint32';
                    }
                    break;
                case 'Int16':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'sint16x2'; break;
                            case 4: format = 'sint16x4'; break;
                        }
                    } else {
                        format = 'sint32';
                    }
                    break;
                case 'Uint16':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'uint16x2'; break;
                            case 4: format = 'uint16x4'; break;
                        }
                    } else {
                        format = 'uint32';
                    }
                    break;
                case 'Int8':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'sint8x2'; break;
                            case 4: format = 'sint8x4'; break;
                        }
                    } else {
                        format = 'sint8';
                    }
                case 'Uint8':
                    if (attrs.components > 1) {
                        switch (attrs.components) {
                            case 2: format = 'uint8x2'; break;
                            case 4: format = 'uint8x4'; break;
                        }
                    } else {
                        format = 'uint8';
                    }
                    break;
            }
            bufferLayout.push({name: attrName, stepMode: 'vertex', byteStride: attrs.components * componentBytes, format: format})
        }

        const pipeline = painter.context.device.createRenderPipeline({
            id: 'circle-layer',
            vs: program.vertexShader,
            fs: program.fragmentShader,
            topology: 'triangle-list',
            shaderLayout: shaderLayout,
            bufferLayout: bufferLayout,
            parameters: {
                depthWriteEnabled: false,
                depthCompare: 'always',
                depthFormat: 'depth24plus-stencil8',
                blend: false,
                cullMode: 'none',
                topology: 'triangle-list',
                stencilCompare: 'always',
                stencilDepthFailOperation: 'keep',
                stencilFailOperation: 'keep',
                stencilPassOperation: 'keep',
                stencilReadMask: 0,
                stencilWriteMask: 0
            }
        });

        pipeline.setBindings({
            'ProjectionParameterUBO': projectionParamterBuffer,
            'GlobeProjectionUBO': globeBuffer,
            'CircleEvaluatedPropsUBO': propBuffer,
            'DrawUBO': drawBuffer,
        });

        const vertexArray = painter.context.device.createVertexArray({
            shaderLayout: pipeline.shaderLayout,
            bufferLayout: pipeline.bufferLayout
        });
        vertexArray.setBuffer(0, bucket.layoutVertexBuffer.getLumaBuffer());
        vertexArray.setIndexBuffer(bucket.indexBuffer.getLumaBuffer());

        let n = 0;
        for (const buffer of programConfiguration.getPaintVertexBuffers()) {
            vertexArray.setBuffer(++n, buffer.getLumaBuffer());
        }

        for (const segment of bucket.segments.get()) {
            pipeline.draw({
                topology: 'triangle-list',
                renderPass: renderPass,
                vertexArray: vertexArray,
                firstVertex: segment.primitiveOffset * 3 * 2,
                vertexCount: segment.primitiveLength * 3,
            });
        }
    }
}

export function drawCircles(painter: Painter, sourceCache: SourceCache, layer: CircleStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    if (painter.renderPass !== 'translucent') return;

    const {isRenderingToTexture} = renderOptions;
    const opacity = layer.paint.get('circle-opacity');
    const strokeWidth = layer.paint.get('circle-stroke-width');
    const strokeOpacity = layer.paint.get('circle-stroke-opacity');
    const sortFeaturesByKey = !layer.layout.get('circle-sort-key').isConstant();

    if (opacity.constantOr(1) === 0 && (strokeWidth.constantOr(1) === 0 || strokeOpacity.constantOr(1) === 0)) {
        return;
    }

    const context = painter.context;
    const gl = context.gl;
    const transform = painter.transform;

    const depthMode = painter.getDepthModeForSublayer(0, DepthMode.ReadOnly);
    // Turn off stencil testing to allow circles to be drawn across boundaries,
    // so that large circles are not clipped to tiles
    const stencilMode = StencilMode.disabled;
    const colorMode = painter.colorModeForRenderPass();

    const segmentsRenderStates: Array<SegmentsTileRenderState> = [];

    // Note: due to how the shader is written, this value only has effect when globe rendering is enabled and `circle-pitch-alignment` is set to 'map'.
    const radiusCorrectionFactor = transform.getCircleRadiusCorrection();

    for (let i = 0; i < coords.length; i++) {
        const coord = coords[i];

        const tile = sourceCache.getTile(coord);
        const bucket: CircleBucket<any> = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const styleTranslate = layer.paint.get('circle-translate');
        const styleTranslateAnchor = layer.paint.get('circle-translate-anchor');
        const translateForUniforms = translatePosition(transform, tile, styleTranslate, styleTranslateAnchor);

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram('circle', programConfiguration);
        const layoutVertexBuffer = bucket.layoutVertexBuffer;
        const indexBuffer = bucket.indexBuffer;
        const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(coord);
        const uniformValues = circleUniformValues(painter, tile, layer, translateForUniforms, radiusCorrectionFactor);

        const projectionData = transform.getProjectionData({overscaledTileID: coord, applyGlobeMatrix: !isRenderingToTexture, applyTerrainMatrix: true});

        const state: TileRenderState = {
            programConfiguration,
            program,
            layoutVertexBuffer,
            indexBuffer,
            uniformValues,
            terrainData,
            projectionData
        };

        if (sortFeaturesByKey) {
            const oldSegments = bucket.segments.get();
            for (const segment of oldSegments) {
                segmentsRenderStates.push({
                    segments: new SegmentVector([segment]),
                    sortKey: (segment.sortKey as any as number),
                    state
                });
            }
        } else {
            segmentsRenderStates.push({
                segments: bucket.segments,
                sortKey: 0,
                state
            });
        }

    }

    if (sortFeaturesByKey) {
        segmentsRenderStates.sort((a, b) => a.sortKey - b.sortKey);
    }

    for (const segmentsState of segmentsRenderStates) {
        const {programConfiguration, program, layoutVertexBuffer, indexBuffer, uniformValues, terrainData, projectionData} = segmentsState.state;
        const segments = segmentsState.segments;

        program.draw(context, gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.backCCW,
            uniformValues, terrainData, projectionData, layer.id,
            layoutVertexBuffer, indexBuffer, segments,
            layer.paint, painter.transform.zoom, programConfiguration);
    }
}
