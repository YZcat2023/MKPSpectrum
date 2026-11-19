#version 110

// Same two-light rig as gouraud.fs / texture_displacement_shaded.fs, so a textured volume sits in the
// scene with the same shading as the volumes next to it; the albedo is the picture, tinted by
// uniform_color (only its alpha is meaningful today - it carries a faded / hidden volume).

#define INTENSITY_CORRECTION 0.6

const vec3 LIGHT_TOP_DIR   = vec3(-0.4574957, 0.4574957, 0.7624929);
#define LIGHT_TOP_DIFFUSE  (0.28 * INTENSITY_CORRECTION)
const vec3 LIGHT_FRONT_DIR = vec3(0.6985074, 0.1397015, 0.6985074);
#define LIGHT_FRONT_DIFFUSE (0.12 * INTENSITY_CORRECTION)
// The albedo here is the file's picture, not a filament colour: it has to read as the picture
// even on a face pointing away from both lights, so the ambient term carries most of the
// brightness and the two lights only add the shape cue on top (max ~1.0).
#define INTENSITY_AMBIENT  0.78

uniform sampler2D uniform_texture;
// Selection glow: the picture is drawn again, inflated in screen space (see model_texture.vs)
// and kept outside the silhouette by the stencil test. Only uniform_tint is used then - its
// rgb is the light colour and its alpha the ring strength.
uniform bool  is_outline;

uniform vec4      uniform_tint;

// Preview shell: the model's skin is drawn over the toolpaths and its alpha follows the printed
// height the layer slider shows - solid across the layers being shown, a faint ghost above and
// below them. shell_alpha_z is (bottom z, top z) and only has bottom < top while the shell pass in
// GCodeViewer::render_shells() is drawing; everywhere else the alpha stays the caller's own.
uniform vec2 shell_alpha_z;
uniform vec2 shell_alpha;

float shell_alpha_at(float z, float alpha)
{
    if (shell_alpha_z.y <= shell_alpha_z.x)
        return alpha;
    float band = min(0.4, 0.25 * (shell_alpha_z.y - shell_alpha_z.x));
    float t = smoothstep(shell_alpha_z.x - band, shell_alpha_z.x + band, z) *
              (1.0 - smoothstep(shell_alpha_z.y - band, shell_alpha_z.y + band, z));
    return mix(shell_alpha.x, shell_alpha.y, t);
}


varying vec2 tex_coord;
varying vec3 eye_normal;
varying float v_world_z;

void main()
{
    if (is_outline) {
        out_color = vec4(uniform_tint.rgb, uniform_tint.a);
        return;
    }

    vec3 albedo = texture2D(uniform_texture, tex_coord).rgb * uniform_tint.rgb;
    vec3 n      = normalize(eye_normal);
    float intensity = INTENSITY_AMBIENT
                    + max(dot(n, LIGHT_TOP_DIR), 0.0)   * LIGHT_TOP_DIFFUSE
                    + max(dot(n, LIGHT_FRONT_DIR), 0.0) * LIGHT_FRONT_DIFFUSE;
    gl_FragColor = vec4(albedo * intensity, shell_alpha_at(v_world_z, uniform_tint.a));
}