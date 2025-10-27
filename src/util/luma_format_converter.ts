import {AttributeShaderType, VertexFormat} from "@luma.gl/core";

const VertexFormatLookup = {
    'Float32': 'float32',
    'Int32': 'sint323',
    'Uint32': 'uint32',
    'Int16': 'sint16',
    'Uint16': 'uint16',
    'Int8': 'sint8',
    'Uint8': 'uint8',
};

const AttributeShaderTypeLookup = {
    'Float32': 'f32',
    'Int32': 'i32',
    'Uint32': 'u32',
    'Uint16': 'u32',
    'Float16': 'f16',
};

export function toLumaVertexFormat(type: string, numComponents: number): VertexFormat {
    return (numComponents > 1 ? `${VertexFormatLookup[type]}x${numComponents}` : VertexFormatLookup[type]) as VertexFormat;
}

export function toLumaAttributeShaderType(type: string, numComponents: number): AttributeShaderType {
    if (numComponents > 1) {
        return `vec${numComponents}<${AttributeShaderTypeLookup[type]}>` as AttributeShaderType;
    } else {
        return AttributeShaderTypeLookup[type] as AttributeShaderType;
    }
}