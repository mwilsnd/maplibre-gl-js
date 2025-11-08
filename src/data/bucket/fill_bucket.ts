import {FillLayoutArray} from '../array_types.g';

import {members as layoutAttributes} from './fill_attributes';
import {SegmentVector} from '../segment';
import {CompositeExpressionBinder, ConstantBinder, CrossFadedConstantBinder, ProgramConfigurationSet} from '../program_configuration';
import {LineIndexArray, TriangleIndexArray} from '../index_array_type';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
const EARCUT_MAX_RINGS = 500;
import {register} from '../../util/web_worker_transfer';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features';
import {loadGeometry} from '../load_geometry';
import {toEvaluationFeature} from '../evaluation_feature';
import {EvaluationParameters} from '../../style/evaluation_parameters';

import type {CanonicalTileID} from '../../source/tile_id';
import {Tile} from '../../source/tile';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import {FillStyleLayer} from '../../style/style_layer/fill_style_layer';
import type {Context} from '../../gl/context';
import type {IndexBuffer} from '../../gl/index_buffer';
import type {VertexBuffer} from '../../gl/vertex_buffer';
import type Point from '@mapbox/point-geometry';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';
import type {VectorTileLayer} from '@mapbox/vector-tile';
import {subdividePolygon} from '../../render/subdivision';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays';

import {Painter} from '../../render/painter';
import {Program} from '../../render/program';
import {Buffer, UniformBufferLayout} from '@luma.gl/core';

import {
    BufferSpec,
    RenderData,
    blendAdditiveParameters,
    defaultParameters,
    transparentDepthParameters,
    opaqueDepthParameters
} from '../../render/render_data';

export class FillRenderData extends RenderData<FillStyleLayer> {
    propertyBuffer: Buffer;

    static propertyBufferSpec: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'FillUniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_color': 'vec4<f32>',
            'u_fill_translate': 'vec2<f32>',
            'u_color_t': 'f32',
            'u_opacity': 'f32',
            'u_opacity_t': 'f32'
        })
    };

    constructor(painter: Painter, layer: FillStyleLayer, bucket: FillBucket, program: Program<any>, writeDepth: boolean) {
        super(painter, layer, program, 
            {
                ...defaultParameters,
                ...blendAdditiveParameters,
                ...writeDepth ? opaqueDepthParameters : transparentDepthParameters
            },
            [FillRenderData.propertyBufferSpec.binding],
            bucket.programConfigurations.get(layer.id),
            (buffer: VertexBuffer) => buffer.attributes[0].name != 'a_outline_color'
        );

        this.propertyBuffer = painter.context.device.createBuffer({
            byteLength: FillRenderData.propertyBufferSpec.layout.byteLength,
            usage: Buffer.UNIFORM
        });
    }

    updateBuffers(painter: Painter, layer: FillStyleLayer, bucket: FillBucket) {
        const globals = {zoom: (painter.transform.zoom as any)};
        const programConfiguration = bucket.programConfigurations.get(layer.id);
        this.propertyBuffer.write(FillRenderData.propertyBufferSpec.layout.getData({
            'u_color': programConfiguration.getBinderValueOr('fill-color', 'value', [0, 0, 0, 0]),
            'u_fill_translate': programConfiguration.getBinderValueOr('fill-translate', 'value', [0, 0]),
            'u_color_t': programConfiguration.getBinderFactor('fill-color', globals),
            'u_opacity':  programConfiguration.getBinderValueOr('fill-opacity', 'value', 0),
            'u_opacity_t': programConfiguration.getBinderFactor('fill-opacity', globals),
        }));
    }
}

export class FillPatternRenderData extends RenderData<FillStyleLayer> {
    propertyBuffer: Buffer;
    drawBuffer: Buffer;

