#pragma once

#include <array>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct indexed_triangle_set;

namespace Slic3r {

class TriangleMesh;
class ModelVolume;

struct TextureImage {
    int width  = 0;
    int height = 0;
    int channels = 4;
    std::vector<unsigned char> data;
};

struct TexturedMesh {
    std::vector<std::array<float,3>>  vertices;
    std::vector<std::array<int,3>>    indices;
    std::vector<std::array<float,2>>  uvs;
    std::vector<TextureImage>         textures;
    std::vector<int>                  material_ids;
    // material index -> index in textures[] (-1 if no texture, use material_colors)
    std::vector<int>                  material_texture_map;
    // per-material baseColorFactor (RGBA 0-1), indexed by material index
    std::vector<std::array<float,4>>  material_colors;

    // Per-face independent UV support (for OBJ where the same vertex can have
    // different texture coordinates on different faces).
    std::vector<std::array<float,2>>  uv_coords;   // UV coordinate pool
    std::vector<std::array<int,3>>    uv_indices;   // per-face UV indices into uv_coords

    bool has_face_uvs() const { return !uv_indices.empty() && !uv_coords.empty(); }

    // Pre-computed per-face colors (e.g. from OBJ vertex colors or MTL Kd).
    // When non-empty, the pipeline skips texture decode/sample/oversample and
    // consumes these instead of sampling a texture.
    // Each entry is {R, G, B} in [0..255].
    std::vector<std::array<std::size_t,3>> precomputed_face_colors;

    // Per-vertex colors from OBJ (RGBA, [0..1]), indexed by vertex index.
    // On a low-poly mesh these are quantized into a small palette and the mesh is
    // split along the resulting cluster boundaries, so color borders stay sharp
    // instead of being averaged away into a single color per face.
    std::vector<std::array<float,4>> precomputed_vertex_colors;
};

// What the 3D editor needs to draw a volume with the texture the file shipped with, instead of the
// printable colours the import pipeline derives from it. One entry per triangle of the volume mesh,
// in that mesh's own face order, and one image per distinct material map.
struct TextureDisplayData
{
    struct Image
    {
        int                        width  = 0;
        int                        height = 0;
        // width * height * 3, RGB, row 0 at v = 0 (any flip is already folded into face_uv).
        std::vector<unsigned char> rgb;
    };

    // The three uvs of every face, corner for corner.
    std::vector<std::array<std::array<float, 2>, 3>> face_uv;
    // Entry of images[] a face samples, or -1 when its material carried no map.
    std::vector<int>                 face_image;
    // Albedo for the faces whose material had no map, 0..1.
    std::vector<std::array<float, 3>> face_rgb;
    std::vector<Image>               images;

    bool empty() const { return face_uv.empty(); }
};

// Decode `mesh`'s images and lay its per-face uvs out for TextureDisplayData. False when the mesh
// carries no uv layout at all, or when none of its images decodes.
bool build_texture_display_data(const TexturedMesh &mesh, TextureDisplayData &out);

// Serializes display data for a project file. A project cannot rebuild the picture from the geometry, so
// the images travel with the volume that samples them; the uvs stay raw floats so a round trip does not
// drift the mapping, and the images go in as PNG because that is what makes the blob small enough to
// carry through every save. Returns an empty vector for empty data.
std::vector<unsigned char> texture_display_to_bytes(const TextureDisplayData &display);
// Reads back what texture_display_to_bytes() wrote. False on anything that is not one of those blobs
// (an older project, a truncated file), leaving `out` empty rather than half-filled.
bool texture_display_from_bytes(const unsigned char *data, size_t size, TextureDisplayData &out);

struct PaintedMesh {
    std::vector<std::array<float,3>>            vertices;
    std::vector<std::array<int,3>>              indices;
    std::vector<std::array<std::size_t,3>>      face_colors;   // per-face RGB [0..255]
    std::vector<std::array<std::size_t,3>>      cluster_colors;
};

using PaintProgressCallback = std::function<void(int percent, const char* message)>;
using PaintCancelCallback   = std::function<bool()>;
using PaintMeshRepairCallback = std::function<bool(const indexed_triangle_set& mesh,
                                                   indexed_triangle_set&       repaired_mesh,
                                                   std::function<void(const char* message, unsigned progress)> progress_callback,
                                                   std::function<bool()> cancel_callback,
                                                   std::string* error_message)>;

struct TexturePaintingSettings {
    std::size_t target_colors_num  = 4;
    double      smooth_weight      = 0.5;
    std::size_t oversampling_iters = 0;
    enum class MeshRepairDecision {
        Ask,
        ImportWithoutRepair,
        RepairAndImport
    };
    MeshRepairDecision mesh_repair_decision = MeshRepairDecision::ImportWithoutRepair;
    bool* mesh_repair_decision_required = nullptr;
    PaintMeshRepairCallback mesh_repair_callback;
};

struct FilamentMatch {
    int    cluster_index   = -1;
    int    filament_index  = -1;
    double delta_e         = 0.0;
    std::array<std::size_t,3> cluster_color   = {0,0,0};
    std::array<float,4>       filament_color  = {0,0,0,1};
};

bool texture_to_painting(
    const TexturedMesh& textured,
    PaintedMesh& painted,
    const TexturePaintingSettings& settings = {},
    PaintProgressCallback progress = nullptr,
    PaintCancelCallback cancel = nullptr);
// Turn pre-computed per-face colors into a painted mesh, skipping texture decode
// and UV sampling. A low-poly mesh that also carries precomputed_vertex_colors is
// split along quantized color boundaries, which replaces its geometry.
bool face_colors_to_painting(
    const TexturedMesh& mesh,
    PaintedMesh& painted,
    const TexturePaintingSettings& settings = {},
    PaintProgressCallback progress = nullptr,
    PaintCancelCallback cancel = nullptr);


std::vector<FilamentMatch> match_clusters_to_filaments(
    const std::vector<std::array<std::size_t,3>>& cluster_colors,
    const std::vector<std::array<float,4>>& filament_colors,
    const std::vector<std::string>& filament_names);

double compute_delta_e(
    const std::array<std::size_t,3>& rgb1,
    const std::array<float,4>& rgba2);

bool apply_painted_mesh_to_volume(
    const PaintedMesh& painted,
    const std::vector<FilamentMatch>& matches,
    ModelVolume& volume);

// Decode a TextureImage (which may contain raw PNG/JPEG bytes) into BGR pixel data.
// On success, populates out_pixels (BGR, 3 bytes/pixel) and sets out_w/out_h.
bool decode_texture_to_pixels(
    const TextureImage& img,
    std::vector<unsigned char>& out_pixels,
    int& out_w, int& out_h);

// Sample per-face colors from the correct texture per material_ids.
// Uses material_texture_map / material_colors for multi-material GLBs.
// Falls back to textures[0] when the mapping is absent.
bool sample_original_face_colors(
    const TexturedMesh& textured,
    std::vector<std::array<std::size_t,3>>& out_face_colors);

} // namespace Slic3r
