import {CircleLayoutArray} from '../array_types.g';

import {members as layoutAttributes} from './circle_attributes';
import {SegmentVector} from '../segment';
import {ProgramConfigurationSet} from '../program_configuration';
import {TriangleIndexArray} from '../index_array_type';
import {loadGeometry} from '../load_geometry';
import {toEvaluationFeature} from '../evaluation_feature';
import {EXTENT} from '../extent';
import {register} from '../../util/web_worker_transfer';
import {EvaluationParameters} from '../../style/evaluation_parameters';

import type {CanonicalTileID} from '../../source/tile_id';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import type {CircleStyleLayer} from '../../style/style_layer/circle_style_layer';
import type {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer';
import type {Context} from '../../gl/context';
import type {IndexBuffer} from '../../gl/index_buffer';
import type {VertexBuffer} from '../../gl/vertex_buffer';
import type Point from '@mapbox/point-geometry';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';
import type {VectorTileLayer} from '@mapbox/vector-tile';
import {type CircleGranularity} from '../../render/subdivision_granularity_settings';

import {Painter} from '../../render/painter';
import {Program} from '../../render/program';
import {Buffer, UniformBufferLayout} from '@luma.gl/core';
import {
    BufferSpec,
    blendAdditiveParameters,
    defaultParameters,
    RenderData,
    transparentDepthParameters
} from '../../render/render_data';

const VERTEX_MIN_VALUE = -32768; // -(2^15)

// Extrude is in range 0..7, which will be mapped to -1..1 in the shader.
function addCircleVertex(layoutVertexArray, x, y, extrudeX, extrudeY) {
    // We pack circle position and extrude into range 0..65535, but vertices are stored as *signed* 16-bit integers, so we need to offset the number by 2^15.
    layoutVertexArray.emplaceBack(
        VERTEX_MIN_VALUE + (x * 8) + extrudeX,
        VERTEX_MIN_VALUE + (y * 8) + extrudeY);
}

export class CircleRenderData extends RenderData<CircleStyleLayer> {
    propertyBuffer: Buffer;
    drawBuffer: Buffer;

    static propertyBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'CircleUniforms',
            group: 0,
            location: 2,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
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
        })
    };

    static drawBuffer: BufferSpec = {
        binding: {
            type: 'uniform',
            name: 'DrawUBO',
            group: 0,
            location: 3,
            visibility: 3,
        },
        layout: new UniformBufferLayout({
            'u_extrude_scale': 'vec2<f32>',
            'u_color_t': 'f32',
            'u_radius_t': 'f32',
            'u_blur_t': 'f32',
            'u_opacity_t': 'f32',
            'u_stroke_color_t': 'f32',
            'u_stroke_width_t': 'f32',
            'u_stroke_opacity_t': 'f32',
        })
    };

    constructor(painter: Painter, layer: CircleStyleLayer, bucket: CircleBucket<any>, program: Program<any>) {
        super(painter, layer, bucket.programConfigurations.get(layer.id), program,
            {
                ...defaultParameters,
                ...blendAdditiveParameters,
                ...transparentDepthParameters
            },
            [CircleRenderData.propertyBuffer.binding, CircleRenderData.drawBuffer.binding]
        );

        this.propertyBuffer = painter.context.device.createBuffer({
            byteLength: CircleRenderData.propertyBuffer.layout.byteLength,
            usage: Buffer.UNIFORM
        });

        this.drawBuffer = painter.context.device.createBuffer({
            byteLength: CircleRenderData.drawBuffer.layout.byteLength,
            usage: Buffer.UNIFORM
        });
    }

    updateBuffers(painter: Painter, layer: CircleStyleLayer, bucket: CircleBucket<any>, pitchWithMap: boolean, extrudeScale: [number, number]) {
        const globals = {zoom: (painter.transform.zoom as any)};
        const programConfiguration = bucket.programConfigurations.get(layer.id);
        this.propertyBuffer.write(CircleRenderData.propertyBuffer.layout.getData({
            'u_color': programConfiguration.getBinderValueOr('circle-color', 'value', [0, 0, 0, 0]),
            'u_stroke_color': programConfiguration.getBinderValueOr('circle-stroke-color', 'value', [0, 0, 0, 0]),
            'u_radius': programConfiguration.getBinderValueOr('circle-radius', 'value', 0),
            'u_blur': programConfiguration.getBinderValueOr('circle-blur', 'value', 0),
            'u_opacity': programConfiguration.getBinderValueOr('circle-opacity', 'value', 0),
            'u_stroke_width': programConfiguration.getBinderValueOr('circle-stroke-width', 'value', 0),
            'u_stroke_opacity': programConfiguration.getBinderValueOr('circle-stroke-opacity', 'value', 0),
            'u_scale_with_map': +(layer.paint.get('circle-pitch-scale') === 'map'),
            'u_pitch_with_map': +(pitchWithMap),
        }));
        this.drawBuffer.write(CircleRenderData.drawBuffer.layout.getData({
            'u_extrude_scale': extrudeScale,
            'u_color_t': programConfiguration.getBinderFactor('circle-color', globals),
            'u_radius_t': programConfiguration.getBinderFactor('circle-radius', globals),
            'u_blur_t': programConfiguration.getBinderFactor('circle-blur', globals),
            'u_opacity_t': programConfiguration.getBinderFactor('circle-opacity', globals),
            'u_stroke_color_t': programConfiguration.getBinderFactor('circle-stroke-color', globals),
            'u_stroke_width_t': programConfiguration.getBinderFactor('circle-stroke-width', globals),
            'u_stroke_opacity_t': programConfiguration.getBinderFactor('circle-stroke-opacity', globals),
        }));
    }
}