    static propertyBufferSpec: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'FillPatternUniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_pattern_from': 'vec4<f32>',
            'u_pattern_to': 'vec4<f32>',
            'u_fill_translate': 'vec2<f32>', 
            'u_texsize': 'vec2<f32>',
            'u_pixel_coord_upper': 'vec2<f32>',
            'u_pixel_coord_lower': 'vec2<f32>',
            'u_scale': 'vec3<f32>',
            'u_fade': 'f32',
            'u_opacity': 'f32',
            'u_pixel_ratio_from': 'f32',
            'u_pixel_ratio_to': 'f32',
        })
    };

    static drawBufferSpec: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'DrawUJniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_pattern_from_t': 'f32', 
            'u_pattern_to_t': 'f32',
            'u_opacity_t': 'f32',
            'u_pixel_ratio_from_t': 'f32',
            'u_pixel_ratio_to_t': 'f32'
        })
    };

    constructor(painter: Painter, layer: FillStyleLayer, bucket: FillBucket, program: Program<any>, writeDepth: boolean) {
        super(painter, layer, program,
            {
                ...defaultParameters,
                ...blendAdditiveParameters,
                ...writeDepth ? opaqueDepthParameters : transparentDepthParameters
            },
            [
                FillRenderData.propertyBufferSpec.binding,
                {
                    location: 3,
                    group: 0,
                    type: 'texture',
                    name: 'u_image'
                }
            ],
            bucket.programConfigurations.get(layer.id),
            (buffer: VertexBuffer) => buffer.attributes[0].name != 'a_outline_color'
        );

        this.propertyBuffer = painter.context.device.createBuffer({
            byteLength: FillPatternRenderData.propertyBufferSpec.layout.byteLength,
            usage: Buffer.UNIFORM
        });
        this.drawBuffer = painter.context.device.createBuffer({
            byteLength: FillPatternRenderData.drawBufferSpec.layout.byteLength,
            usage: Buffer.UNIFORM
        });
    }

    updateBuffers(painter: Painter, layer: FillStyleLayer, bucket: FillBucket, tile: Tile) {
        const zero = [0, 0, 0, 0];
        const tileRatio = 1 / pixelsToTileUnits(tile, 1, painter.transform.tileZoom);
        const numTiles = Math.pow(2, tile.tileID.overscaledZ);
        const tileSizeAtNearestZoom = tile.tileSize * Math.pow(2, painter.transform.tileZoom) / numTiles;
        const pixelX = tileSizeAtNearestZoom * (tile.tileID.canonical.x + tile.tileID.wrap * numTiles);
        const pixelY = tileSizeAtNearestZoom * tile.tileID.canonical.y;

        const globals = {zoom: (painter.transform.zoom as any)};
        const crossfade = layer.getCrossfadeParameters();
        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const crossfadeBinder = programConfiguration.getUniformBinder("fill-pattern") as CrossFadedConstantBinder;
        const opacityBinder = programConfiguration.getUniformBinder("fill-opacity") as ConstantBinder;
        const translateBinder = programConfiguration.getUniformBinder("fill-translate") as ConstantBinder;

        this.propertyBuffer.write(FillPatternRenderData.propertyBufferSpec.layout.getData({
            'u_pattern_from': crossfadeBinder ? crossfadeBinder.patternFrom : zero,
            'u_pattern_to': crossfadeBinder ? crossfadeBinder.patternTo : zero,
            'u_fill_translate': translateBinder ? translateBinder.value as [number, number] : [0, 0],
            'u_texsize': tile.imageAtlasTexture.size,
            'u_pixel_coord_upper': [pixelX >> 16, pixelY >> 16],
            'u_pixel_coord_lower': [pixelX & 0xFFFF, pixelY & 0xFFFF],
            'u_scale': [tileRatio, crossfade.fromScale, crossfade.toScale],
            'u_fade': crossfade.t,
            'u_opacity': opacityBinder ? opacityBinder.value as number : 0,
            'u_pixel_ratio_from': crossfadeBinder ? crossfadeBinder.pixelRatioFrom : 0,
            'u_pixel_ratio_to': crossfadeBinder ? crossfadeBinder.pixelRatioTo : 0
        }));

        const crossfadeFactor = crossfadeBinder instanceof CompositeExpressionBinder ?
            crossfadeBinder.getFactor(globals) : 0;
        const opacityFactor = opacityBinder instanceof CompositeExpressionBinder ?
            opacityBinder.getFactor(globals) : 0;

        this.drawBuffer.write(FillPatternRenderData.drawBufferSpec.layout.getData({
            'u_pattern_from_t': crossfadeFactor,
            'u_pattern_to_t': crossfadeFactor,
            'u_opacity_t': opacityFactor,
            'u_pixel_ratio_from_t': crossfadeFactor,
            'u_pixel_ratio_to_t': crossfadeFactor
        }));
    }
}

