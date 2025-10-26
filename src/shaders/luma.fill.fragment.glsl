layout (std140) uniform FillEvaluatedPropsUBO {
    highp vec4 u_color;
    highp vec2 u_fill_translate;
    lowp float u_color_t;
    highp float u_opacity;
    lowp float u_opacity_t;
};

#pragma maplibre: define highp vec4 color
#pragma maplibre: define lowp float opacity

void main() {
    #pragma maplibre: initialize highp vec4 color
    #pragma maplibre: initialize lowp float opacity

    fragColor = color * opacity;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
