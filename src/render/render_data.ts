import {StyleLayer} from '../style/style_layer';
import {Painter} from './painter';
import {
    RenderPipeline,
    type ShaderLayout,
    type BufferLayout,
    ColorParameters,
    UniformBufferLayout,
    VertexArray,
    DepthStencilParameters,
    RenderPipelineParameters,
    BindingDeclaration,
    RenderPass,
    VertexFormat,
    AttributeShaderType,
    BufferAttributeLayout,
    AttributeDeclaration
} from '@luma.gl/core';
import {Program} from './program';
import {ProgramConfiguration} from '../data/program_configuration';
import {VertexBuffer} from '../gl/vertex_buffer';
import {SegmentVector} from '../data/segment';

export type BufferSpec = {
    binding: BindingDeclaration;
    layout: UniformBufferLayout;
};

export const defaultParameters: RenderPipelineParameters = {
    cullMode: 'back',
};

export const transparentDepthParameters: DepthStencilParameters = {
    depthWriteEnabled: false,
    depthCompare: 'less-equal',
    depthFormat: 'depth24plus-stencil8',
};

export const opaqueDepthParameters: DepthStencilParameters = {
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
    depthFormat: 'depth24plus-stencil8',
};

export const blendAdditiveParameters: ColorParameters = {
    blend: true, // TODO: _showOverdrawInspector
    blendColorOperation: 'add',
    blendAlphaOperation: 'add',
    blendColorSrcFactor: 'one',
    blendColorDstFactor: 'one-minus-src-alpha',
    blendAlphaSrcFactor: 'one',
    blendAlphaDstFactor: 'one-minus-src-alpha',
};

export const blendOpaqueParameters: ColorParameters = {
    blend: false,
    blendColorOperation: 'add',
    blendAlphaOperation: 'add',
    blendColorSrcFactor: 'one',
    blendColorDstFactor: 'zero',
    blendAlphaSrcFactor: 'one',
    blendAlphaDstFactor: 'zero',
};

type RenderDataAttributeBindingPredicate = (buffer: VertexBuffer) => boolean;

export type LumaAttribute = {
    name: string,
    format?: VertexFormat,
    type: AttributeShaderType,
    byteStride: number,
    location: number,
    attributes?: BufferAttributeLayout[]
};

export class RenderData<LayerStyle extends StyleLayer> {
    pipeline: RenderPipeline;
    vertexArray: VertexArray;

    constructor(
        painter: Painter,
        layer: LayerStyle,
        programConfiguration: ProgramConfiguration,
        program: Program<any>,
        pipelineParams: RenderPipelineParameters,
        bufferBindings: BindingDeclaration[],
        attributeBindingPredicate?: RenderDataAttributeBindingPredicate,
        bufferLayout_?: BufferLayout[],
        shaderAttributes?: AttributeDeclaration[])
    {
        const bufferLayout: BufferLayout[] = bufferLayout_ ? bufferLayout_ : [
            {name: 'a_pos', format: 'sint16x2', byteStride: 4},
        ];

        const shaderLayout: ShaderLayout = {
            attributes: shaderAttributes ? shaderAttributes : [
                {location: 0, name: 'a_pos', type: 'vec2<f32>'},
            ],
            bindings: [
                painter.projectionParameterBindingDecl,
                painter.globeBufferBindingDecl,
                ...bufferBindings
            ],
        };

        let dataDrivenAttributeBindingIndex = shaderLayout.attributes.length;
        programConfiguration.updateLumaPipelineLayouts(1, bufferLayout, shaderLayout);

        this.pipeline = painter.context.device.createRenderPipeline({
            id: layer.id,
            vs: program.vertexShader,
            fs: program.fragmentShader,
            topology: 'triangle-list',
            shaderLayout: shaderLayout,
            bufferLayout: bufferLayout,
            parameters: pipelineParams
        });

        this.vertexArray = painter.context.device.createVertexArray({
            shaderLayout: this.pipeline.shaderLayout,
            bufferLayout: this.pipeline.bufferLayout
        });

        const binderAttrs = programConfiguration.getAttributeMetadata();
        for (const buffer of programConfiguration.getPaintVertexBuffers()) {
            if (!binderAttrs[buffer.attributes[0].name]) {
                continue;
            }

            if (attributeBindingPredicate && !attributeBindingPredicate(buffer)) {
                continue;
            }

            this.vertexArray.setBuffer(dataDrivenAttributeBindingIndex, buffer.getLumaBuffer());
            dataDrivenAttributeBindingIndex++;
        }
    }

    drawSegments(segments: SegmentVector, pass: RenderPass) {
        for (const segment of segments.get()) {
            this.pipeline.draw({
                topology: 'triangle-list',
                renderPass: pass,
                vertexArray: this.vertexArray,
                firstVertex: segment.primitiveOffset * 3 * 2,
                vertexCount: segment.primitiveLength * 3,
            });
        }
    }
}
