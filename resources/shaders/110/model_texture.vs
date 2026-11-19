#version 110

// Draws a volume with the texture it was imported with, instead of with the printable colours the
// import derives from the same picture. See GLVolume::render_texture_display().

uniform mat4 view_model_matrix;
uniform mat4 projection_matrix;
uniform mat3 view_normal_matrix;
// Selection glow: the same picture drawn again, pushed outwards in screen space, so the copy that
// the stencil test leaves visible is a band hugging the silhouette. See GLVolumeCollection::render().
uniform bool  is_outline;
uniform vec2  screen_size;
uniform float outline_px;
// World z of the fragment, for the preview shell's height ramp (see model_texture.fs).
uniform mat4  volume_world_matrix;

attribute vec3 v_position;
attribute vec3 v_normal;
attribute vec2 v_tex_coord;

varying vec2 tex_coord;
varying vec3 eye_normal;
varying float v_world_z;

void main()
{
    tex_coord  = v_tex_coord;
    eye_normal = normalize(view_normal_matrix * v_normal);
    v_world_z  = (volume_world_matrix * vec4(v_position, 1.0)).z;
    gl_Position = projection_matrix * view_model_matrix * vec4(v_position, 1.0);
    if (is_outline) {
        // Push each vertex away from the part's axis in screen space. On the silhouette the eye
        // space normal points outwards, so this inflates the silhouette by outline_px pixels.
        vec2  d = (view_normal_matrix * v_normal).xy;
        float l = length(d);
        if (l > 1e-5)
            gl_Position.xy += (d / l) * (outline_px * 2.0 / screen_size) * gl_Position.w;
    }
}