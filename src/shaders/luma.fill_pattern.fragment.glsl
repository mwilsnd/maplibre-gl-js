#ifdef GL_ES
    precision highp float;
#endif

layout (std140) uniform FillPatternUniforms {
    lowp vec4 u_pattern_from;
    lowp vec4 u_pattern_to;
    vec2 u_fill_translate;
    vec2 u_texsize;
    vec2 u_pixel_coord_upper;
    vec2 u_pixel_coord_lower;
    vec3 u_scale;
    highp float u_fade;
    lowp float u_opacity;
    lowp float u_pixel_ratio_from;
    lowp float u_pixel_ratio_to;
};

layout (std140) uniform DrawUJniforms {
    float u_pattern_from_t;
    float u_pattern_to_t;
    float u_opacity_t;
    float u_pixel_ratio_from_t;
    float u_pixel_ratio_to_t;
};

uniform sampler2D u_image;

in vec2 v_pos_a;
in vec2 v_pos_b;

#pragma maplibre: define lowp float opacity
#pragma maplibre: define lowp vec4 pattern_from
#pragma maplibre: define lowp vec4 pattern_to

void main() {
    #pragma maplibre: initialize lowp float opacity
    #pragma maplibre: initialize mediump vec4 pattern_from
    #pragma maplibre: initialize mediump vec4 pattern_to

    vec2 pattern_tl_a = pattern_from.xy;
    vec2 pattern_br_a = pattern_from.zw;
    vec2 pattern_tl_b = pattern_to.xy;
    vec2 pattern_br_b = pattern_to.zw;

    vec2 imagecoord = mod(v_pos_a, 1.0);
    vec2 pos = mix(pattern_tl_a / u_texsize, pattern_br_a / u_texsize, imagecoord);
    vec4 color1 = texture(u_image, pos);

    vec2 imagecoord_b = mod(v_pos_b, 1.0);
    vec2 pos2 = mix(pattern_tl_b / u_texsize, pattern_br_b / u_texsize, imagecoord_b);
    vec4 color2 = texture(u_image, pos2);

    fragColor = mix(color1, color2, u_fade) * opacity;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
