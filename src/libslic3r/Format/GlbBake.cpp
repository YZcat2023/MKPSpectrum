#include "GlbBake.hpp"
#include "../AABBTreeIndirect.hpp"
#include "../QuadricEdgeCollapse.hpp"
#include "../TexturePainting.hpp"
#include "xatlas/xatlas.h"

#include <assimp/mesh.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <memory>
#include <chrono>
#include <boost/log/trivial.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <tbb/parallel_for.h>

namespace Slic3r {
namespace {
struct Part {
    const aiMesh *source;
    indexed_triangle_set high, low;
    cv::Mat image;
    cv::Vec3b fallback;
};

float cross2(const Vec2f &a, const Vec2f &b) { return a.x() * b.y() - a.y() * b.x(); }
using Pixel = cv::Vec3b;

bool bake_part(const Part &part, const xatlas::Mesh &atlas, cv::Mat &image, cv::Mat &color_chart,
               size_t &covered, size_t &hits)
{
    using namespace AABBTreeIndirect;
    const auto &high = part.high;
    const auto &low = part.low;
    if (atlas.indexCount != low.indices.size() * 3) return false;
    const auto tree = part.image.empty() ? Tree<3, float>{} :
        build_aabb_tree_over_indexed_triangle_set(high.vertices, high.indices);
    const float diagonal = tree.empty() ? 0.f : [&] {
        Vec3f lo = low.vertices.front(), hi = lo;
        for (const auto &v : low.vertices) { lo = lo.cwiseMin(v); hi = hi.cwiseMax(v); }
        return (hi - lo).norm();
    }();
    const float eps = diagonal * 1e-6f;
    const float reach = diagonal * .015f;
    std::vector<Vec3f> normals(low.vertices.size(), Vec3f::Zero());
    std::vector<Vec3f> face_normals(low.indices.size());
    for (size_t f = 0; f < low.indices.size(); ++f) {
        const auto &face = low.indices[f];
        const Vec3f n = (low.vertices[face[1]] - low.vertices[face[0]])
                          .cross(low.vertices[face[2]] - low.vertices[face[0]]).normalized();
        face_normals[f] = n;
        for (int k : {0, 1, 2}) normals[face[k]] += n;
    }
    for (auto &n : normals) n.normalize();
    // Resolve shared UV triangle edges serially, then project disjoint rows in parallel.
    cv::Mat owner(image.rows, image.cols, CV_32SC1, cv::Scalar(-1));
    cv::Mat weights(image.rows, image.cols, CV_32FC2);
    cv::Rect limits;
    for (size_t i = 0; i < low.indices.size(); ++i) {
        Vec2f uv[3];
        for (int k : {0, 1, 2}) {
            const auto &v = atlas.vertexArray[atlas.indexArray[3 * i + k]];
            if (v.atlasIndex != 0 || v.chartIndex < 0) {
                uv[0] = uv[1] = uv[2] = Vec2f::Zero();
                break; // xatlas excludes zero-area triangles from its atlas.
            }
            uv[k] = {v.uv[0], v.uv[1]};
        }
        const Vec2f u = uv[1] - uv[0], v = uv[2] - uv[0];
        const float determinant = cross2(u, v);
        if (std::abs(determinant) < 1e-8f) continue;
        const Vec2f lo = uv[0].cwiseMin(uv[1]).cwiseMin(uv[2]);
        const Vec2f hi = uv[0].cwiseMax(uv[1]).cwiseMax(uv[2]);
        const int x0 = std::max(0, int(std::floor(lo.x()))), y0 = std::max(0, int(std::floor(lo.y())));
        const int x1 = std::min(image.cols, int(std::ceil(hi.x()))), y1 = std::min(image.rows, int(std::ceil(hi.y())));
        if (x1 <= x0 || y1 <= y0) continue;
        limits |= cv::Rect(x0, y0, x1 - x0, y1 - y0);
        for (int y = y0; y < y1; ++y)
            for (int x = x0; x < x1; ++x) {
                const Vec2f delta = Vec2f(x + .5f, y + .5f) - uv[0];
                const float a = cross2(delta, v) / determinant, b = cross2(u, delta) / determinant;
                if (a >= 0.f && b >= 0.f && a + b <= 1.f) {
                    owner.at<int>(y, x) = int(i);
                    weights.at<cv::Vec2f>(y, x) = {a, b};
                }
            }
    }
    std::vector<std::array<size_t, 2>> row_counts(limits.height);
    tbb::parallel_for(limits.y, limits.y + limits.height, [&](int y) {
        auto &counts = row_counts[y - limits.y];
        for (int x = limits.x; x < limits.x + limits.width; ++x) {
            const int i = owner.at<int>(y, x);
            if (i < 0) continue;
            const auto &at_v = atlas.vertexArray[atlas.indexArray[3 * size_t(i)]];
            const auto &face = low.indices[i];
            const auto w = weights.at<cv::Vec2f>(y, x);
            const float z = 1.f - w[0] - w[1];
            Pixel color = part.fallback;
            bool valid = part.image.empty();
            if (!valid) {
                const Vec3f p = z * low.vertices[face[0]] + w[0] * low.vertices[face[1]] + w[1] * low.vertices[face[2]];
                const Vec3f &n = face_normals[i];
                Vec3f smooth = (z * normals[face[0]] + w[0] * normals[face[1]] + w[1] * normals[face[2]]).normalized();
                if (!(smooth.dot(n) >= .5f)) smooth = n;
                float best = std::numeric_limits<float>::max();
                for (const Vec3f &dir : std::array<Vec3f, 4>{smooth, -smooth, n, -n}) {
                    const Vec3d origin = (p - eps * dir).cast<double>(), direction = dir.cast<double>();
                    igl::Hit<float> hit;
                    if (!intersect_ray_first_hit(high.vertices, high.indices, tree, origin, direction, hit, 1e-12) || hit.t > reach)
                        continue;
                    const auto &hf = high.indices[hit.id];
                    const Vec3f hn = (high.vertices[hf[1]] - high.vertices[hf[0]])
                                      .cross(high.vertices[hf[2]] - high.vertices[hf[0]]).normalized();
                    const float dot = hn.dot(n);
                    const float score = std::abs(hit.t - eps) * (1.f + .5f * (1.f - std::clamp(dot, 0.f, 1.f)));
                    if (!(dot > .2f) || score >= best) continue;
                    const auto *uv = part.source->mTextureCoords[0];
                    const aiVector3D sample = uv[hf[0]] * (1.f - hit.u - hit.v) + uv[hf[1]] * hit.u + uv[hf[2]] * hit.v;
                    const auto texel = [](float v, int len) { return std::min(len - 1, int((v - std::floor(v)) * len)); };
                    if (!std::isfinite(sample.x) || !std::isfinite(sample.y)) continue;
                    best = score;
                    color = part.image.at<Pixel>(texel(sample.y, part.image.rows), texel(sample.x, part.image.cols));
                    valid = true;
                }
            }
            ++counts[0];
            if (valid) {
                ++counts[1];
                image.at<Pixel>(y, x) = color;
                color_chart.at<int>(y, x) = at_v.chartIndex;
            }
        }
    });
    for (const auto &c : row_counts) { covered += c[0]; hits += c[1]; }
    return true;
}
} // namespace

bool reduce_glb_native(const std::vector<const aiMesh *> &meshes, const std::vector<size_t> &budgets,
                       TexturedMesh &out, std::string &error)
{
    const auto started = std::chrono::steady_clock::now();
    auto atlas = std::unique_ptr<xatlas::Atlas, decltype(&xatlas::Destroy)>(xatlas::Create(), xatlas::Destroy);
    bool has_texture = false;
    std::vector<Part> parts;
    parts.reserve(meshes.size());
    for (size_t i = 0; i < meshes.size(); ++i) {
        if (!budgets[i]) continue;
        const aiMesh &source = *meshes[i];
        Part &part = parts.emplace_back();
        part.source = &source;
        const int material = source.mMaterialIndex;
        const auto &base = out.material_colors.at(material);
        part.fallback = Pixel(cv::saturate_cast<uchar>(base[2] * 255.f), cv::saturate_cast<uchar>(base[1] * 255.f), cv::saturate_cast<uchar>(base[0] * 255.f));
        const int texture = out.material_texture_map.at(material);
        if (source.HasTextureCoords(0) && texture >= 0) {
            std::vector<unsigned char> bgr;
            int w = 0, h = 0;
            if (!decode_texture_to_pixels(out.textures[texture], bgr, w, h)) {
                error = "Could not decode the GLB texture for baking";
                return false;
            }
            part.image = cv::Mat(h, w, CV_8UC3, bgr.data()).clone();
            has_texture = true;
        }
        auto &high = part.high;
        high.vertices.reserve(source.mNumVertices);
        for (unsigned v = 0; v < source.mNumVertices; ++v) {
            const auto &p = source.mVertices[v];
            high.vertices.emplace_back(p.x, p.y, p.z);
        }
        high.indices.reserve(source.mNumFaces);
        for (unsigned f = 0; f < source.mNumFaces; ++f) {
            const auto &face = source.mFaces[f];
            if (face.mNumIndices != 3) continue;
            const auto *idx = face.mIndices;
            if (std::max({idx[0], idx[1], idx[2]}) >= source.mNumVertices) {
                error = "GLB face index is out of bounds";
                return false;
            }
            high.indices.emplace_back(idx[0], idx[1], idx[2]);
        }
        part.low = high;
        its_merge_vertices(part.low, false);
        its_remove_degenerate_faces(part.low);
        its_quadric_edge_collapse(part.low, uint32_t(budgets[i]));
        if (part.low.indices.empty() || part.low.indices.size() > budgets[i]) {
            error = "Orca could not reach the selected triangle count";
            return false;
        }
        if (part.image.empty()) part.high = {};
    }
    if (!has_texture) {
        for (const auto &part : parts) {
            const int offset = int(out.vertices.size());
            for (const auto &v : part.low.vertices) {
                out.vertices.push_back({v.x(), v.y(), v.z()});
                out.uvs.push_back({0.f, 0.f});
            }
            for (const auto &f : part.low.indices) {
                out.indices.push_back({offset + f[0], offset + f[1], offset + f[2]});
                out.material_ids.push_back(int(part.source->mMaterialIndex));
            }
        }
        return true;
    }
    for (const auto &part : parts) {
        xatlas::MeshDecl decl;
        decl.vertexCount = uint32_t(part.low.vertices.size());
        decl.vertexPositionData = part.low.vertices.data();
        decl.vertexPositionStride = sizeof(Vec3f);
        decl.indexData = part.low.indices.data();
        decl.indexCount = uint32_t(part.low.indices.size() * 3);
        decl.indexFormat = xatlas::IndexFormat::UInt32;
        if (xatlas::AddMesh(atlas.get(), decl) != xatlas::AddMeshError::Success) {
            error = "Could not unwrap the simplified GLB mesh";
            return false;
        }
    }
    xatlas::PackOptions options;
    options.resolution = 2048;
    options.padding = 6;
    options.createImage = true;
    xatlas::Generate(atlas.get(), {}, options);
    if (atlas->meshCount != parts.size() || atlas->atlasCount != 1 || !atlas->image || !atlas->width || !atlas->height) {
        error = "Could not pack the simplified GLB texture atlas";
        return false;
    }
    cv::Mat image(atlas->height, atlas->width, CV_8UC3, cv::Scalar(255, 255, 255));
    cv::Mat charts(image.rows, image.cols, CV_32SC1, cv::Scalar(-1));
    size_t covered = 0, hits = 0;
    bool projected_texture = false;
    for (size_t i = 0; i < parts.size(); ++i) {
        const auto &m = atlas->meshes[i];
        const size_t hits_before = hits;
        if (!bake_part(parts[i], m, image, charts, covered, hits)) {
            error = "Could not project the GLB texture onto the simplified mesh";
            return false;
        }
        projected_texture |= !parts[i].image.empty() && hits > hits_before;
        const auto &low = parts[i].low;
        const int offset = int(out.vertices.size());
        for (uint32_t v = 0; v < m.vertexCount; ++v) {
            const auto &vertex = m.vertexArray[v];
            const Vec3f &p = low.vertices[vertex.xref];
            out.vertices.push_back({p.x(), p.y(), p.z()});
            out.uvs.push_back({vertex.uv[0] / atlas->width, vertex.uv[1] / atlas->height});
        }
        for (uint32_t j = 0; j < m.indexCount; j += 3) {
            out.indices.push_back({offset + int(m.indexArray[j]), offset + int(m.indexArray[j+1]), offset + int(m.indexArray[j+2])});
            out.material_ids.push_back(0);
        }
    }
    // Expand inside each island's allocated padding without sampling a neighboring island.
    for (int step = 0; step < 6; ++step) {
        cv::Mat next = charts.clone();
        tbb::parallel_for(0, image.rows, [&](int y) {
            for (int x = 0; x < image.cols; ++x) {
                const auto entry = atlas->image[size_t(y) * image.cols + x];
                if (!(entry & xatlas::kImageHasChartIndexBit) || charts.at<int>(y, x) >= 0) continue;
                const int chart = int(entry & xatlas::kImageChartIndexMask);
                for (const cv::Point d : {cv::Point(-1, 0), cv::Point(1, 0), cv::Point(0, -1), cv::Point(0, 1)}) {
                    const int xx = x + d.x, yy = y + d.y;
                    if (xx < 0 || xx >= image.cols || yy < 0 || yy >= image.rows || charts.at<int>(yy, xx) != chart) continue;
                    image.at<Pixel>(y, x) = image.at<Pixel>(yy, xx);
                    next.at<int>(y, x) = chart;
                    break;
                }
            }
        });
        charts = std::move(next);
    }
    if (!projected_texture) {
        error = "No GLB texture could be projected onto the simplified mesh";
        return false;
    }
    TextureImage texture;
    if (!cv::imencode(".png", image, texture.data, {cv::IMWRITE_PNG_COMPRESSION, 1})) {
        error = "Could not encode the baked GLB texture";
        return false;
    }
    texture.width = texture.height = -1;
    texture.channels = 0;
    out.textures = {std::move(texture)};
    out.material_texture_map = {0};
    out.material_colors = {{1.f, 1.f, 1.f, 1.f}};
    BOOST_LOG_TRIVIAL(info) << "GLB native reduction and bake: " << out.indices.size() << " faces, "
        << hits << '/' << covered << " texels projected in "
        << std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count() << " s";
    return true;
}
} // namespace Slic3r
