layout (std140) uniform BackgroundUniforms {
    highp vec4 u_color;
    highp float u_opacity;
};

void main() {
    fragColor = u_color * u_opacity;

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
