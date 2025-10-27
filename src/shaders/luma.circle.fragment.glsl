in vec3 v_data;
in float v_visibility;

layout (std140) uniform CircleUniforms {
    highp vec4 u_color;
    highp vec4 u_stroke_color;
    mediump float u_radius;
    lowp float u_blur;
    lowp float u_opacity;
    mediump float u_stroke_width;
    lowp float u_stroke_opacity;
    bool u_scale_with_map;
    bool u_pitch_with_map;
    lowp float props_padding;
};

#pragma maplibre: define highp vec4 color
#pragma maplibre: define mediump float radius
#pragma maplibre: define lowp float blur
#pragma maplibre: define lowp float opacity
#pragma maplibre: define highp vec4 stroke_color
#pragma maplibre: define mediump float stroke_width
#pragma maplibre: define lowp float stroke_opacity

void main() {
    #pragma maplibre: initialize highp vec4 color
    #pragma maplibre: initialize mediump float radius
    #pragma maplibre: initialize lowp float blur
    #pragma maplibre: initialize lowp float opacity
    #pragma maplibre: initialize highp vec4 stroke_color
    #pragma maplibre: initialize mediump float stroke_width
    #pragma maplibre: initialize lowp float stroke_opacity

    vec2 extrude = v_data.xy;
    float extrude_length = length(extrude);
    float antialiased_blur = v_data.z;

    float opacity_t = smoothstep(0.0, antialiased_blur, extrude_length - 1.0);

    float color_t = stroke_width < 0.01 ? 0.0 : smoothstep(antialiased_blur, 0.0, extrude_length - radius / (radius + stroke_width));

    fragColor = v_visibility * opacity_t * mix(color * opacity, stroke_color * stroke_opacity, color_t);

    const float epsilon = 0.5 / 255.0;
    if (fragColor.r < epsilon && fragColor.g < epsilon && fragColor.b < epsilon && fragColor.a < epsilon) {
        // If this pixel wouldn't affect the framebuffer contents in any way, discard it for performance.
        // This disables early-Z test, but that is likely irrelevant for circles, performance wise.
        // But many circles might put a lot of load on the blending and framebuffer output hardware due to using a lot of pixels,
        // and this discard will help in that case.
        // Also, each circle will at most use ~3/4 of its rasterized pixels, due to being a circle approximated with a square,
        // this will discard the unused 1/4.
        // Also note that this discard happens even if overdraw inspection is enabled - because discarded pixels never contribute to overdraw.
        discard;
    }

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
