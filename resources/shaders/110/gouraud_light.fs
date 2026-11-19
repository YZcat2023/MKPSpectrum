#version 110

uniform vec4 uniform_color;
uniform float emission_factor;

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


// x = tainted, y = specular;
varying vec2 intensity;
varying float v_world_z;

void main()
{
    gl_FragColor = vec4(vec3(intensity.y) + uniform_color.rgb * (intensity.x + emission_factor),
                        shell_alpha_at(v_world_z, uniform_color.a));
}
