#include "MkpInkjetProgress.hpp"

#include <memory>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <limits>
#include <map>
#include <utility>
#include <vector>

#include <boost/filesystem.hpp>
#include <boost/log/trivial.hpp>

#include "BoundingBox.hpp"
#include "Layer.hpp"
#include "MkpMbd.hpp"
#include "Model.hpp"
#include "PNGReadWrite.hpp"
#include "Print.hpp"
#include "TextureDisplacement.hpp"
#include "Zipper.hpp"

namespace Slic3r {
namespace mkp {
namespace {

// The geometry is the post-processor's (strip_processor.py): a 14.29 mm head bar, a 9.99 mm step
// between passes, a 20 mm merge gap, and a 7 mm lead-in before every block. It wrote no tail.
constexpr double HEAD_WIDTH_MM    = 14.29;
constexpr double STEP_MM          = HEAD_WIDTH_MM - 2. * 2.15;   // 9.99 mm, the dead 2.15 mm at each end of the bar
constexpr double BLOCK_GAP_MM     = 20.;
constexpr double BLOCK_LEADIN_MM  = 7.;
// The head addresses MBD_STRIP_ROWS rows across the bar, so this is the only pixel size the strip
// can have. Everything below rasterises straight onto that grid - there is no downscaling step left.
constexpr double MM_PER_PX        = HEAD_WIDTH_MM / double(MBD_STRIP_ROWS);
// The post-processor's density of 60, i.e. the -colorize 40 every strip we validated was made with.
// InkjetParams::density is a multiplier on that 60%, and the encoder takes (100 - percent), so 1.0
// lands on 40 exactly and the default print stays byte-identical to the validated one.
int inkjet_blend(const double density)
{
    const double percent = 60. * std::max(0.01, density);
    return std::min(99, std::max(0, int(std::lround(100. - percent))));
}

// strip_processor.py's apply_cmy_adjustment: split the colour into the three inks, scale each, put it
// back, then saturation / brightness / contrast.
//
// The old code damped every step by (max_channel / 60)^2, so a tweak reached the midtones and left
// the shadows almost untouched: the printed tone could never match the sliders. That "dark-area
// protection" was tried and rejected - the knobs now act on every pixel, straight, and only the
// final clamp keeps the result in range.
void adjust_ink_color(const InkjetParams &params, uint8_t &r8, uint8_t &g8, uint8_t &b8)
{
    if (params.c == 1. && params.m == 1. && params.y == 1. && params.saturation == 0. &&
        params.brightness == 0. && params.contrast == 1.)
        return;
    double arr[3] = { double(r8), double(g8), double(b8) };
    double ch[3] = { 1. - arr[0] / 255., 1. - arr[1] / 255., 1. - arr[2] / 255. };
    const double factor[3] = { params.c, params.m, params.y };
    for (int i = 0; i < 3; ++i) {
        if (factor[i] == 1.)
            continue;
        ch[i] = std::min(1., std::max(0., ch[i] * factor[i]));
    }
    for (int i = 0; i < 3; ++i)
        arr[i] = (1. - ch[i]) * 255.;
    if (params.saturation != 0.) {
        const double gray = arr[0] * 0.299 + arr[1] * 0.587 + arr[2] * 0.114;
        const double f    = params.saturation + 1.;
        for (int i = 0; i < 3; ++i)
            arr[i] = gray + (arr[i] - gray) * f;
    }
    if (params.brightness > 0.) {
        for (int i = 0; i < 3; ++i)
            arr[i] = arr[i] * (1. - params.brightness) + 255. * params.brightness;
    } else if (params.brightness < 0.) {
        for (int i = 0; i < 3; ++i)
            arr[i] = arr[i] * (1. + params.brightness);
    }
    if (params.contrast != 1.)
        for (int i = 0; i < 3; ++i)
            arr[i] = (arr[i] - 128.) * params.contrast + 128.;
    const double out[3] = { std::min(255., std::max(0., arr[0])),
                            std::min(255., std::max(0., arr[1])),
                            std::min(255., std::max(0., arr[2])) };
    r8 = uint8_t(std::lround(out[0]));
    g8 = uint8_t(std::lround(out[1]));
    b8 = uint8_t(std::lround(out[2]));
}
// strip_processor's find_non_white_blocks() called 250/255 white; anything that pale carries no ink.
constexpr float  WHITE_LEVEL      = 250.f / 255.f;
// A runaway raster would eat gigabytes on a pathological model; a layer this big is not sprayable.
constexpr size_t MAX_RASTER_PIXELS = 40u * 1000u * 1000u;

struct PaintedTriangle
{
    Vec3f a, b, c, normal;
    // The model's own uv for each of those three corners, when the layer maps through them.
    Vec2f uv[3] = { Vec2f::Zero(), Vec2f::Zero(), Vec2f::Zero() };
    float z_min = 0.f, z_max = 0.f;
};

struct PaintedSurface
{
    std::vector<PaintedTriangle>    triangles;
    const TextureDisplacementLayer *layer = nullptr;
    // Set when the volume's own uv layout overrides the layer's stored projection. Held by unique_ptr
    // so the surface can be moved into the vector without pulling the layer out from under `layer`.
    std::unique_ptr<TextureDisplacementLayer> layer_override;
    DecodedHeightTexture            texture;
    // True when this surface is read through the model's own uv layout rather than a projection, so
    // shading interpolates the corner uvs instead of trusting the 3D position.
    bool  use_model_uv = false;
    float z_min = 0.f, z_max = 0.f;
    // The triangles above live in the print frame the layers were sliced in, but every projection
    // method takes its input in the volume's own space - that is the frame the bake and the GUI
    // sample in. Carrying the inverse brings a pixel back before it is sampled; without it a model
    // sitting 135 mm off the origin reads a different part of the tile, which is exactly how a
    // picture ends up in the wrong corner of the plate.
    Transform3d world_to_local = Transform3d::Identity();
    // The patch frame Cylindrical/Spherical wrap around, in the same local space.
    Vec3f patch_center = Vec3f::Zero();
    Vec3f patch_axis   = Vec3f::UnitZ();
};

// The raster one layer is drawn into, on the head's own grid: the colour each pixel will be printed
// with, plus whether there is any to print at all.
struct Raster
{
    const Print         *print = nullptr;
    void check_cancel() const { if (print && print->canceled()) throw CanceledException(); }
    Vec2f                origin;   // lower-left corner of pixel (0, 0), object-local mm
    int                  width  = 0;
    int                  height = 0;
    std::vector<uint8_t> hit;
    std::vector<uint8_t> rgb;      // 3 bytes per pixel, top-left first row is row 0

