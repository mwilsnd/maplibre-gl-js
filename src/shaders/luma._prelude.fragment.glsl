#ifdef GL_ES
precision mediump float;
#else

#if !defined(lowp)
#define lowp
#endif

#if !defined(mediump)
#define mediump
#endif

#if !defined(highp)
#define highp
#endif

#endif

layout (std140) uniform GlobeProjectionUBO {
    highp vec2 u_translate;
    highp float u_globe_extrude_scale;
    highp float u_device_pixel_ratio;
    highp float u_camera_to_center_distance;
    highp float u_aspect_ratio;
    highp vec2 u_units_to_pixels;
};

out highp vec4 fragColor;
