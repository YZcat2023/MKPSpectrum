#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_message.hpp>
#include <catch2/generators/catch_generators.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "libslic3r/CutUtils.hpp"
#include "libslic3r/Geometry.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TexturePainting.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/TriangleMeshSlicer.hpp"
#include "libslic3r/TriangleSelector.hpp"
#include "../test_utils.hpp"

#include <array>
#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>
#include <sstream>
#include <cereal/archives/binary.hpp>
#include <cereal/types/array.hpp>
#include <cereal/types/vector.hpp>

using namespace Slic3r;
using Catch::Matchers::WithinAbs;

TEST_CASE("Display texture snapshots retain face mappings and decoded images", "[CutTextures][Regression]")
{
    TextureDisplayData source;
    source.face_uv = {{{{0.f, 0.f}, {1.f, 0.f}, {0.f, 1.f}}}};
    source.face_image = {0};
    source.face_rgb = {{0.25f, 0.5f, 0.75f}};
    source.images.push_back({2, 1, {255, 0, 0, 0, 0, 255}});
    std::stringstream bytes;
    {
        cereal::BinaryOutputArchive archive(bytes);
        archive(source);
    }
    TextureDisplayData restored;
    {
        cereal::BinaryInputArchive archive(bytes);
        archive(restored);
    }
    CHECK(restored.face_uv == source.face_uv);
    CHECK(restored.face_image == source.face_image);
    CHECK(restored.face_rgb == source.face_rgb);
    REQUIRE(restored.images.size() == source.images.size());
    CHECK(restored.images[0].width == source.images[0].width);
    CHECK(restored.images[0].height == source.images[0].height);
    CHECK(restored.images[0].rgb == source.images[0].rgb);
    CHECK(restored.memsize() >= sizeof(restored) + restored.images[0].rgb.size());
}