export class FillBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillStyleLayer>;
    stateDependentLayerIds: Array<string>;
    patternFeatures: Array<BucketFeature>;
    globalState: Record<string, any>;

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    hasPattern: boolean;
    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;

    lumaData: {[_: string]: RenderData<FillStyleLayer>};

    static fillOutlinePropertyBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'FillOutlineEvaluatedPropsUBO',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_world': 'vec2<f32>',
            'u_fill_translate': 'vec2<f32>',
            'u_outline_color_t': 'vec4<f32>',
            'u_opacity': 'f32',
        })
    };
    static fillOutlinePatternPropertyBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'FillOutlinePatternEvaluatedPropsUBO',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_pattern_from_t': 'vec4<f32>', // 16
            'u_pattern_to_t': 'vec4<f32>', // 32
            'u_scale': 'vec3<f32>', // 48
            'u_world': 'vec2<f32>', // 56
            'u_pixel_coord_upper': 'vec2<f32>', // 64
            'u_pixel_coord_lower': 'vec2<f32>', // 72
            'u_fill_translate': 'vec2<f32>', // 80
            'u_texsize': 'vec2<f32>', // 88
            'u_pixel_ratio_from': 'f32', // 92
            'u_pixel_ratio_to': 'f32', // 96
            'u_fade': 'f32', // 100
            'u_opacity_t': 'f32', // 104
        })
    };

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.globalState = options.globalState;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;
        this.patternFeatures = [];
        this.lumaData = {};

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID) {
        this.hasPattern = hasPattern('fill', this.layers, options);
        const fillSortKey = this.layers[0].layout.get('fill-sort-key');
        const sortFeaturesByKey = !fillSortKey.isConstant();
        const bucketFeatures: BucketFeature[] = [];

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const needGeometry = this.layers[0]._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom, {globalState: this.globalState}), evaluationFeature, canonical)) continue;

            const sortKey = sortFeaturesByKey ?
                fillSortKey.evaluate(evaluationFeature, {}, canonical, options.availableImages) :
                undefined;

            const bucketFeature: BucketFeature = {
                id,
                properties: feature.properties,
                type: feature.type,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
                patterns: {},
                sortKey
            };

            bucketFeatures.push(bucketFeature);
        }

        if (sortFeaturesByKey) {
            bucketFeatures.sort((a, b) => a.sortKey - b.sortKey);
        }

        for (const bucketFeature of bucketFeatures) {
            const {geometry, index, sourceLayerIndex} = bucketFeature;

            if (this.hasPattern) {
                const patternFeature = addPatternDependencies('fill', this.layers, bucketFeature, this.zoom, options);
                // pattern features are added only once the pattern is loaded into the image atlas
                // so are stored during populate until later updated with positions by tile worker in addFeatures
                this.patternFeatures.push(patternFeature);
            } else {
                this.addFeature(bucketFeature, geometry, index, canonical, {}, options.subdivisionGranularity);
            }

            const feature = features[index].feature;
            options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {
        [_: string]: ImagePosition;
    }) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions,
            globalState: this.globalState
        });
    }

    addFeatures(options: PopulateParameters, canonical: CanonicalTileID, imagePositions: {
        [_: string]: ImagePosition;
    }) {
        for (const feature of this.patternFeatures) {
            this.addFeature(feature, feature.geometry, feature.index, canonical, imagePositions, options.subdivisionGranularity);
        }
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
            this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }
    
    getOrCreateRenderData(painter: Painter, layer: FillStyleLayer, program: Program<any>, isOutline: boolean, image: boolean, writeDepth: boolean, onCreated?: (_: RenderData<any>) => void): RenderData<any> {
        const data = this.lumaData[layer.id];
        if (data) {
            return data;
        }

        let renderData;
        if (!isOutline) {
            renderData = image ? new FillPatternRenderData(painter, layer, this, program, writeDepth) : new FillRenderData(painter, layer, this, program, writeDepth);
        } else {
            // TODO
        }

        renderData.vertexArray.setBuffer(0, this.layoutVertexBuffer.getLumaBuffer());
        renderData.vertexArray.setIndexBuffer(isOutline ? this.indexBuffer2.getLumaBuffer() : this.indexBuffer.getLumaBuffer());
        onCreated(renderData);
        
        this.lumaData[layer.id] = renderData
        return renderData;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, canonical: CanonicalTileID, imagePositions: {
        [_: string]: ImagePosition;
    }, subdivisionGranularity: SubdivisionGranularitySetting) {
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            const subdivided = subdividePolygon(polygon, canonical, subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z));

            const vertexArray = this.layoutVertexArray;

            fillLargeMeshArrays(
                (x, y) => {
                    vertexArray.emplaceBack(x, y);
                },
                this.segments,
                this.layoutVertexArray,
                this.indexArray,
                subdivided.verticesFlattened,
                subdivided.indicesTriangles,
                this.segments2,
                this.indexArray2,
                subdivided.indicesLineList,
            );
        }
        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical, globalState: this.globalState});
    }
}

register('FillBucket', FillBucket, {omit: ['layers', 'patternFeatures']});