/**
 * @internal
 * Circles are represented by two triangles.
 *
 * Each corner has a pos that is the center of the circle and an extrusion
 * vector that is where it points.
 */
export class CircleBucket<Layer extends CircleStyleLayer | HeatmapStyleLayer> implements Bucket {
    index: number;
    zoom: number;
    globalState: Record<string, any>;
    overscaling: number;
    layerIds: Array<string>;
    layers: Array<Layer>;
    stateDependentLayers: Array<Layer>;
    stateDependentLayerIds: Array<string>;

    layoutVertexArray: CircleLayoutArray;
    layoutVertexBuffer: VertexBuffer;
    layoutLumaBuffer: Buffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;
    indexLumaBuffer: Buffer;

    hasPattern: boolean;
    programConfigurations: ProgramConfigurationSet<Layer>;
    segments: SegmentVector;
    uploaded: boolean;

    lumaData: {[_: string]: CircleRenderData};

    constructor(options: BucketParameters<Layer>) {
        this.zoom = options.zoom;
        this.globalState = options.globalState;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;
        this.lumaData = {};

        this.layoutVertexArray = new CircleLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.segments = new SegmentVector();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID) {
        const styleLayer = this.layers[0];
        const bucketFeatures: BucketFeature[] = [];
        let circleSortKey = null;
        let sortFeaturesByKey = false;

        // Heatmap circles are usually large (and map-pitch-aligned), tessellate them to allow curvature along the globe.
        let subdivide = styleLayer.type === 'heatmap';

        // Heatmap layers are handled in this bucket and have no evaluated properties, so we check our access
        if (styleLayer.type === 'circle') {
            const circleStyle = (styleLayer as CircleStyleLayer);
            circleSortKey = circleStyle.layout.get('circle-sort-key');
            sortFeaturesByKey = !circleSortKey.isConstant();

            // Circles that are "printed" onto the map surface should be tessellated to follow the globe's curvature.
            subdivide = subdivide || circleStyle.paint.get('circle-pitch-alignment') === 'map';
        }

        const granularity = subdivide ? options.subdivisionGranularity.circle : 1;

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const needGeometry = this.layers[0]._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom, {globalState: this.globalState}), evaluationFeature, canonical)) continue;

            const sortKey = sortFeaturesByKey ?
                circleSortKey.evaluate(evaluationFeature, {}, canonical) :
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
            const feature = features[index].feature;

            this.addFeature(bucketFeature, geometry, index, canonical, granularity);
            options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {[_: string]: ImagePosition}) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions,
            globalState: this.globalState
        });
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending() {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    getOrCreateRenderData(painter: Painter, layer: CircleStyleLayer, program: Program<any>, onCreated?: (_: CircleRenderData) => void): CircleRenderData {
        const data = this.lumaData[layer.id];
        if (data) {
            return data;
        }

        const renderData = new CircleRenderData(painter, layer, this, program);
        renderData.vertexArray.setBuffer(0, this.layoutVertexBuffer.getLumaBuffer());
        renderData.vertexArray.setIndexBuffer(this.indexBuffer.getLumaBuffer());
        onCreated(renderData);

        this.lumaData[layer.id] = renderData
        return renderData;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, canonical: CanonicalTileID, granularity: CircleGranularity = 1) {
        // Since we store the circle's center in each vertex, we only have 3 bits for actual vertex position in each axis.
        // Thus the valid range of positions is 0..7.
        // This gives us 4 possible granularity settings that are symmetrical.

        // This array stores vertex positions that should by used by the tessellated quad.
        let extrudes: Array<number>;

        switch (granularity) {
            case 1:
                extrudes = [0, 7];
                break;
            case 3:
                extrudes = [0, 2, 5, 7];
                break;
            case 5:
                extrudes = [0, 1, 3, 4, 6, 7];
                break;
            case 7:
                extrudes = [0, 1, 2, 3, 4, 5, 6, 7];
                break;
            default:
                throw new Error(`Invalid circle bucket granularity: ${granularity}; valid values are 1, 3, 5, 7.`);
        }

        const verticesPerAxis = extrudes.length;

        for (const ring of geometry) {
            for (const point of ring) {
                const vx = point.x;
                const vy = point.y;

                // Do not include points that are outside the tile boundaries.
                if (vx < 0 || vx >= EXTENT || vy < 0 || vy >= EXTENT) {
                    continue;
                }

                const segment = this.segments.prepareSegment(verticesPerAxis * verticesPerAxis, this.layoutVertexArray, this.indexArray, feature.sortKey);
                const index = segment.vertexLength;

                for (let y = 0; y < verticesPerAxis; y++) {
                    for (let x = 0; x < verticesPerAxis; x++) {
                        addCircleVertex(this.layoutVertexArray, vx, vy, extrudes[x], extrudes[y]);
                    }
                }

                for (let y = 0; y < verticesPerAxis - 1; y++) {
                    for (let x = 0; x < verticesPerAxis - 1; x++) {
                        const lowerIndex = index + y * verticesPerAxis + x;
                        const upperIndex = index + (y + 1) * verticesPerAxis + x;
                        this.indexArray.emplaceBack(lowerIndex, upperIndex + 1, lowerIndex + 1);
                        this.indexArray.emplaceBack(lowerIndex, upperIndex, upperIndex + 1);
                    }
                }

                segment.vertexLength += verticesPerAxis * verticesPerAxis;
                segment.primitiveLength += (verticesPerAxis - 1) * (verticesPerAxis - 1) * 2;
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions: {}, canonical, globalState: this.globalState});
    }
}

register('CircleBucket', CircleBucket, {omit: ['layers']});