    void reset()
    {
        std::fill(hit.begin(), hit.end(), uint8_t(0));
        std::fill(rgb.begin(), rgb.end(), uint8_t(255));
    }
    bool empty() const { return width <= 0 || height <= 0; }
};

// A point of a painted triangle clipped to a layer's slab, carrying the model's own uv along so the
// colour is still read from the right place after the clip moved the point.
struct PolyVertex
{
    Vec3f pos;
    Vec2f uv;
};

// Sutherland-Hodgman against one horizontal plane; keep_above keeps z >= plane_z.
void clip_to_plane(std::vector<PolyVertex> &poly, const float plane_z, const bool keep_above)
{
    if (poly.size() < 3)
        return;
    std::vector<PolyVertex> out;
    out.reserve(poly.size() + 1);
    const size_t n = poly.size();
    for (size_t i = 0; i < n; ++i) {
        const PolyVertex &p    = poly[i];
        const PolyVertex &q    = poly[(i + 1) % n];
        const bool        p_in = keep_above ? (p.pos.z() >= plane_z) : (p.pos.z() <= plane_z);
        const bool        q_in = keep_above ? (q.pos.z() >= plane_z) : (q.pos.z() <= plane_z);
        if (p_in)
            out.push_back(p);
        if (p_in != q_in) {
            const float dz = q.pos.z() - p.pos.z();
            if (std::abs(dz) > 1e-12f) {
                const float t = (plane_z - p.pos.z()) / dz;
                out.push_back(PolyVertex{ p.pos + (q.pos - p.pos) * t, p.uv + (q.uv - p.uv) * t });
            }
        }
    }
    poly.swap(out);
}

// One pixel, shaded from the surface point under it. Nothing but white is recorded when the texture
// has no colour there, because white is what the head prints as "not here".
void shade_pixel(Raster &raster, const int x, const int y, const Vec3f &position, const Vec3f &normal,
                 const PaintedSurface &surface, const Vec2f *model_uv)
{
    Vec3f color;
    // The pixel's point is in the print frame; every projection reads the volume's own space, so it
    // is carried back through the object's matrix first. A model-uv surface is sampled at the uv the
    // model gives the point instead, which that matrix does not affect.
    const Vec3f local_pos = (surface.world_to_local * position.cast<double>()).cast<float>();
    const Vec3f local_nrm = (surface.world_to_local.linear() * normal.cast<double>()).cast<float>();
    const bool sampled = sample_layer_color(surface.texture, *surface.layer, local_pos, local_nrm, color,
                                            surface.patch_center, surface.patch_axis,
                                            surface.use_model_uv ? model_uv : nullptr);
    if (! sampled)
        return;
    // Composite sampled RGB, including white, before deciding which pixels carry ink.
    // Dropping white here would let an earlier wall colour show through a later surface.
    const size_t index = size_t(y) * size_t(raster.width) + size_t(x);
    raster.hit[index]  = 1;
    raster.rgb[index * 3]     = uint8_t(std::min(255, std::max(0, int(color.x() * 255.f + 0.5f))));
    raster.rgb[index * 3 + 1] = uint8_t(std::min(255, std::max(0, int(color.y() * 255.f + 0.5f))));
    raster.rgb[index * 3 + 2] = uint8_t(std::min(255, std::max(0, int(color.z() * 255.f + 0.5f))));
}

void rasterize_triangle(Raster &raster, const Vec3f &a, const Vec3f &b, const Vec3f &c, const Vec3f &normal,
                         const Vec2f (&uv)[3], const PaintedSurface &surface,
                         const std::array<PolyVertex, 2> *sample_segment = nullptr,
                         const std::vector<uint8_t> *area_mask = nullptr)
{
    const double area2 = double(b.x() - a.x()) * double(c.y() - a.y()) - double(b.y() - a.y()) * double(c.x() - a.x());
    // Seen edge-on from above, a face covers no pixel. A vertical wall is in this class, and that is
    // correct: a wall is not a surface the head can spray from above.
    if (std::abs(area2) < 1e-10)
        return;

    const double x_min = std::min({ double(a.x()), double(b.x()), double(c.x()) });
    const double x_max = std::max({ double(a.x()), double(b.x()), double(c.x()) });
    const double y_min = std::min({ double(a.y()), double(b.y()), double(c.y()) });
    const double y_max = std::max({ double(a.y()), double(b.y()), double(c.y()) });

    auto to_pixel = [](const double mm, const double origin, const int limit) {
        return std::min(std::max(int(std::floor((mm - origin) / MM_PER_PX)), 0), limit - 1);
    };
    const int x0 = to_pixel(x_min, double(raster.origin.x()), raster.width);
    const int x1 = to_pixel(x_max, double(raster.origin.x()), raster.width);
    const int y0 = to_pixel(y_min, double(raster.origin.y()), raster.height);
    const int y1 = to_pixel(y_max, double(raster.origin.y()), raster.height);
    // A joined wall quad is only coverage geometry. Its slanted end caps must not shear
    // the texture: take colour at the orthogonal projection onto the original wall line.
    const double sample_dx = sample_segment == nullptr ? 0. :
        double((*sample_segment)[1].pos.x()) - double((*sample_segment)[0].pos.x());
    const double sample_dy = sample_segment == nullptr ? 0. :
        double((*sample_segment)[1].pos.y()) - double((*sample_segment)[0].pos.y());
    const double sample_length2 = sample_dx * sample_dx + sample_dy * sample_dy;

    for (int py = y0; py <= y1; ++py) {
        raster.check_cancel();
        const double y = double(raster.origin.y()) + (py + 0.5) * MM_PER_PX;
        for (int px = x0; px <= x1; ++px) {
            if (area_mask != nullptr && !(*area_mask)[size_t(py) * size_t(raster.width) + size_t(px)])
                continue;
            const double x  = double(raster.origin.x()) + (px + 0.5) * MM_PER_PX;
            const double w0 = (double(b.x() - x) * double(c.y() - y) - double(b.y() - y) * double(c.x() - x)) / area2;
            const double w1 = (double(c.x() - x) * double(a.y() - y) - double(c.y() - y) * double(a.x() - x)) / area2;
            const double w2 = 1. - w0 - w1;
            if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9)
                continue;
            // The face is planar, so the 3D point is affine in xy: this interpolates the point on the
            // surface itself, which is where the colour is sampled from.
            Vec3f position = a * float(w0) + b * float(w1) + c * float(w2);
            // Affine in xy exactly as the position is, so this is the uv of the point on the face.
            Vec2f model_uv(uv[0] * float(w0) + uv[1] * float(w1) + uv[2] * float(w2));
            if (sample_segment != nullptr) {
                const PolyVertex &start = (*sample_segment)[0];
                const PolyVertex &end   = (*sample_segment)[1];
                const float t = sample_length2 <= 1e-12 ? 0.f : float(std::clamp(
                    ((x - double(start.pos.x())) * sample_dx +
                     (y - double(start.pos.y())) * sample_dy) / sample_length2, 0., 1.));
                position = start.pos + (end.pos - start.pos) * t;
                model_uv = start.uv + (end.uv - start.uv) * t;
            }
            shade_pixel(raster, px, py, position, normal, surface, &model_uv);
        }
    }
}

void rasterize_polygon(Raster &raster, const std::vector<PolyVertex> &poly, const Vec3f &normal,
                       const PaintedSurface &surface, const std::vector<uint8_t> &area_mask)
{
    // A triangle cut by two parallel planes stays convex, so a fan from its first vertex covers it.
    for (size_t i = 1; i + 1 < poly.size(); ++i) {
        const Vec2f uv[3] = { poly[0].uv, poly[i].uv, poly[i + 1].uv };
        rasterize_triangle(raster, poly[0].pos, poly[i].pos, poly[i + 1].pos, normal, uv, surface,
                           nullptr, &area_mask);
    }
}

// Side-wall triangles also project to an area when clipped to a finite-height slab.
// That projection is not a top/bottom surface and must not overwrite the wall's texture row.
// Build one scanline mask from Orca's actual external fill surfaces, including their holes.
std::vector<uint8_t> external_surface_mask(const Layer &layer, const Raster &raster)
{
    std::vector<uint8_t> mask(size_t(raster.width) * size_t(raster.height), uint8_t(0));
    std::vector<double> crossings;
    for (const LayerRegion *region : layer.regions()) {
        for (const Surface &surface : region->fill_surfaces.surfaces) {
            if (!surface.is_external() || surface.expolygon.empty())
                continue;
            const ExPolygon &expolygon = surface.expolygon;
            for (int py = 0; py < raster.height; ++py) {
                raster.check_cancel();
                const double y = double(raster.origin.y()) + (py + 0.5) * MM_PER_PX;
                crossings.clear();
                auto intersect_ring = [&](const Polygon &ring) {
                    if (ring.points.empty())
                        return;
                    for (size_t i = 0, j = ring.points.size() - 1; i < ring.points.size(); j = i++) {
                        const Vec2d a = unscale(ring.points[j]);
                        const Vec2d b = unscale(ring.points[i]);
                        if ((a.y() > y) != (b.y() > y))
                            crossings.push_back(a.x() + (y - a.y()) * (b.x() - a.x()) / (b.y() - a.y()));
                    }
                };
                intersect_ring(expolygon.contour);
                for (const Polygon &hole : expolygon.holes)
                    intersect_ring(hole);
                std::sort(crossings.begin(), crossings.end());
                for (size_t i = 0; i + 1 < crossings.size(); i += 2) {
                    const int x0 = std::max(0, int(std::ceil(
                        (crossings[i] - double(raster.origin.x())) / MM_PER_PX - 0.5)));
                    const int x1 = std::min(raster.width, int(std::ceil(
                        (crossings[i + 1] - double(raster.origin.x())) / MM_PER_PX - 0.5)));
                    if (x1 > x0)
                        std::fill(mask.begin() + size_t(py) * size_t(raster.width) + size_t(x0),
                                  mask.begin() + size_t(py) * size_t(raster.width) + size_t(x1), uint8_t(1));
                }
            }
        }
    }
    return mask;
}

// Walls are seen edge-on from above and cover no pixel, but the section contour is still sprayed:
// the post-processor stroked it with a 7 px nib on its 4000 px / 270 mm canvas, which is 0.945 mm of
// ink either side of the line, and that band is what a wall-only layer prints as. A face whose
// projected area collapses to a line is such a wall, so it is stroked instead of filled.
// slice_standalone.py sized its nib from the canvas, not from the model: line_width =
// max(2, img_size * 12 / 4000) px on a 270 mm bed, i.e. 12 px at 4000 px, which is 0.81 mm
// of ink with the contour in the middle of it.
constexpr double DEFAULT_WALL_BAND_MM = 30.0 * MM_PER_PX;  // 30 px of ink: 0.627 mm at 684 rows / 14.29 mm

struct WallSegment
{
    PolyVertex a, b;
    Vec3f normal;
    Vec2f outside;
    const PaintedSurface *surface;
};

void collect_wall_segment(std::vector<WallSegment> &segments, const std::vector<PolyVertex> &poly,
                          const Vec3f &normal, const PaintedSurface &surface)
{
    if (poly.size() < 3)
        return;

    // Which row of the texture this layer's ink comes from. An upright wall seen from above projects
    // onto a line, so every edge of the clipped polygon lies on that same line and "the longest
    // edge" was a coin flip between the slab's bottom row and its top row: half the layers then read
    // the texture a whole layer lower than the plane the picture is laid on, which is the one layer
    // step the preview showed. Cutting the polygon with the horizontal plane at the top of whatever
    // survived the slab gives one definite row instead.
    float z_lo = poly[0].pos.z();
    float z_hi = poly[0].pos.z();
    for (const PolyVertex &v : poly) {
        z_lo = std::min(z_lo, v.pos.z());
        z_hi = std::max(z_hi, v.pos.z());
    }
    const float z_cut = z_hi - std::min(1e-4f, (z_hi - z_lo) * 0.05f);

    std::vector<PolyVertex> row;
    row.reserve(4);
    const size_t n = poly.size();
    for (size_t i = 0; i < n; ++i) {
        const PolyVertex &p  = poly[i];
        const PolyVertex &q  = poly[(i + 1) % n];
        const float       dp = p.pos.z() - z_cut;
        const float       dq = q.pos.z() - z_cut;
        if (dp * dq < 0.f) {
            const float t = dp / (dp - dq);
            row.push_back(PolyVertex{ p.pos + (q.pos - p.pos) * t, p.uv + (q.uv - p.uv) * t });
        } else if (std::abs(dp) <= 1e-6f)
            row.push_back(p);
    }
    if (row.size() < 2)
        return;

    size_t i0 = 0, i1 = 1;
    double longest = -1.;
    for (size_t i = 0; i + 1 < row.size(); ++i)
        for (size_t j = i + 1; j < row.size(); ++j) {
            const Vec2f  d   = row[i].pos.head<2>() - row[j].pos.head<2>();
            const double len = double(d.x()) * double(d.x()) + double(d.y()) * double(d.y());
            if (len > longest) {
                longest = len;
                i0      = i;
                i1      = j;
            }
        }
    // Subpixel segments still connect their neighbours; dropping them opens curved contours.
    if (longest <= 1e-12)
        return;

    const Vec2f a0 = row[i0].pos.head<2>();
    const Vec2f b0 = row[i1].pos.head<2>();
    Vec2f       dir = b0 - a0;
    const float len = dir.norm();
    if (len <= 1e-6f)
        return;
    dir /= len;
    Vec2f n_out(normal.x(), normal.y());
    const float n_len = n_out.norm();
    if (n_len > 1e-4f)
        n_out /= n_len;
    else
        // Seen straight down (a face with no horizontal normal): no outside to bleed to, so fall
        // back to straddling the contour evenly rather than picking an arbitrary half.
        n_out = Vec2f(-dir.y(), dir.x());
    segments.push_back(WallSegment{ row[i0], row[i1], normal, n_out, &surface });
}

void rasterize_wall_segments(Raster &raster, const std::vector<WallSegment> &segments, const float half_mm)
{
    // Join geometry, not texture coordinates. Neighbouring faces may have a UV seam, and averaging
    // those UVs would sample unrelated texels. Both faces share the same miter cross-section instead.
    constexpr double join_mm = 0.0002;
    constexpr float miter_limit = 2.f;
    using Cell = std::pair<int64_t, int64_t>;
    using End = std::pair<size_t, size_t>;
    std::map<Cell, std::vector<End>> endpoints;
    auto cell = [](const Vec2f &p) -> Cell {
        return { int64_t(std::floor(double(p.x()) / join_mm)),
                 int64_t(std::floor(double(p.y()) / join_mm)) };
    };
    std::vector<std::array<Vec2f, 2>> centers(segments.size()), offsets(segments.size());
    for (size_t i = 0; i < segments.size(); ++i) {
        raster.check_cancel();
        centers[i] = { Vec2f(segments[i].a.pos.head<2>()), Vec2f(segments[i].b.pos.head<2>()) };
        offsets[i] = { Vec2f(segments[i].outside * half_mm), Vec2f(segments[i].outside * half_mm) };
        for (size_t end = 0; end < 2; ++end)
            endpoints[cell(centers[i][end])].emplace_back(i, end);
    }
    for (size_t i = 0; i < segments.size(); ++i) {
        raster.check_cancel();
        for (size_t end = 0; end < 2; ++end) {
            const Vec2f p = (end == 0 ? segments[i].a : segments[i].b).pos.head<2>();
            const Cell key = cell(p);
            End neighbor{};
            size_t matches = 0;
            for (int dx = -1; dx <= 1; ++dx) {
                for (int dy = -1; dy <= 1; ++dy) {
                    const auto found = endpoints.find({ key.first + dx, key.second + dy });
                    if (found == endpoints.end())
                        continue;
                    for (const End &other : found->second) {
                        if (other.first == i)
                            continue;
                        const WallSegment &s = segments[other.first];
                        const Vec2f q = (other.second == 0 ? s.a : s.b).pos.head<2>();
                        if ((p - q).squaredNorm() <= join_mm * join_mm) {
                            neighbor = other;
                            ++matches;
                        }
                    }
                }
            }
            // Open ends and non-manifold intersections have no unique neighbouring edge.
            if (matches != 1 || neighbor.first < i)
                continue;
            const WallSegment &other = segments[neighbor.first];
            const Vec2f m = segments[i].outside + other.outside;
            const float denominator = m.dot(segments[i].outside);
            const Vec2f q = (neighbor.second == 0 ? other.a : other.b).pos.head<2>();
            const Vec2f center = (p + q) * 0.5f;
            centers[i][end] = centers[neighbor.first][neighbor.second] = center;
            // For unit normals, |m / denominator|^2 = 2 / denominator.
            // Near a reversal an unlimited miter paints a long spike into the ink raster.
            if (denominator >= 2.f / (miter_limit * miter_limit)) {
                const Vec2f offset = m * (half_mm / denominator);
                offsets[i][end] = offsets[neighbor.first][neighbor.second] = offset;
            } else {
                const WallSegment &s = segments[i];
                const PolyVertex &v = end == 0 ? s.a : s.b;
                const PolyVertex &w = neighbor.second == 0 ? other.a : other.b;
                // Retain the perpendicular strip ends and fill their gap with a bevel.
                // Each half samples its own endpoint, including across UV seams.
                for (float side : {-1.f, 1.f}) {
                    const Vec2f a = center + side * half_mm * s.outside;
                    const Vec2f b = center + side * half_mm * other.outside;
                    const Vec2f mid = (a + b) * 0.5f;
                    const auto at = [](const Vec2f &point, float z) { return Vec3f(point.x(), point.y(), z); };
                    rasterize_triangle(raster, at(center, v.pos.z()), at(a, v.pos.z()), at(mid, v.pos.z()),
                                       s.normal, {v.uv, v.uv, v.uv}, *s.surface);
                    rasterize_triangle(raster, at(center, w.pos.z()), at(mid, w.pos.z()), at(b, w.pos.z()),
                                       other.normal, {w.uv, w.uv, w.uv}, *other.surface);
                }
            }
        }
    }
    for (size_t i = 0; i < segments.size(); ++i) {
        raster.check_cancel();
        const WallSegment &s = segments[i];
        const Vec2f a = centers[i][0], b = centers[i][1];
        const Vec2f na = offsets[i][0], nb = offsets[i][1];
        const Vec3f p0(a.x() + na.x(), a.y() + na.y(), s.a.pos.z());
        const Vec3f p1(a.x() - na.x(), a.y() - na.y(), s.a.pos.z());
        const Vec3f p2(b.x() + nb.x(), b.y() + nb.y(), s.b.pos.z());
        const Vec3f p3(b.x() - nb.x(), b.y() - nb.y(), s.b.pos.z());
        const Vec2f t0[3] = { s.a.uv, s.a.uv, s.b.uv };
        const Vec2f t1[3] = { s.a.uv, s.b.uv, s.b.uv };
        const std::array<PolyVertex, 2> source = { s.a, s.b };
        rasterize_triangle(raster, p0, p1, p3, s.normal, t0, *s.surface, &source);
        rasterize_triangle(raster, p0, p3, p2, s.normal, t1, *s.surface, &source);
    }
}

// Collapses what the layer kept into head passes: 14.29 mm bands 9.99 mm apart, one run per stretch
// of inked columns in a band, merged at 20 mm and led in by 7 mm the way the post-processor merged
// blocks. Returns object-local mm, since that is what the emitter and the strip crop both need.
struct MmBand
{
    double y_center = 0.;
    double x0 = 0., x1 = 0.;
};

std::vector<MmBand> bands_from_raster(const Raster &raster)
{
    std::vector<MmBand> bands;
    if (raster.empty())
        return bands;

    int x_lo = raster.width, x_hi = -1, y_lo = raster.height, y_hi = -1;
    for (int y = 0; y < raster.height; ++y) {
        raster.check_cancel();
        for (int x = 0; x < raster.width; ++x)
            if (raster.hit[size_t(y) * size_t(raster.width) + size_t(x)]) {
                x_lo = std::min(x_lo, x);
                x_hi = std::max(x_hi, x);
                y_lo = std::min(y_lo, y);
                y_hi = std::max(y_hi, y);
            }
    }
    if (x_hi < x_lo || y_hi < y_lo)
        return bands;

    const double y_bottom = double(raster.origin.y()) + (y_lo + 0.5) * MM_PER_PX;
    const double y_top    = double(raster.origin.y()) + (y_hi + 0.5) * MM_PER_PX;
    const double half     = HEAD_WIDTH_MM * 0.5;
    // The post-processor put its first pass half a head width above the content and stepped from
    // there, stopping half a head width below the top - and it always ran at least one pass.
    const double first = y_bottom + half;
    const double last  = std::max(y_top - half, first);

    std::vector<uint8_t> columns(size_t(raster.width));
    for (double y_center = first; y_center <= last + STEP_MM * 0.5; y_center += STEP_MM) {
        raster.check_cancel();
        std::fill(columns.begin(), columns.end(), uint8_t(0));
        const double band_lo = y_center - half;
        const double band_hi = y_center + half;
        const int    row_lo  = std::max(0, int(std::floor((band_lo - double(raster.origin.y())) / MM_PER_PX)));
        const int    row_hi  = std::min(raster.height - 1, int(std::ceil((band_hi - double(raster.origin.y())) / MM_PER_PX)));
        bool         any     = false;
        for (int y = row_lo; y <= row_hi; ++y)
            for (int x = x_lo; x <= x_hi; ++x)
                if (raster.hit[size_t(y) * size_t(raster.width) + size_t(x)]) {
                    columns[size_t(x)] = 1;
                    any                = true;
                }
        if (! any)
            continue;

        std::vector<std::pair<double, double>> runs;
        for (int x = x_lo; x <= x_hi;) {
            if (! columns[size_t(x)]) {
                ++x;
                continue;
            }
            const int begin = x;
            while (x <= x_hi && columns[size_t(x)])
                ++x;
            runs.emplace_back(double(raster.origin.x()) + (begin + 0.5) * MM_PER_PX,
                              double(raster.origin.x()) + (x - 1 + 0.5) * MM_PER_PX);
        }
        for (size_t i = 1; i < runs.size();) {
            if (runs[i].first - runs[i - 1].second < BLOCK_GAP_MM) {
                runs[i - 1].second = std::max(runs[i - 1].second, runs[i].second);
                runs.erase(runs.begin() + std::ptrdiff_t(i));
            } else
                ++i;
        }
        for (const auto &run : runs)
            // The cropped raster is a storage bound, not a motion bound. Keep the same 7 mm
            // white lead-in on every layer; write_strip supplies white outside the raster.
            bands.push_back(MmBand{ y_center,
                                    run.first - BLOCK_LEADIN_MM,
                                    run.second });
    }
    return bands;
}

// The strip the head downloads for one block: 684 rows over the bar's 14.29 mm, as many columns as
// the pass is long, white wherever the layer has nothing. Encoded and appended to the archive.
bool write_strip(Zipper &zip, const std::string &entry, const Raster &raster, const MmBand &band,
                 const InkjetParams &params)
{
    const double half = HEAD_WIDTH_MM * 0.5;
    const int    cols = std::max(1, int(std::lround((band.x1 - band.x0) / MM_PER_PX)));
    std::vector<uint8_t> strip(size_t(cols) * size_t(MBD_STRIP_ROWS) * 3, uint8_t(255));
    // Row 0 of the strip is its top, the way the old pipeline handed over a screen-order image: the
    // packer walks the strip bottom-up, which is the order the head lays the lines down.
    const double y_top = band.y_center + half;
    for (int row = 0; row < MBD_STRIP_ROWS; ++row) {
        raster.check_cancel();
        const double y_mm = y_top - (row + 0.5) * MM_PER_PX;
        const int    py   = int(std::floor((y_mm - double(raster.origin.y())) / MM_PER_PX));
        if (py < 0 || py >= raster.height)
            continue;
        for (int col = 0; col < cols; ++col) {
            const double x_mm = band.x0 + (col + 0.5) * MM_PER_PX;
            const int    px   = int(std::floor((x_mm - double(raster.origin.x())) / MM_PER_PX));
            if (px < 0 || px >= raster.width)
                continue;
            const size_t src = size_t(py) * size_t(raster.width) + size_t(px);
            if (! raster.hit[src])
                continue;
            // mkp_inkjet_shear: the head sits at a slight angle to its rail, so a straight pass comes
            // out as a parallelogram - the top of the strip is shifted along the pass, the bottom is
            // not, and what the shift uncovers stays white (no ink there). This is exactly the
            // per-row shift the post-processor's apply_shear() made on the strip image.
            const int shear_px = int(std::lround(params.shear_mm / MM_PER_PX));
            const int shift = (shear_px == 0 || MBD_STRIP_ROWS < 2)
                                  ? 0
                                  : int(std::lround(double(shear_px) *
                                                    (1. - double(row) / double(MBD_STRIP_ROWS - 1))));
            const int dst_col = col + shift;
            if (dst_col < 0 || dst_col >= cols)
                continue;
            uint8_t *dst = &strip[(size_t(row) * size_t(cols) + size_t(dst_col)) * 3];
            dst[0] = raster.rgb[src * 3];
            dst[1] = raster.rgb[src * 3 + 1];
            dst[2] = raster.rgb[src * 3 + 2];
        }
    }

    std::vector<uint8_t> mbd;
    if (! encode_mbd_strip(strip.data(), cols, MBD_STRIP_ROWS, inkjet_blend(params.density), mbd,
                           [&raster]() { raster.check_cancel(); })) {
        BOOST_LOG_TRIVIAL(warning) << "MKP: strip encoding failed at y=" << band.y_center;
        return false;
    }
    zip.add_entry(entry, mbd.data(), mbd.size());
    return true;
}

} // namespace

double SurfaceTone::lightness_at(const Vec2d &position) const
{
    const Vec2d cell = (position - origin) / cell_mm;
    if (cell.x() < 0. || cell.y() < 0. || cell.x() >= width || cell.y() >= height)
        return 1.;
    return 1. - darkness[size_t(cell.y()) * width + size_t(cell.x())] / 255.;
}

std::map<const Layer *, InkLayer> build_inkjet_layers(const PrintObject &object, Zipper &zip, const std::string &prefix,
                                                       const std::string &preview_dir, const InkjetParams &params)
{
    return build_inkjet_layers(object, zip, prefix, preview_dir, params, {});
}

std::map<const Layer *, InkLayer> build_inkjet_layers(const PrintObject &object, Zipper &zip, const std::string &prefix,
                                                       const std::string &preview_dir, const InkjetParams &params,
                                                       const std::function<void(double, const std::string &)> &progress)
{
    std::map<const Layer *, InkLayer> layers;
    const ModelObject *model_object = object.model_object();
    if (model_object == nullptr)
        return layers;

    if (progress)
        progress(0., "纹理切片");
    std::vector<PaintedSurface> surfaces;
    BoundingBoxf3              bounds;
    for (const ModelVolume *volume : model_object->volumes) {
        if (object.print()->canceled()) throw CanceledException();
        if (volume == nullptr || ! volume->is_model_part())
            continue;
        // Slice in the frame the layers were sliced in, not the model's own: an imported glTF
        // carries a y-up -> z-up rotation in the object's matrix, so the model file's z is not the
        // print z. Clipping painted faces by print_z in model space cut them on the wrong axis and
        // left two of a box's four walls (and most of each face) out of the picture.
        const Transform3d trafo = object.trafo_centered() * volume->get_matrix();
        const size_t       slots = std::min(volume->texture_displacement_layers.size(), TEXTURE_DISPLACEMENT_MAX_LAYERS);
        for (size_t slot = 0; slot < slots; ++slot) {
            if (object.print()->canceled()) throw CanceledException();
            const FacetsAnnotation &facets = volume->texture_displacement_facet(int(slot));
            if (facets.empty())
                continue;
            const TextureDisplacementLayer &texture_layer = volume->texture_displacement_layers[slot];
            DecodedHeightTexture            texture       = decode_height_texture(texture_layer);
            // A grayscale height map has no colour to give: it displaces, it does not print.
            if (! texture.has_color())
                continue;
            // The patch, plus which base-mesh triangle each of its triangles was cut from: the
            // model-uv path needs that map to place a cut triangle's corners inside its own base
            // triangle's uvs. Same extraction FacetsAnnotation::get_facets_strict() does.
            TriangleSelector selector(volume->mesh());
            selector.deserialize(facets.get_data(), false);
            std::vector<int>        patch_source;
            const indexed_triangle_set patch = selector.get_facets_strict(EnforcerBlockerType::ENFORCER, &patch_source);
            if (patch.indices.empty())
                continue;
            // A picture that came with the file lives on the model's own uv layout: that layout is
            // what the editor draws, and it is exactly what the old pipeline read out of the
            // exported OBJ (its per-corner vt). Only a model with no layout at all falls back to
            // the layer's projection. Sampling a stored Triplanar layer instead re-projects the
            // same picture onto every side of the part, which is how one painted face turned into
            // four - mirrored on the opposite ones - and why the ink never lined up with the face it
            // came from. The stored method is often just the serialisation default, so the layout
            // wins. The copy below is what sample_layer_color() dispatches on, so its ModelUV branch
            // and identity transform apply to the uv the layout gives.
            std::vector<Vec2f> corner_uv;
            if (volume->has_texture_uv())
                corner_uv = compute_model_corner_uvs(volume->mesh().its, volume->texture_uv, patch, patch_source);
            const bool have_uv = corner_uv.size() == patch.indices.size() * 3;
            PaintedSurface surface;
            surface.layer       = &texture_layer;
            if (have_uv && texture_layer.projection_method != TextureProjectionMethod::ModelUV) {
                surface.layer_override = std::make_unique<TextureDisplacementLayer>(texture_layer);
                surface.layer_override->projection_method = TextureProjectionMethod::ModelUV;
                surface.layer = surface.layer_override.get();
                BOOST_LOG_TRIVIAL(info) << "MKP inkjet: model uv layout used instead of stored projection "
                                        << int(texture_layer.projection_method) << " for slot " << slot;
            }
            surface.texture     = std::move(texture);
            surface.use_model_uv = have_uv;
            surface.world_to_local = trafo.inverse();
            {
                // The library's own patch frame, so the Cylindrical/Spherical wrap and the tri-planar
                // blend match the bake the GUI previews: same centroid, same least-aligned axis.
                const std::vector<Vec3f> vertex_normals = texture_displacement_vertex_normals(patch);
                Vec3f center, axis, average_normal;
                texture_displacement_patch_frame(patch, vertex_normals, center, axis, average_normal);
                surface.patch_center = center;
                surface.patch_axis   = axis;
            }
            surface.triangles.reserve(patch.indices.size());
            surface.z_min = std::numeric_limits<float>::max();
            surface.z_max = std::numeric_limits<float>::lowest();
            for (size_t ti = 0; ti < patch.indices.size(); ++ti) {
                if ((ti & 255) == 0 && object.print()->canceled())
                    throw CanceledException();
                const auto &index = patch.indices[ti];
                PaintedTriangle triangle;
                triangle.a = (trafo * patch.vertices[index[0]].cast<double>()).cast<float>();
                triangle.b = (trafo * patch.vertices[index[1]].cast<double>()).cast<float>();
                triangle.c = (trafo * patch.vertices[index[2]].cast<double>()).cast<float>();
                if (have_uv)
                    for (int k = 0; k < 3; ++k)
                        triangle.uv[k] = corner_uv[ti * 3 + size_t(k)];
                triangle.normal = (triangle.b - triangle.a).cross(triangle.c - triangle.a);
                const float length = triangle.normal.norm();
                if (length <= 0.f)
                    continue;
                triangle.normal /= length;
                triangle.z_min = std::min({ triangle.a.z(), triangle.b.z(), triangle.c.z() });
                triangle.z_max = std::max({ triangle.a.z(), triangle.b.z(), triangle.c.z() });
                surface.z_min  = std::min(surface.z_min, triangle.z_min);
                surface.z_max  = std::max(surface.z_max, triangle.z_max);
                for (const Vec3f &vertex : { triangle.a, triangle.b, triangle.c })
                    bounds.merge(Vec3d(double(vertex.x()), double(vertex.y()), double(vertex.z())));
                surface.triangles.emplace_back(triangle);
            }
            if (! surface.triangles.empty())
                surfaces.emplace_back(std::move(surface));
        }
    }
    if (surfaces.empty() || ! bounds.defined)
        return layers;


    Raster      raster;
    raster.print = object.print();
    std::vector<PolyVertex> poly;
    poly.reserve(8);

    // Review dump framing: one canvas for every layer, sized to the whole painted footprint and not
    // to the plate. Framing each layer on its own slab would make the UI's layer slider jump about;
    // framing on the plate would bury a 20 mm part in empty margin, which is the picture nobody can
    // read detail from. The canvas keeps the strips' own pixel size (25.4 / 0.0209 = 1215 dpi), so it
    // is far past the 300 dpi a review picture needs, and only shrinks if a model is so large that
    // the picture would be uselessly heavy to hand to the UI.
    const float          half_band     = float(0.5 * std::max(0.05, params.wall_band_mm));
    const double         PREVIEW_PAD_MM = double(half_band) + 2. * MM_PER_PX;
    int                  preview_x0 = 0, preview_y0 = 0, preview_w = 0, preview_h = 0, preview_step = 1;
    std::vector<uint8_t> preview_px;
    // Where each written picture belongs in Z, so the 3D preview can lay the cross-section on
    // the model at the height it was cut at instead of guessing.
    std::vector<std::pair<size_t, double>> preview_layers;
    // How much ink each of those pictures actually carries. A layer can be perfectly empty (a wall
    // whose texture is white there), and the 3D view wants to show the newest picture that has some.
    std::vector<size_t>                    preview_ink_px;
    if (! preview_dir.empty()) {
        preview_x0 = int(std::floor((double(bounds.min.x()) - PREVIEW_PAD_MM) / MM_PER_PX));
        preview_y0 = int(std::floor((double(bounds.min.y()) - PREVIEW_PAD_MM) / MM_PER_PX));
        preview_w  = std::max(1, int(std::ceil((double(bounds.max.x()) + PREVIEW_PAD_MM) / MM_PER_PX)) - preview_x0);
        preview_h  = std::max(1, int(std::ceil((double(bounds.max.y()) + PREVIEW_PAD_MM) / MM_PER_PX)) - preview_y0);
        // The review picture must not depend on how big the part is: a 0.81 mm band has to be the same
        // number of pixels in every model (39 at the strip grid). Scaling the canvas by model size was
        // what made the band look thinner on some models than others. Only a part too large to hold in
        // memory is allowed to shrink, and the log says so.
        preview_step = std::max(1, (std::max(preview_w, preview_h) + 7999) / 8000);
        if (preview_step > 1)
            BOOST_LOG_TRIVIAL(warning) << "MKP: preview canvas shrunk " << preview_step
                                       << "x, this part is too large for a 1:1 review picture";
        preview_w    = (preview_w + preview_step - 1) / preview_step;
        preview_h    = (preview_h + preview_step - 1) / preview_step;
        preview_px.assign(size_t(preview_w) * size_t(preview_h) * 4, uint8_t(0));
    }
    size_t written = 0;
    size_t layer_index = 0;
    for (const Layer *layer : object.layers()) {
        if (progress)
            progress(0.05 + 0.9 * double(layer_index) / std::max<size_t>(1, object.layers().size()),
                     "纹理切片：第 " + std::to_string(layer_index + 1) + "/" +
                     std::to_string(object.layers().size()) + " 层");
        ++layer_index;
        raster.check_cancel();
        // Layer::print_z is the TOP of the layer, not its bottom: the writer brings the nozzle to
        // print_z after the layer is done. Using it as the bottom shifted every ink layer up by one
        // slab - the top picture of a 100 layer part ended up describing layer 99 while layer 99's
        // own slab lay above the part and got no ink at all, so the real top face was never sprayed.
        const float z_top    = float(layer->print_z);
        const float z_bottom = float(layer->print_z - layer->height);

        // Size the raster to what this layer's slab actually covers, not to the whole object: a
        // 270 mm-wide model at 0.02 mm per pixel would be 13000 px across for nothing.
        BoundingBoxf slab;
        for (const PaintedSurface &surface : surfaces) {
            if (surface.z_max < z_bottom || surface.z_min > z_top)
                continue;
            for (const PaintedTriangle &triangle : surface.triangles) {
                raster.check_cancel();
                if (triangle.z_max < z_bottom || triangle.z_min > z_top)
                    continue;
                for (const Vec3f &vertex : { triangle.a, triangle.b, triangle.c })
                    slab.merge(Vec2d(double(vertex.x()), double(vertex.y())));
            }
        }
        if (! slab.defined)
            continue;

        raster.origin = Vec2f(float(slab.min.x()) - half_band - float(MM_PER_PX),
                             float(slab.min.y()) - half_band - float(MM_PER_PX));
        raster.width  = std::max(1, int(std::ceil((slab.max.x() + half_band - double(raster.origin.x())) / MM_PER_PX)) + 2);
        raster.height = std::max(1, int(std::ceil((slab.max.y() + half_band - double(raster.origin.y())) / MM_PER_PX)) + 2);
        if (size_t(raster.width) * size_t(raster.height) > MAX_RASTER_PIXELS) {
            BOOST_LOG_TRIVIAL(warning) << "MKP: layer " << layer->id() << " is too large to spray, skipped";
            continue;
        }
        raster.hit.assign(size_t(raster.width) * size_t(raster.height), 0);
        raster.rgb.assign(size_t(raster.width) * size_t(raster.height) * 3, uint8_t(255));

        struct AreaFill
        {
            std::vector<PolyVertex> polygon;
            const PaintedTriangle *triangle;
            const PaintedSurface *surface;
        };
        std::vector<WallSegment> wall_segments;
        std::vector<AreaFill> area_fills;
        for (const PaintedSurface &surface : surfaces) {
            if (surface.z_max < z_bottom || surface.z_min > z_top)
                continue;
            for (const PaintedTriangle &triangle : surface.triangles) {
                raster.check_cancel();
                if (triangle.z_max < z_bottom || triangle.z_min > z_top)
                    continue;
                poly.clear();
                poly.push_back(PolyVertex{ triangle.a, triangle.uv[0] });
                poly.push_back(PolyVertex{ triangle.b, triangle.uv[1] });
                poly.push_back(PolyVertex{ triangle.c, triangle.uv[2] });
                clip_to_plane(poly, z_bottom, true);
                clip_to_plane(poly, z_top, false);
                if (poly.size() >= 3) {
                    // Every face gets its wall ring, no test, no exception: the ring is the contour of
                    // the part at this height, and the head has to run it whether the face stands
                    // upright or lies nearly flat. Deciding by projected area was what lost the ring on
                    // curved walls (a sphere's side clips to a thin ring sector with real area, so it
                    // was filled as a 5 px sliver and its ring was never drawn).
                    double body = 0.;
                    for (size_t v = 1; v + 1 < poly.size(); ++v) {
                        const Vec2f e1 = poly[v].pos.head<2>() - poly[0].pos.head<2>();
                        const Vec2f e2 = poly[v + 1].pos.head<2>() - poly[0].pos.head<2>();
                        body = std::max(body, std::abs(double(e1.x()) * double(e2.y()) - double(e1.y()) * double(e2.x())) * 0.5);
                    }
                    // The ring goes down first and the area fill on top of it, so a top or bottom
                    // surface covers the inner half of the ring instead of being eaten by it.
                    collect_wall_segment(wall_segments, poly, triangle.normal, surface);
                    if (body > double(MM_PER_PX) * double(MM_PER_PX))
                        area_fills.push_back(AreaFill{ poly, &triangle, &surface });
                }
            }
        }

        rasterize_wall_segments(raster, wall_segments, half_band);
        if (!area_fills.empty()) {
            const std::vector<uint8_t> area_mask = external_surface_mask(*layer, raster);
            for (const AreaFill &fill : area_fills)
                rasterize_polygon(raster, fill.polygon, fill.triangle->normal, *fill.surface, area_mask);
        }

        // The colour knobs act on the ink of this layer once, on the raster. Both the strips and
        // the review picture are taken from here, so what the preview shows is what the head gets.
        // A pixel the adjustment pushes into "no colour" stops being ink, which is what the old
        // pipeline's find_non_white_blocks() did after apply_cmy_adjustment().
        {
            for (size_t i = 0; i < raster.hit.size(); ++i) {
                if ((i & 65535) == 0)
                    raster.check_cancel();
                if (! raster.hit[i])
                    continue;
                uint8_t &r = raster.rgb[i * 3];
                uint8_t &g = raster.rgb[i * 3 + 1];
                uint8_t &b = raster.rgb[i * 3 + 2];
                adjust_ink_color(params, r, g, b);
                if (float(r) >= WHITE_LEVEL * 255.f && float(g) >= WHITE_LEVEL * 255.f &&
                    float(b) >= WHITE_LEVEL * 255.f)
                    raster.hit[i] = 0;
            }
        }

        // Review dump: this layer's ink, drawn into the shared model-framed canvas. Nothing where
        // there is no ink, the ink itself everywhere else, on a transparent background - the same
        // shape the flat-print side's layer PNGs have, so the preview page can show either.
        if (! preview_px.empty()) {
            for (int r = 0; r < raster.height; ++r) {
                raster.check_cancel();
                const int cy = int(std::floor((double(raster.origin.y()) + double(r) * MM_PER_PX) / MM_PER_PX)) - preview_y0;
                if (cy < 0)
                    continue;
                const int cy_scaled = cy / preview_step;
                if (cy_scaled >= preview_h)
                    continue;
                const size_t dst_row = size_t(preview_h - 1 - cy_scaled);
                const size_t src_row = size_t(r);
                for (int c = 0; c < raster.width; ++c) {
                    const size_t src = src_row * size_t(raster.width) + size_t(c);
                    if (! raster.hit[src])
                        continue;
                    const int cx = int(std::floor((double(raster.origin.x()) + double(c) * MM_PER_PX) / MM_PER_PX)) - preview_x0;
                    if (cx < 0)
                        continue;
                    const int cx_scaled = cx / preview_step;
                    if (cx_scaled >= preview_w)
                        continue;
                    uint8_t *dst = &preview_px[(dst_row * size_t(preview_w) + size_t(cx_scaled)) * 4];
                    // Review picture only - the strips above already carry the colour the head will
                    // print, untouched. Everything paler than white is drawn as the same hue at full
                    // strength with the paleness moved into the alpha, so a light pink reads as the
                    // semi-transparent red it is and a near-white pixel all but disappears. Without
                    // it the pale fringe around every glyph came out as opaque white blocks sitting
                    // on the model.
                    const int r8 = raster.rgb[src * 3];
                    const int g8 = raster.rgb[src * 3 + 1];
                    const int b8 = raster.rgb[src * 3 + 2];
                    // Un-premultiplied against white, not normalised to full saturation: the
                    // colour the picture shows, laid over white at this alpha, must compose back to
                    // exactly the pixel the head will print. Dividing by (hi - lo) instead stretched
                    // every hue to the edge of the gamut, which turned the seal's dark teal (29,74,79)
                    // into neon cyan - the ink looked like one wrong colour.
                    const int lo = std::min({ r8, g8, b8 });
                    dst[3] = uint8_t(255 - lo);
                    if (lo >= 255) {
                        dst[0] = dst[1] = dst[2] = 0;   // white: nothing to see
                    } else {
                        const float lift = 255.f / float(255 - lo);
                        dst[0] = uint8_t(std::min(255, int(float(r8 - lo) * lift + 0.5f)));
                        dst[1] = uint8_t(std::min(255, int(float(g8 - lo) * lift + 0.5f)));
                        dst[2] = uint8_t(std::min(255, int(float(b8 - lo) * lift + 0.5f)));
                    }
                }
            }
            char name[64];
            std::snprintf(name, sizeof(name), "layer_%04zu.png", layer->id());
            size_t inked = 0;
            for (size_t i = 3; i < preview_px.size(); i += 4)
                if (preview_px[i])
                    ++inked;
            Slic3r::png::write_rgba_to_file((boost::filesystem::path(preview_dir) / name).string(),
                                            size_t(preview_w), size_t(preview_h), preview_px);
            preview_layers.emplace_back(layer->id(), double(layer->print_z));
            preview_ink_px.push_back(inked);
            std::fill(preview_px.begin(), preview_px.end(), uint8_t(0));
        }

        const std::vector<MmBand> bands = bands_from_raster(raster);
        if (bands.empty())
            continue;

        InkLayer ink;
        if (params.surface_tone) {
            auto &tone = ink.tone;
            tone.origin = raster.origin.cast<double>();
            tone.width = int(std::ceil(raster.width * MM_PER_PX / SurfaceTone::cell_mm));
            tone.height = int(std::ceil(raster.height * MM_PER_PX / SurfaceTone::cell_mm));
            tone.darkness.resize(size_t(tone.width) * tone.height, 0);
            for (int y = 0; y < raster.height; ++y) {
                raster.check_cancel();
                const size_t row = size_t((y + 0.5) * MM_PER_PX / SurfaceTone::cell_mm) * tone.width;
                for (int x = 0; x < raster.width; ++x) {
                    const size_t i = size_t(y) * raster.width + x;
                    if (!raster.hit[i])
                        continue;
                    const auto *rgb = raster.rgb.data() + i * 3;
                    const int luma = (2126 * rgb[0] + 7152 * rgb[1] + 722 * rgb[2] + 5000) / 10000;
                    auto &cell = tone.darkness[row + size_t((x + 0.5) * MM_PER_PX / SurfaceTone::cell_mm)];
                    // Keep narrow dark contours from disappearing when reducing raster resolution.
                    cell = std::max(cell, uint8_t(255 - luma));
                }
            }
        }
        char     dir[64];
        std::snprintf(dir, sizeof(dir), "layer_%04zu", layer->id());
        for (size_t block = 0; block < bands.size(); ++block) {
            if (progress)
                progress(0.05 + 0.9 * (layer_index - 1 + 0.75 + 0.25 * double(block) / bands.size()) /
                                      std::max<size_t>(1, object.layers().size()),
                         "纹理切片：第 " + std::to_string(layer_index) + "/" + std::to_string(object.layers().size()) + " 层");
            char entry[160];
            std::snprintf(entry, sizeof(entry), "%s%s/%05zu.mbd", prefix.c_str(), dir, block);
            if (params.encode_strips && ! write_strip(zip, entry, raster, bands[block], params))
                continue;
            if (params.encode_strips)
                ++written;
            ink.bands.push_back(InkBand{ scaled<coordf_t>(bands[block].y_center), scaled<coordf_t>(bands[block].x0),
                                   scaled<coordf_t>(bands[block].x1) });
        }
        if (! ink.empty())
            layers.emplace(layer, std::move(ink));
    }
    if (progress)
        progress(0.95, "纹理切片：第 " + std::to_string(object.layers().size()) + "/" + std::to_string(object.layers().size()) + " 层");
    if (written > 0)
        BOOST_LOG_TRIVIAL(info) << "MKP: " << written << " ink strips written";
    // Sidecar for the preview page: the pixel size, where the picture sits on the plate, and the
    // height every picture was cut at. Without it the 3D view could only show the ink in a flat list.
    if (! preview_layers.empty()) {
        Vec2d plate_shift(0., 0.);
        if (! object.instances().empty())
            plate_shift = unscale(object.instances().front().shift).head<2>();
        const double mm_per_px = MM_PER_PX * double(preview_step);
        std::ofstream meta((boost::filesystem::path(preview_dir) / "preview_meta.json").string(),
                           std::ios::out | std::ios::trunc);
        if (meta) {
            char buf[256];
            ::snprintf(buf, sizeof(buf),
                       "{\"mm_per_px\":%.9f,\"width_px\":%d,\"height_px\":%d,"
                       "\"x0_mm\":%.4f,\"y0_mm\":%.4f,\"layers\":[",
                       mm_per_px, preview_w, preview_h,
                       double(preview_x0) * MM_PER_PX + plate_shift.x(),
                       double(preview_y0) * MM_PER_PX + plate_shift.y());
            meta << buf;
            for (size_t i = 0; i < preview_layers.size(); ++i) {
                ::snprintf(buf, sizeof(buf), "%s{\"file\":\"layer_%04zu.png\",\"z\":%.4f,\"px\":%zu}",
                           i == 0 ? "" : ",", preview_layers[i].first, preview_layers[i].second,
                           i < preview_ink_px.size() ? preview_ink_px[i] : size_t(0));
                meta << buf;
            }
            meta << "]}";
        }
    }

    if (progress)
        progress(1., "纹理切片完成");
    return layers;
}

} // namespace mkp
} // namespace Slic3r