TEST_CASE("Native textured imports retain their image and UV layout through project saving", "[CutTextures]")
{
    const std::string filename = GENERATE(std::string("two_color_png.glb"), std::string("two_color_jpeg.glb"));
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    Model model = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/" + filename,
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE(model.objects.size() == 1);
    REQUIRE(model.objects.front()->volumes.size() == 1);
    const ModelVolume& original = *model.objects.front()->volumes.front();
    REQUIRE(original.has_texture_uv());
    REQUIRE(original.display_texture);
    REQUIRE_FALSE(original.display_texture->empty());
    const auto payload = texture_display_to_bytes(*original.display_texture);
    REQUIRE_FALSE(payload.empty());

    ScopedTemporaryFile file(".3mf");
    DynamicPrintConfig config;
    StoreParams params;
    params.path = file.string();
    params.model = &model;
    params.config = &config;
    REQUIRE(store_bbs_3mf(params));
    Model reloaded = Model::read_from_file(file.string(), nullptr, &substitutions,
        LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE(reloaded.objects.size() == 1);
    REQUIRE(reloaded.objects.front()->volumes.size() == 1);
    const ModelVolume& restored = *reloaded.objects.front()->volumes.front();
    REQUIRE(restored.has_texture_uv());
    REQUIRE(restored.display_texture);
    CHECK(texture_display_to_bytes(*restored.display_texture) == payload);
    REQUIRE(restored.texture_uv.size() == original.texture_uv.size());
    for (size_t i = 0; i < original.texture_uv.size(); ++i)
        CHECK_THAT((restored.texture_uv[i] - original.texture_uv[i]).norm(), WithinAbs(0., 1e-6));
    REQUIRE(restored.texture_displacement_layers.size() == original.texture_displacement_layers.size());
    for (size_t i = 0; i < original.texture_displacement_layers.size(); ++i) {
        REQUIRE(original.texture_displacement_layers[i].image_data);
        REQUIRE(restored.texture_displacement_layers[i].image_data);
        CHECK(*restored.texture_displacement_layers[i].image_data == *original.texture_displacement_layers[i].image_data);
        CHECK(restored.texture_displacement_facet(int(i)).equals(original.texture_displacement_facet(int(i))));
    }
}

TEST_CASE("Cutting preserves each original face's UV island and image without painting caps", "[CutTextures]")
{
    const bool mirrored = GENERATE(false, true);
    const double tilt = GENERATE(0., 0.41);
    // Match the cut gizmo: a cut with connectors always creates separate objects.
    const auto mode = GENERATE(std::make_pair(false, CutConnectorType::Undef),
                               std::make_pair(true, CutConnectorType::Undef),
                               std::make_pair(false, CutConnectorType::Plug),
                               std::make_pair(false, CutConnectorType::Dowel),
                               std::make_pair(false, CutConnectorType::Snap));
    const bool keep_parts = mode.first;
    const auto connector_type = mode.second;
    CAPTURE(mirrored, tilt, keep_parts, int(connector_type));
    Model model;
    ModelObject* object = model.add_object();
    TriangleMesh cube = make_cube(20., 20., 20.);
    cube.translate(-10.f, -10.f, -10.f);
    ModelVolume* volume = object->add_volume(cube);
    object->add_instance();
    volume->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    if (mirrored)
        volume->set_mirror(Vec3d(-1., 1., 1.));
    const Transform3d from_source = volume->get_matrix();
    const auto uv_at = [](size_t face, const Vec3d& p) {
        // Deliberately different coordinates on both sides of every shared edge.
        return Vec2d(3. * double(face) + p.x() * 0.03 + p.z() * 0.04,
                     double(face) + p.y() * 0.02 - p.z() * 0.01);
    };
    const auto& source = volume->mesh().its;
    auto display = std::make_shared<TextureDisplayData>();
    for (size_t fi = 0; fi < source.indices.size(); ++fi) {
        std::array<std::array<float, 2>, 3> corners;
        for (size_t k = 0; k < 3; ++k) {
            const Vec2f uv = uv_at(fi, source.vertices[source.indices[fi][int(k)]].cast<double>()).cast<float>();
            volume->texture_uv.push_back(uv);
            corners[k] = {uv.x(), uv.y()};
        }
        display->face_uv.push_back(corners);
        display->face_image.push_back(int(fi));
        display->face_rgb.push_back({1.f, 1.f, 1.f});
        display->images.push_back({1, 1, {uint8_t(fi), 100, 200}});
    }
    const auto images = display->images;
    volume->display_texture = display;
    volume->texture_displacement_layers.emplace_back();
    TriangleSelector painted(volume->mesh());
    for (size_t fi = 0; fi < source.indices.size(); fi += 2)
        painted.set_facet(int(fi), EnforcerBlockerType::ENFORCER);
    volume->texture_displacement_facet(0).set(painted);
    Transform3d plane = Transform3d::Identity();
    plane.rotate(Eigen::AngleAxisd(tilt, Vec3d::UnitY()));
    plane.translate(Vec3d(0., 0., 1.));
    auto attributes = ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower;
    if (keep_parts)
        attributes = attributes | ModelObjectCutAttribute::KeepAsParts;
    if (connector_type != CutConnectorType::Undef) {
        auto* connector = object->add_volume(TriangleMesh(its_make_cylinder(1., 1., PI / 12.)));
        connector->set_type(ModelVolumeType::NEGATIVE_VOLUME);
        connector->set_transformation(plane * Geometry::scale_transform(Vec3d(2., 2., 4.)));
        connector->cut_info = ModelVolume::CutInfo(connector_type, 0.1f, 0.2f);
        if (connector_type == CutConnectorType::Dowel)
            attributes = attributes | ModelObjectCutAttribute::CreateDowels;
    }
    Cut cut(object, 0, plane, attributes);
    const auto& parts = cut.perform_with_plane();
    REQUIRE(parts.size() == (keep_parts ? 1 : connector_type == CutConnectorType::Dowel ? 3 : 2));
    size_t textured_parts = 0, connector_parts = 0;
    for (const ModelObject* part : parts) {
        if (connector_type == CutConnectorType::Undef)
            REQUIRE(part->volumes.size() == (keep_parts ? 2 : 1));
        for (const ModelVolume* cut_volume : part->volumes) {
        if (cut_volume->is_cut_connector()) {
            ++connector_parts;
            CHECK_FALSE(cut_volume->has_texture_uv());
            CHECK_FALSE(cut_volume->display_texture);
            CHECK(cut_volume->texture_displacement_layers.empty());
            continue;
        }
        ++textured_parts;
        const ModelVolume& result = *cut_volume;
        REQUIRE(result.has_texture_uv());
        REQUIRE(result.display_texture);
        REQUIRE(result.texture_displacement_layers.size() == 1);
        REQUIRE(result.display_texture->images.size() == images.size());
        for (size_t i = 0; i < images.size(); ++i)
            CHECK(result.display_texture->images[i].rgb == images[i].rgb);
        TriangleSelector selection(result.mesh());
        selection.deserialize(result.texture_displacement_facet(0).get_data(), false);
        std::vector<int> selected_sources;
        selection.get_facets_strict(EnforcerBlockerType::ENFORCER, &selected_sources);
        std::vector<bool> selected(result.mesh().its.indices.size(), false);
        for (int fi : selected_sources)
            selected[size_t(fi)] = true;
        size_t caps = 0, originals = 0;
        for (size_t fi = 0; fi < result.mesh().its.indices.size(); ++fi) {
            const int src = result.display_texture->face_image[fi];
            if (src < 0) {
                ++caps;
                CHECK_FALSE(selected[fi]);
                continue;
            }
            ++originals;
            CHECK(selected[fi] == (src % 2 == 0));
            for (size_t k = 0; k < 3; ++k) {
                const Vec3d p = from_source.inverse() * result.get_matrix() *
                    result.mesh().its.vertices[result.mesh().its.indices[fi][int(k)]].cast<double>();
                const Vec2d expected = uv_at(size_t(src), p);
                const Vec2f actual = result.texture_uv[fi * 3 + k];
                CHECK_THAT(actual.x(), WithinAbs(expected.x(), 1e-5));
                CHECK_THAT(actual.y(), WithinAbs(expected.y(), 1e-5));
                const auto& drawn = result.display_texture->face_uv[fi][k];
                CHECK_THAT(drawn[0], WithinAbs(expected.x(), 1e-5));
                CHECK_THAT(drawn[1], WithinAbs(expected.y(), 1e-5));
            }
        }
        CHECK(caps > 0);
        CHECK(originals > 0);
        }
    }
    CHECK(textured_parts == 2);
    if (connector_type != CutConnectorType::Undef)
        CHECK(connector_parts >= 2);
}

TEST_CASE("Splitting disconnected cut parts retains their distinct texture faces", "[CutTextures]")
{
    const bool split_objects = GENERATE(false, true);
    const bool multiple_volumes = GENERATE(false, true);
    CAPTURE(split_objects, multiple_volumes);
    Model model;
    ModelObject* object = model.add_object();
    TriangleMesh mesh = make_cube(10., 10., 10.);
    TriangleMesh other = mesh;
    other.translate(20.f, 0.f, 0.f);
    mesh.merge(other);
    ModelVolume* volume = object->add_volume(mesh);
    object->add_instance();
    const Transform3d source_to_world = volume->get_matrix();
    volume->name = "base";
    auto display = std::make_shared<TextureDisplayData>();
    for (size_t fi = 0; fi < volume->mesh().its.indices.size(); ++fi) {
        std::array<std::array<float, 2>, 3> corners;
        for (int k = 0; k < 3; ++k) {
            const Vec3f& p = volume->mesh().its.vertices[volume->mesh().its.indices[fi][k]];
            const Vec2f uv(float(fi) + p.x() * 0.003f, 0.5f + p.y() * 0.004f);
            volume->texture_uv.push_back(uv);
            corners[size_t(k)] = {uv.x(), uv.y()};
        }
        display->face_uv.push_back(corners);
        display->face_image.push_back(-1);
        display->face_rgb.push_back({float(fi) / 24.f, 0.5f, 1.f});
    }
    volume->display_texture = display;
    volume->texture_displacement_layers.emplace_back();
    TriangleSelector painted(volume->mesh());
    for (size_t fi = 0; fi < volume->mesh().its.indices.size(); ++fi)
        painted.set_facet(int(fi), EnforcerBlockerType::ENFORCER);
    volume->texture_displacement_facet(0).set(painted);
    Transform3d copy_to_world = source_to_world;
    if (multiple_volumes) {
        ModelVolume* extra = object->add_volume(*volume);
        extra->name = "offset-copy";
        extra->set_offset(Vec3d(0., 30., 0.));
        copy_to_world = extra->get_matrix();
    }
    std::vector<const ModelVolume*> results;
    if (split_objects) {
        ModelObjectPtrs parts;
        object->split(&parts, false);
        REQUIRE(parts.size() == 2);
        for (const auto* part : parts)
            for (const auto* v : part->volumes)
                results.push_back(v);
    } else {
        REQUIRE(volume->split(1, false) == 2);
        for (const auto* v : object->volumes)
            results.push_back(v);
    }
    std::vector<int> retained;
    for (const ModelVolume* part : results) {
        REQUIRE(part->has_texture_uv());
        REQUIRE(part->display_texture);
        REQUIRE(part->texture_displacement_layers.size() == 1);
        CHECK_FALSE(part->texture_displacement_facet(0).empty());
        for (size_t fi = 0; fi < part->mesh().its.indices.size(); ++fi) {
            const int src = int(std::lround(part->display_texture->face_rgb[fi][0] * 24.f));
            retained.push_back(src);
            CHECK_THAT(part->display_texture->face_rgb[fi][0], WithinAbs(float(src) / 24.f, 1e-6));
            for (int k = 0; k < 3; ++k) {
                Transform3d source_transform = source_to_world;
                if (part->name.find("offset-copy") == 0)
                    source_transform = copy_to_world;
                const Vec3d p = source_transform.inverse() * part->get_object()->instances.front()->get_matrix() *
                    part->get_matrix() * part->mesh().its.vertices[part->mesh().its.indices[fi][k]].cast<double>();
                const float expected_u = float(src) + float(p.x()) * 0.003f;
                const float expected_v = 0.5f + float(p.y()) * 0.004f;
                CHECK_THAT(part->texture_uv[fi * 3 + size_t(k)].x(), WithinAbs(expected_u, 1e-6));
                CHECK_THAT(part->texture_uv[fi * 3 + size_t(k)].y(), WithinAbs(expected_v, 1e-6));
                CHECK_THAT(part->display_texture->face_uv[fi][size_t(k)][0], WithinAbs(expected_u, 1e-6));
                CHECK_THAT(part->display_texture->face_uv[fi][size_t(k)][1], WithinAbs(expected_v, 1e-6));
            }
        }
    }
    std::sort(retained.begin(), retained.end());
    REQUIRE(retained.size() == (multiple_volumes ? 48 : 24));
    for (size_t fi = 0; fi < retained.size(); ++fi)
        CHECK(retained[fi] == int(multiple_volumes ? fi / 2 : fi));
}

TEST_CASE("Cut face provenance stays aligned when the plane crosses existing vertices", "[CutTextures]")
{
    indexed_triangle_set mesh = make_cube(20., 20., 20.).its;
    const float z = GENERATE(0.f, 10.f, 20.f);
    indexed_triangle_set upper, lower;
    std::vector<int> above, below;
    cut_mesh(mesh, z, &upper, &lower, true, &above, &below);
    REQUIRE(upper.indices.size() == above.size());
    REQUIRE(lower.indices.size() == below.size());
    for (const auto& side : {std::make_pair(&upper, &above), std::make_pair(&lower, &below)})
        for (size_t fi = 0; fi < side.first->indices.size(); ++fi) {
            const int src = (*side.second)[fi];
            const auto& tri = side.first->indices[fi];
            if (src < 0) {
                for (int k = 0; k < 3; ++k)
                    CHECK_THAT(side.first->vertices[tri[k]].z(), WithinAbs(z, 1e-5));
            } else {
                REQUIRE(size_t(src) < mesh.indices.size());
                const auto& st = mesh.indices[size_t(src)];
                const Vec3f a = mesh.vertices[st[0]];
                const Vec3f normal = (mesh.vertices[st[1]] - a).cross(mesh.vertices[st[2]] - a).normalized();
                for (int k = 0; k < 3; ++k)
                    CHECK_THAT(normal.dot(side.first->vertices[tri[k]] - a), WithinAbs(0., 1e-5));
            }
        }
}

TEST_CASE("Cutting retains a partially painted texture mask on the original surface", "[CutTextures]")
{
    Model model;
    auto* object = model.add_object();
    TriangleMesh mesh = make_cube(20., 20., 20.);
    mesh.translate(-10.f, -10.f, -10.f);
    auto* volume = object->add_volume(mesh);
    object->add_instance();
    const auto& its = volume->mesh().its;
    for (const auto& face : its.indices)
        for (int k = 0; k < 3; ++k) {
            const Vec3f& p = its.vertices[face[k]];
            volume->texture_uv.emplace_back(p.y() / 20.f, p.z() / 20.f);
        }
    volume->texture_displacement_layers.emplace_back();
    TriangleSelector painted(volume->mesh());
    int hit_face = -1;
    for (size_t i = 0; i < its.indices.size(); ++i) {
        const auto& face = its.indices[i];
        if (its.vertices[face[0]].x() == 10.f &&
            its.vertices[face[1]].x() == 10.f &&
            its.vertices[face[2]].x() == 10.f) {
            hit_face = int(i);
            break;
        }
    }
    REQUIRE(hit_face >= 0);
    const Vec3f center(10.f, 0.f, 0.f);
    auto cursor = TriangleSelector::SinglePointCursor::cursor_factory(
        center, Vec3f(30.f, 0.f, 0.f), 4.f, TriangleSelector::SPHERE,
        Transform3d::Identity(), TriangleSelector::ClippingPlane());
    painted.select_patch(hit_face, std::move(cursor), EnforcerBlockerType::ENFORCER,
                         Transform3d::Identity(), true);
    volume->texture_displacement_facet(0).set(painted);
    const auto painted_area = [](const indexed_triangle_set& data) {
        double area = 0.;
        for (const auto& f : data.indices)
            area += 0.5 * double((data.vertices[f[1]] - data.vertices[f[0]])
                                    .cross(data.vertices[f[2]] - data.vertices[f[0]]).norm());
        return area;
    };
    const double before = painted_area(painted.get_facets_strict(EnforcerBlockerType::ENFORCER));
    REQUIRE(before > 10.);
    Cut cut(object, 0, Transform3d::Identity(),
            ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower);
    double after = 0.;
    for (const auto* part : cut.perform_with_plane()) {
        const auto* v = part->volumes.front();
        TriangleSelector restored(v->mesh());
        restored.deserialize(v->texture_displacement_facet(0).get_data(), false);
        const auto selected = restored.get_facets_strict(EnforcerBlockerType::ENFORCER);
        REQUIRE_FALSE(selected.indices.empty());
        after += painted_area(selected);
        for (const auto& f : selected.indices)
            for (int k = 0; k < 3; ++k) {
                const Vec3d p = v->get_matrix() * selected.vertices[f[k]].cast<double>();
                CHECK_THAT(p.x(), WithinAbs(10., 1e-5));
            }
    }
    CHECK_THAT(after, WithinAbs(before, 1e-4));
}

TEST_CASE("Cutting preserves overlapping brush boundaries in independent texture slots", "[CutTextures]")
{
    const bool mirrored = GENERATE(false, true);
    const double tilt = GENERATE(0., 0.37);
    Model model;
    auto* object = model.add_object();
    TriangleMesh mesh = make_cube(20., 20., 20.);
    mesh.translate(-10.f, -10.f, -10.f);
    auto* volume = object->add_volume(mesh);
    object->add_instance();
    volume->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    if (mirrored)
        volume->set_mirror(Vec3d(-1., 1., 1.));
    const Transform3d from_source = volume->get_matrix();
    const Transform3d to_source = from_source.inverse();
    const auto& its = volume->mesh().its;
    int hit = -1;
    for (size_t face = 0; face < its.indices.size(); ++face) {
        const auto& index = its.indices[face];
        for (int k = 0; k < 3; ++k) {
            const Vec3f& p = its.vertices[index[k]];
            volume->texture_uv.emplace_back(p.y() / 20.f, p.z() / 20.f);
        }
        if (its.vertices[index[0]].x() == 10.f && its.vertices[index[1]].x() == 10.f &&
            its.vertices[index[2]].x() == 10.f)
            hit = int(face);
    }
    REQUIRE(hit >= 0);
    std::array<indexed_triangle_set, 2> before;
    const auto area = [](const indexed_triangle_set& triangles, const Transform3d& transform) {
        double sum = 0.;
        for (const auto& face : triangles.indices) {
            const Vec3d a = transform * triangles.vertices[face[0]].cast<double>();
            const Vec3d b = transform * triangles.vertices[face[1]].cast<double>();
            const Vec3d c = transform * triangles.vertices[face[2]].cast<double>();
            sum += (b - a).cross(c - a).norm() * 0.5;
        }
        return sum;
    };
    for (int slot = 0; slot < 2; ++slot) {
        volume->texture_displacement_layers.emplace_back();
        TriangleSelector selector(volume->mesh());
        const Vec3f center(10.f, float(slot) * 2.f - 1.f, float(slot) - 0.5f);
        selector.select_patch(hit, TriangleSelector::SinglePointCursor::cursor_factory(
            center, Vec3f(30.f, 0.f, 0.f), 4.f, TriangleSelector::SPHERE,
            Transform3d::Identity(), TriangleSelector::ClippingPlane()),
            EnforcerBlockerType::ENFORCER, Transform3d::Identity(), true);
        volume->texture_displacement_facet(slot).set(selector);
        before[size_t(slot)] = selector.get_facets_strict(EnforcerBlockerType::ENFORCER);
        REQUIRE(area(before[size_t(slot)], from_source) > 10.);
    }
    Transform3d plane = Transform3d::Identity();
    plane.rotate(Eigen::AngleAxisd(tilt, Vec3d::UnitY()));
    Cut cut(object, 0, plane, ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower);
    std::array<double, 2> after{};
    double solid_volume = 0.;
    for (const auto* part : cut.perform_with_plane())
        for (const auto* v : part->volumes) {
            REQUIRE(v->has_texture_uv());
            CHECK(its_num_open_edges(v->mesh().its) == 0);
            solid_volume += double(its_volume(v->mesh().its)) * std::abs(v->get_matrix().linear().determinant());
            for (int slot = 0; slot < 2; ++slot) {
                TriangleSelector selector(v->mesh());
                selector.deserialize(v->texture_displacement_facet(slot).get_data(), false);
                const auto selected = selector.get_facets_strict(EnforcerBlockerType::ENFORCER);
                after[size_t(slot)] += area(selected, v->get_matrix());
                for (const auto& face : selected.indices) {
                    Vec3d centroid = Vec3d::Zero();
                    for (int k = 0; k < 3; ++k)
                        centroid += to_source * v->get_matrix() * selected.vertices[face[k]].cast<double>() / 3.;
                    CHECK_THAT(centroid.x(), WithinAbs(10., 2e-5));
                    bool covered = false;
                    const auto& source = before[size_t(slot)];
                    for (const auto& f : source.indices) {
                        const Vec2d p = centroid.tail<2>();
                        const Vec2d a = source.vertices[f[0]].tail<2>().cast<double>();
                        const Vec2d b = source.vertices[f[1]].tail<2>().cast<double>();
                        const Vec2d c = source.vertices[f[2]].tail<2>().cast<double>();
                        const auto cross = [](const Vec2d& u, const Vec2d& w) { return u.x() * w.y() - u.y() * w.x(); };
                        const double determinant = cross(b - a, c - a);
                        if (std::abs(determinant) < 1e-15)
                            continue;
                        const double u = cross(p - a, c - a) / determinant;
                        const double w = cross(b - a, p - a) / determinant;
                        if (u >= -1e-5 && w >= -1e-5 && u + w <= 1. + 1e-5) {
                            covered = true;
                            break;
                        }
                    }
                    REQUIRE(covered);
                }
            }
        }
    for (size_t slot = 0; slot < before.size(); ++slot)
        CHECK_THAT(after[slot], WithinAbs(area(before[slot], from_source), 1e-4));
    CHECK_THAT(solid_volume, WithinAbs(8000. * std::abs(from_source.linear().determinant()), 0.01));
}

TEST_CASE("Cutting keeps a view projector anchored independently of model UV coordinates", "[CutTextures]")
{
    const bool have_uv = GENERATE(false, true);
    const bool mixed_stack = GENERATE(false, true);
    const bool projective = GENERATE(false, true);
    const bool mirrored = GENERATE(false, true);
    const bool tiled = GENERATE(false, true);
    const bool reload = GENERATE(false, true);
    CAPTURE(have_uv, mixed_stack, projective, mirrored, tiled, reload);
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE_FALSE(fixture.objects.empty());
    REQUIRE_FALSE(fixture.objects.front()->volumes.front()->texture_displacement_layers.empty());
    TextureDisplacementLayer layer = fixture.objects.front()->volumes.front()->texture_displacement_layers.front();
    layer.projection_method = TextureProjectionMethod::ViewProjected;
    layer.view_project_projective = projective;
    layer.view_project_matrix = {0.03f, 0.02f, 0.01f, 0.5f,
                                -0.01f, 0.015f, 0.025f, 0.4f,
                                0.001f, 0.002f, 0.003f, 1.f};
    layer.view_project_right = Vec3f(0.3f, 1.f, 0.2f);
    layer.view_project_up = Vec3f(0.1f, 0.4f, 1.f);
    layer.tiling_scale = 20.f;
    layer.rotation_deg = 21.f;
    layer.offset = Vec2f(0.2f, 0.4f);
    layer.tile_enabled = tiled;
    const auto texture = decode_height_texture(layer);
    REQUIRE(texture.has_color());
    Model model;
    auto* object = model.add_object();
    TriangleMesh mesh = make_cube(20., 20., 20.);
    mesh.translate(-10.f, -10.f, -10.f);
    auto* volume = object->add_volume(mesh);
    if (have_uv)
        for (const auto& face : volume->mesh().its.indices)
            for (int k = 0; k < 3; ++k) {
                const Vec3f& p = volume->mesh().its.vertices[face[k]];
                volume->texture_uv.emplace_back(p.x() / 20.f, p.y() / 20.f);
            }
    object->add_instance();
    volume->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    volume->set_rotation(Vec3d(0.12, 0.21, 0.13));
    if (mirrored)
        volume->set_mirror(Vec3d(-1., 1., 1.));
    const Transform3d to_source = volume->get_matrix().inverse();
    volume->texture_displacement_layers.push_back(layer);
    if (mixed_stack) {
        // An unpainted layer of another projection must not discard the painted projector.
        auto other = layer;
        other.slot = 1;
        other.projection_method = TextureProjectionMethod::Triplanar;
        volume->texture_displacement_layers.push_back(std::move(other));
    }
    TriangleSelector selector(volume->mesh());
    for (size_t face = 0; face < volume->mesh().its.indices.size(); ++face)
        selector.set_facet(int(face), EnforcerBlockerType::ENFORCER);
    volume->texture_displacement_facet(0).set(selector);
    Transform3d plane = Transform3d::Identity();
    plane.rotate(Eigen::AngleAxisd(0.37, Vec3d::UnitY()));
    Cut cut(object, 0, plane, ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower);
    Model result;
    for (const auto* part : cut.perform_with_plane())
        result.add_object(*part);
    ScopedTemporaryFile file(".3mf");
    DynamicPrintConfig config;
    StoreParams params;
    params.path = file.string();
    params.model = &result;
    params.config = &config;
    REQUIRE(store_bbs_3mf(params));
    Model reloaded = Model::read_from_file(file.string(), nullptr, &substitutions,
        LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE(reloaded.objects.size() == 2);
    size_t samples = 0;
    const auto& evaluated = reload ? reloaded : result;
    for (size_t part_index = 0; part_index < evaluated.objects.size(); ++part_index)
        for (const auto* v : evaluated.objects[part_index]->volumes) {
            // LoadModel may move the component transform to its instance. The
            // projector is anchored to local geometry, independent of placement.
            const auto* original = result.objects[part_index]->volumes.front();
            REQUIRE(v->mesh().its.vertices.size() == original->mesh().its.vertices.size());
            for (size_t vertex = 0; vertex < v->mesh().its.vertices.size(); ++vertex)
                CHECK_THAT((v->mesh().its.vertices[vertex] - original->mesh().its.vertices[vertex]).norm(), WithinAbs(0., 2e-5));
            REQUIRE(v->has_texture_uv() == have_uv);
            REQUIRE_FALSE(v->display_texture);
            if (have_uv) {
                REQUIRE(v->texture_uv.size() == original->texture_uv.size());
                for (size_t corner = 0; corner < v->texture_uv.size(); ++corner)
                    CHECK_THAT((v->texture_uv[corner] - original->texture_uv[corner]).norm(), WithinAbs(0., 1e-6));
            }
            REQUIRE(v->texture_displacement_layers.size() == (mixed_stack ? 2 : 1));
            if (mixed_stack) {
                CHECK(v->texture_displacement_layers[1].projection_method == TextureProjectionMethod::Triplanar);
                CHECK(v->texture_displacement_facet(1).empty());
            }
            const auto& restored_layer = v->texture_displacement_layers.front();
            REQUIRE(restored_layer.view_project_projective);
            REQUIRE(restored_layer.image_data);
            REQUIRE(layer.image_data);
            CHECK(*restored_layer.image_data == *layer.image_data);
            TriangleSelector painted(v->mesh());
            painted.deserialize(v->texture_displacement_facet(0).get_data(), false);
            const auto selected = painted.get_facets_strict(EnforcerBlockerType::ENFORCER);
            REQUIRE_FALSE(selected.indices.empty());
            for (const auto& face : selected.indices) {
                const Vec3f p = ((selected.vertices[face[0]] + selected.vertices[face[1]] +
                                 selected.vertices[face[2]]) / 3.f).eval();
                const Vec3f source_p = (to_source * original->get_matrix() * p.cast<double>()).cast<float>();
                Vec3f expected, actual;
                const bool expected_covered = sample_layer_color(texture, layer, source_p, Vec3f::UnitZ(), expected);
                const bool actual_covered = sample_layer_color(texture, restored_layer, p, Vec3f::UnitZ(), actual);
                REQUIRE(actual_covered == expected_covered);
                if (expected_covered)
                    CHECK_THAT((expected - actual).norm(), WithinAbs(0., 2e-5));
                ++samples;
            }
        }
    CHECK(samples >= 12);
}

TEST_CASE("Groove and contour cuts retain original texture islands through project saving", "[CutTextures]")
{
    const bool groove = GENERATE(false, true);
    const bool mirrored = GENERATE(false, true);
    const bool keep_parts = GENERATE(false, true);
    CAPTURE(groove, mirrored, keep_parts);
    Model model;
    auto* object = model.add_object();
    TriangleMesh mesh = make_cube(20., 20., 20.);
    mesh.translate(-10.f, -10.f, -10.f);
    auto* source = object->add_volume(mesh);
    object->add_instance();
    source->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    if (mirrored)
        source->set_mirror(Vec3d(-1., 1., 1.));
    const Transform3d to_source = source->get_matrix().inverse();
    const auto uv_at = [](int face, const Vec3d& p) {
        return Vec2f(float(face) * 2.f + float(p.x() * 0.03 + p.z() * 0.02),
                     float(face) * 0.5f + float(p.y() * 0.04 - p.z() * 0.01));
    };
    auto display = std::make_shared<TextureDisplayData>();
    TriangleSelector painted(source->mesh());
    for (size_t fi = 0; fi < source->mesh().its.indices.size(); ++fi) {
        const auto& face = source->mesh().its.indices[fi];
        std::array<std::array<float, 2>, 3> corners;
        for (int k = 0; k < 3; ++k) {
            const Vec2f uv = uv_at(int(fi), source->mesh().its.vertices[face[k]].cast<double>());
            source->texture_uv.push_back(uv);
            corners[size_t(k)] = {uv.x(), uv.y()};
        }
        display->face_uv.push_back(corners);
        display->face_image.push_back(int(fi));
        display->face_rgb.push_back({1.f, 1.f, 1.f});
        display->images.push_back({1, 1, {uint8_t(fi), 100, 200}});
        if (fi % 2 == 0)
            painted.set_facet(int(fi), EnforcerBlockerType::ENFORCER);
    }
    source->display_texture = display;
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE_FALSE(fixture.objects.empty());
    REQUIRE_FALSE(fixture.objects.front()->volumes.front()->texture_displacement_layers.empty());
    source->texture_displacement_layers.push_back(fixture.objects.front()->volumes.front()->texture_displacement_layers.front());
    source->texture_displacement_layers.front().projection_method = TextureProjectionMethod::ModelUV;
    source->texture_displacement_facet(0).set(painted);
    const auto attributes = ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower;
    Model result;
    if (groove) {
        Cut::Groove parameters;
        parameters.depth = 4.f;
        parameters.width = 5.f;
        parameters.flaps_angle = float(PI / 3.);
        parameters.angle = 0.2f;
        Cut cut(object, 0, Transform3d::Identity(), attributes);
        for (const auto* part : cut.perform_with_groove(parameters, Transform3d::Identity(), 1, 2.f, 10.f, keep_parts))
            result.add_object(*part);
    } else {
        Cut first(object, 0, Transform3d::Identity(), attributes | ModelObjectCutAttribute::KeepAsParts);
        const auto& parts = first.perform_with_plane();
        REQUIRE(parts.size() == 1);
        REQUIRE(parts.front()->volumes.size() == 2);
        auto final_attributes = attributes;
        if (keep_parts)
            final_attributes = final_attributes | ModelObjectCutAttribute::KeepAsParts;
        Cut cut(parts.front(), 0, Transform3d::Identity(), final_attributes);
        for (const auto* part : cut.perform_by_contour(object, {{true, false}, {false, false}}, 0))
            result.add_object(*part);
    }
    REQUIRE_FALSE(result.objects.empty());
    size_t originals = 0, caps = 0;
    for (const auto* part : result.objects)
        for (const auto* volume : part->volumes) {
            REQUIRE(volume->has_texture_uv());
            REQUIRE(volume->display_texture);
            REQUIRE(volume->display_texture->images.size() == display->images.size());
            TriangleSelector selection(volume->mesh());
            selection.deserialize(volume->texture_displacement_facet(0).get_data(), false);
            std::vector<int> selected_faces;
            selection.get_facets_strict(EnforcerBlockerType::ENFORCER, &selected_faces);
            std::vector<bool> selected(volume->mesh().its.indices.size(), false);
            for (int fi : selected_faces)
                selected[size_t(fi)] = true;
            for (size_t fi = 0; fi < volume->mesh().its.indices.size(); ++fi) {
                const int src = volume->display_texture->face_image[fi];
                if (src < 0) {
                    ++caps;
                    CHECK_FALSE(selected[fi]);
                    continue;
                }
                ++originals;
                CHECK(selected[fi] == (src % 2 == 0));
                for (int k = 0; k < 3; ++k) {
                    const Vec3d p = to_source * volume->get_matrix() *
                        volume->mesh().its.vertices[volume->mesh().its.indices[fi][k]].cast<double>();
                    const Vec2f expected = uv_at(src, p);
                    CHECK_THAT((volume->texture_uv[fi * 3 + size_t(k)] - expected).norm(), WithinAbs(0., 2e-5));
                    const auto& drawn = volume->display_texture->face_uv[fi][size_t(k)];
                    CHECK_THAT((Vec2f(drawn[0], drawn[1]) - expected).norm(), WithinAbs(0., 2e-5));
                }
            }
        }
    CHECK(originals > 0);
    CHECK(caps > 0);
    ScopedTemporaryFile file(".3mf");
    DynamicPrintConfig config;
    StoreParams params;
    params.path = file.string();
    params.model = &result;
    params.config = &config;
    REQUIRE(store_bbs_3mf(params));
    const Model restored = Model::read_from_file(file.string(), nullptr, &substitutions,
        LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE(restored.objects.size() == result.objects.size());
    for (size_t oi = 0; oi < result.objects.size(); ++oi) {
        REQUIRE(restored.objects[oi]->volumes.size() == result.objects[oi]->volumes.size());
        for (size_t vi = 0; vi < result.objects[oi]->volumes.size(); ++vi) {
            const auto* a = result.objects[oi]->volumes[vi];
            const auto* b = restored.objects[oi]->volumes[vi];
            REQUIRE(b->display_texture);
            REQUIRE(b->texture_displacement_layers.size() == a->texture_displacement_layers.size());
            REQUIRE(b->texture_displacement_layers.front().image_data);
            CHECK(*b->texture_displacement_layers.front().image_data == *a->texture_displacement_layers.front().image_data);
            CHECK(texture_display_to_bytes(*a->display_texture) == texture_display_to_bytes(*b->display_texture));
            CHECK(a->texture_displacement_facet(0).equals(b->texture_displacement_facet(0)));
        }
    }
}

TEST_CASE("Splitting keeps view projection anchored while recentering disconnected parts", "[CutTextures]")
{
    const bool split_objects = GENERATE(false, true);
    const bool mirrored = GENERATE(false, true);
    const bool mixed_stack = GENERATE(false, true);
    CAPTURE(split_objects, mirrored, mixed_stack);
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    TextureDisplacementLayer layer = fixture.objects.front()->volumes.front()->texture_displacement_layers.front();
    layer.projection_method = TextureProjectionMethod::ViewProjected;
    layer.view_project_projective = true;
    layer.view_project_matrix = {0.013f, 0.021f, 0.007f, 0.5f,
                                0.005f, -0.017f, 0.023f, 0.5f,
                                0.001f, 0.002f, 0.001f, 1.f};
    layer.tile_enabled = true;
    const auto texture = decode_height_texture(layer);
    REQUIRE(texture.has_color());
    Model model;
    auto* object = model.add_object();
    TriangleMesh mesh = make_cube(10., 10., 10.);
    TriangleMesh other = mesh;
    other.translate(20.f, 0.f, 0.f);
    mesh.merge(other);
    auto* volume = object->add_volume(mesh);
    volume->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    if (mirrored)
        volume->set_mirror(Vec3d(-1., 1., 1.));
    object->add_instance();
    const indexed_triangle_set source_mesh = volume->mesh().its;
    volume->texture_displacement_layers.push_back(layer);
    if (mixed_stack) {
        auto unpainted = layer;
        unpainted.slot = 1;
        unpainted.projection_method = TextureProjectionMethod::Triplanar;
        volume->texture_displacement_layers.push_back(std::move(unpainted));
    }
    TriangleSelector painted(volume->mesh());
    for (size_t fi = 0; fi < volume->mesh().its.indices.size(); ++fi)
        painted.set_facet(int(fi), EnforcerBlockerType::ENFORCER);
    volume->texture_displacement_facet(0).set(painted);
    std::vector<const ModelVolume*> results;
    if (split_objects) {
        ModelObjectPtrs parts;
        object->split(&parts, false);
        REQUIRE(parts.size() == 2);
        for (const auto* part : parts)
            results.insert(results.end(), part->volumes.begin(), part->volumes.end());
    } else {
        REQUIRE(volume->split(1, false) == 2);
        results.insert(results.end(), object->volumes.begin(), object->volumes.end());
    }
    REQUIRE(results.size() == 2);
    for (const auto* part : results) {
        REQUIRE(part->texture_displacement_layers.size() == (mixed_stack ? 2 : 1));
        if (mixed_stack) {
            CHECK(part->texture_displacement_layers[1].projection_method == TextureProjectionMethod::Triplanar);
            CHECK(part->texture_displacement_facet(1).empty());
        }
        REQUIRE_FALSE(part->texture_displacement_facet(0).empty());
        // Splitting recenters local geometry independently of instance placement.
        // Match its corners back to the original mesh before comparing colour.
        const Vec3f shift = part->mesh().get_init_shift().cast<float>();
        for (const auto& p : part->mesh().its.vertices) {
            const Vec3f original = (p + shift).eval();
            REQUIRE(std::any_of(source_mesh.vertices.begin(), source_mesh.vertices.end(),
                [&](const Vec3f& vertex) { return (vertex - original).norm() < 1e-5f; }));
        }
        for (const auto& face : part->mesh().its.indices) {
            const Vec3f p = ((part->mesh().its.vertices[face[0]] + part->mesh().its.vertices[face[1]] +
                part->mesh().its.vertices[face[2]]) / 3.f).eval();
            const Vec3f source = (p + shift).eval();
            Vec3f expected, actual;
            REQUIRE(sample_layer_color(texture, layer, source, Vec3f::UnitZ(), expected));
            REQUIRE(sample_layer_color(texture, part->texture_displacement_layers.front(), p, Vec3f::UnitZ(), actual));
            CHECK_THAT((actual - expected).norm(), WithinAbs(0., 2e-5));
        }
    }
}

TEST_CASE("Cutting preserves analytic and unwrap projection samples through project saving", "[CutTextures][ProjectionAnchor]")
{
    const auto method = GENERATE(TextureProjectionMethod::Triplanar, TextureProjectionMethod::Cylindrical,
                                 TextureProjectionMethod::Spherical, TextureProjectionMethod::LSCM);
    const bool mirrored = GENERATE(false, true);
    const bool reload = GENERATE(false, true);
    const int slot = GENERATE(0, 7);
    const bool partial = GENERATE(false, true);
    CAPTURE(int(method), mirrored, reload, slot, partial);
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    auto layer = fixture.objects.front()->volumes.front()->texture_displacement_layers.front();
    layer.slot = slot;
    layer.projection_method = method;
    layer.tiling_scale = 13.f;
    layer.rotation_deg = 21.f;
    layer.offset = Vec2f(0.2f, 0.4f);
    layer.tile_enabled = true;
    layer.depth_mm = 0.5f;
    layer.color_enabled = true;
    Model model;
    auto *object = model.add_object();
    TriangleMesh mesh = make_cube(20., 20., 20.);
    mesh.translate(-10.f, -10.f, -10.f);
    auto *volume = object->add_volume(mesh);
    object->add_instance();
    volume->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    volume->set_rotation(Vec3d(0.12, 0.21, 0.13));
    if (mirrored)
        volume->set_mirror(Vec3d(-1., 1., 1.));
    volume->texture_displacement_layers.push_back(layer);
    TriangleSelector selector(volume->mesh());
    for (size_t face = 0; face < volume->mesh().its.indices.size(); ++face)
        selector.set_facet(int(face), EnforcerBlockerType::ENFORCER);
    if (partial) {
        const auto &its = volume->mesh().its;
        int hit = -1;
        for (size_t f = 0; f < its.indices.size(); ++f) {
            const auto &t = its.indices[f];
            if (its.vertices[t[0]].x() == 10.f && its.vertices[t[1]].x() == 10.f && its.vertices[t[2]].x() == 10.f) {
                hit = int(f);
                break;
            }
        }
        REQUIRE(hit >= 0);
        selector.select_patch(hit, TriangleSelector::SinglePointCursor::cursor_factory(
            Vec3f(10.f, 0.f, 0.f), Vec3f(30.f, 0.f, 0.f), 4.f, TriangleSelector::SPHERE,
            Transform3d::Identity(), TriangleSelector::ClippingPlane()),
            EnforcerBlockerType::NONE, Transform3d::Identity(), true);
    }
    volume->texture_displacement_facet(slot).set(selector);
    TextureDisplacementFacetsData masks;
    masks[size_t(slot)] = selector.serialize();
    const Transform3d original_frame = texture_displacement_bake_frame(texture_displacement_volume_to_world(*volume));
    const Transform3d to_source = volume->get_matrix().inverse();
    auto projected = volume->mesh().its;
    for (auto &p : projected.vertices)
        p = (original_frame * p.cast<double>()).cast<float>();
    const auto expected = make_combined_displacement_sampler(projected, volume->texture_displacement_layers, masks);
    REQUIRE(expected);
    Vec3f expected_rgb = Vec3f::Zero(), actual_rgb = Vec3f::Zero();
    const auto expected_color = make_combined_color_sampler(projected, volume->texture_displacement_layers, masks,
        [&expected_rgb](const Vec3f &rgb) { expected_rgb = rgb; return 1; });
    REQUIRE(expected_color);
    Transform3d plane = Transform3d::Identity();
    plane.rotate(Eigen::AngleAxisd(0.37, Vec3d::UnitY()));
    Cut cut(object, 0, plane, ModelObjectCutAttribute::KeepUpper | ModelObjectCutAttribute::KeepLower);
    Model result;
    for (const auto *part : cut.perform_with_plane())
        result.add_object(*part);
    REQUIRE(result.objects.size() == 2);
    ScopedTemporaryFile file(".3mf");
    DynamicPrintConfig config;
    StoreParams params;
    params.path = file.string();
    params.model = &result;
    params.config = &config;
    REQUIRE(store_bbs_3mf(params));
    Model restored = Model::read_from_file(file.string(), nullptr, &substitutions,
        LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    REQUIRE(restored.objects.size() == 2);
    const auto &evaluated = reload ? restored : result;
    size_t samples = 0;
    for (size_t i = 0; i < evaluated.objects.size(); ++i) {
        const auto *part = evaluated.objects[i]->volumes.front();
        const auto *cut_part = result.objects[i]->volumes.front();
        REQUIRE(part->texture_displacement_layers.size() == 1);
        REQUIRE(part->texture_displacement_layers.front().projection_anchor);
        REQUIRE_FALSE(part->has_texture_uv());
        TextureDisplacementFacetsData part_masks;
        part_masks[size_t(slot)] = part->texture_displacement_facet(slot).get_data();
        auto actual = make_combined_displacement_sampler(part->mesh().its, part->texture_displacement_layers, part_masks);
        REQUIRE(actual);
        const auto actual_color = make_combined_color_sampler(part->mesh().its, part->texture_displacement_layers, part_masks,
            [&actual_rgb](const Vec3f &rgb) { actual_rgb = rgb; return 1; });
        REQUIRE(actual_color);
        TriangleSelector painted(part->mesh());
        painted.deserialize(part_masks[size_t(slot)], false);
        const auto patch = painted.get_facets_strict(EnforcerBlockerType::ENFORCER);
        REQUIRE_FALSE(patch.indices.empty());
        const Transform3d to_original = original_frame * to_source * cut_part->get_matrix();
        const Matrix3d normal_to_original = to_original.linear().inverse().transpose();
        for (const auto &face : patch.indices) {
            const Vec3f a = patch.vertices[face[0]], b = patch.vertices[face[1]], c = patch.vertices[face[2]];
            Vec3f normal = (b-a).cross(c-a).normalized();
            for (const auto &weights : {Vec3f(0.2f, 0.3f, 0.5f), Vec3f(0.6f, 0.3f, 0.1f)}) {
                const Vec3f p = weights[0]*a + weights[1]*b + weights[2]*c;
                const Vec3f source_p = (to_original * p.cast<double>()).cast<float>();
                const Vec3f source_n = (normal_to_original * normal.cast<double>()).normalized().cast<float>();
                CHECK_THAT(actual(p, normal), WithinAbs(expected(source_p, source_n), 2e-4));
                REQUIRE(actual_color(p, normal) == expected_color(source_p, source_n));
                CHECK_THAT((actual_rgb - expected_rgb).norm(), WithinAbs(0., 4e-4));
                ++samples;
            }
        }
        // Reframing the mesh for baking must not move the preserved projection.
        const Transform3d new_frame = texture_displacement_bake_frame(texture_displacement_volume_to_world(*part));
        auto framed_mesh = part->mesh().its;
        for (auto &p : framed_mesh.vertices)
            p = (new_frame * p.cast<double>()).cast<float>();
        const auto framed = make_combined_displacement_sampler(framed_mesh,
            texture_layers_in_frame(part->texture_displacement_layers, new_frame), part_masks);
        REQUIRE(framed);
        const auto &face = patch.indices.front();
        const Vec3f p = (patch.vertices[face[0]] + patch.vertices[face[1]] + patch.vertices[face[2]]) / 3.f;
        const Vec3f n = (patch.vertices[face[1]]-patch.vertices[face[0]]).cross(patch.vertices[face[2]]-patch.vertices[face[0]]).normalized();
        const Vec3f fp = (new_frame * p.cast<double>()).cast<float>();
        const Vec3f fn = (new_frame.linear().inverse().transpose() * n.cast<double>()).normalized().cast<float>();
        CHECK_THAT(framed(fp, fn), WithinAbs(actual(p, n), 2e-4));
    }
    CHECK(samples >= 24);
}

TEST_CASE("Splitting preserves original analytic and unwrap placement after recentering", "[CutTextures][ProjectionAnchor]")
{
    const auto method = GENERATE(TextureProjectionMethod::Triplanar, TextureProjectionMethod::Cylindrical,
                                 TextureProjectionMethod::Spherical, TextureProjectionMethod::LSCM);
    const bool split_objects = GENERATE(false, true);
    const bool mirrored = GENERATE(false, true);
    CAPTURE(int(method), split_objects, mirrored);
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    auto layer = fixture.objects.front()->volumes.front()->texture_displacement_layers.front();
    layer.slot = 7;
    layer.projection_method = method;
    layer.tiling_scale = 13.f;
    layer.rotation_deg = 21.f;
    layer.tile_enabled = true;
    Model model;
    auto *object = model.add_object();
    TriangleMesh left = make_cube(10., 10., 10.);
    TriangleMesh right = left;
    right.translate(30.f, 0.f, 0.f);
    left.merge(right);
    auto *source = object->add_volume(left);
    object->add_instance();
    source->set_scaling_factor(Vec3d(1.2, 0.8, 1.1));
    source->set_rotation(Vec3d(0.12, 0.21, 0.13));
    if (mirrored)
        source->set_mirror(Vec3d(-1., 1., 1.));
    source->texture_displacement_layers.push_back(layer);
    TriangleSelector selector(source->mesh());
    for (size_t i = 0; i < source->mesh().its.indices.size(); ++i)
        selector.set_facet(int(i), EnforcerBlockerType::ENFORCER);
    source->texture_displacement_facet(7).set(selector);
    const Transform3d original = texture_displacement_volume_to_world(*source);
    const Transform3d frame = texture_displacement_bake_frame(original);
    auto projected = source->mesh().its;
    for (auto &p : projected.vertices)
        p = (frame * p.cast<double>()).cast<float>();
    TextureDisplacementFacetsData masks;
    masks[7] = selector.serialize();
    const auto expected = make_combined_displacement_sampler(projected, source->texture_displacement_layers, masks);
    REQUIRE(expected);
    std::vector<ModelVolume *> parts;
    ModelObjectPtrs objects;
    if (split_objects) {
        object->split(&objects, false);
        for (auto *o : objects)
            for (auto *v : o->volumes)
                parts.push_back(v);
    } else {
        REQUIRE(source->split(1, false) == 2);
        parts = object->volumes;
    }
    REQUIRE(parts.size() == 2);
    for (const auto *part : parts) {
        REQUIRE(part->texture_displacement_layers.size() == 1);
        REQUIRE(part->texture_displacement_layers.front().projection_anchor);
        TextureDisplacementFacetsData part_masks;
        part_masks[7] = part->texture_displacement_facet(7).get_data();
        const auto actual = make_combined_displacement_sampler(part->mesh().its, part->texture_displacement_layers, part_masks);
        REQUIRE(actual);
        // Recentring subtracts this known component centroid from its vertices.
        // Texture provenance follows that local geometry change; placement of the
        // resulting objects is independent of where the original image was sampled.
        const Transform3d transform = frame * Transform3d(Eigen::Translation3d(part->mesh().get_init_shift()));
        const Matrix3d normal_transform = transform.linear().inverse().transpose();
        for (const auto &face : part->mesh().its.indices) {
            const auto &mesh = part->mesh().its;
            const Vec3f p = (mesh.vertices[face[0]] + mesh.vertices[face[1]] + mesh.vertices[face[2]]) / 3.f;
            const Vec3f n = (mesh.vertices[face[1]]-mesh.vertices[face[0]]).cross(mesh.vertices[face[2]]-mesh.vertices[face[0]]).normalized();
            const Vec3f sp = (transform * p.cast<double>()).cast<float>();
            const Vec3f sn = (normal_transform * n.cast<double>()).normalized().cast<float>();
            CHECK_THAT(actual(p, n), WithinAbs(expected(sp, sn), 2e-4));
        }
    }
}

TEST_CASE("Reframing view projectors preserves local color and height samples", "[CutTextures][ProjectionAnchor]")
{
    const bool projective = GENERATE(false, true);
    ConfigSubstitutionContext substitutions(ForwardCompatibilitySubstitutionRule::EnableSilent);
    const Model fixture = Model::read_from_file(std::string(TEST_DATA_DIR) + "/texture_import/two_color_png.glb",
        nullptr, &substitutions, LoadStrategy::LoadModel | LoadStrategy::AddDefaultInstances);
    auto layer = fixture.objects.front()->volumes.front()->texture_displacement_layers.front();
    layer.projection_method = TextureProjectionMethod::ViewProjected;
    layer.view_project_projective = projective;
    layer.view_project_matrix = {0.03f, 0.02f, 0.01f, 0.5f,
                                -0.01f, 0.015f, 0.025f, 0.4f,
                                0.001f, 0.002f, 0.003f, 1.f};
    layer.tile_enabled = true;
    const auto texture = decode_height_texture(layer);
    Transform3d frame = Transform3d::Identity();
    frame.translate(Vec3d(2., 3., 4.));
    frame.rotate(Eigen::AngleAxisd(0.37, Vec3d::UnitY()));
    frame.scale(Vec3d(1.2, 0.8, 1.1));
    const auto reframed = texture_layers_in_frame({layer}, frame);
    REQUIRE(reframed.size() == 1);
    const Matrix3d normal_frame = frame.linear().inverse().transpose();
    for (const Vec3f &p : {Vec3f(1.f, 2.f, 3.f), Vec3f(-2.f, 1.f, -3.f)}) {
        const Vec3f n = Vec3f(1.f, 2.f, 3.f).normalized();
        const Vec3f fp = (frame * p.cast<double>()).cast<float>();
        const Vec3f fn = (normal_frame * n.cast<double>()).normalized().cast<float>();
        Vec3f expected, actual;
        REQUIRE(sample_layer_color(texture, layer, p, n, expected));
        REQUIRE(sample_layer_color(texture, reframed.front(), fp, fn, actual));
        CHECK_THAT((actual - expected).norm(), WithinAbs(0., 2e-5));
        CHECK_THAT(sample_layer_height(texture, reframed.front(), fp, fn),
                   WithinAbs(sample_layer_height(texture, layer, p, n), 2e-5));
    }
    CHECK_FALSE(layer.projection_anchor);
}
