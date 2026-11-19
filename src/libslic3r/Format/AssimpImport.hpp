#pragma once

#include <string>
#include <cstddef>
#include <functional>

namespace Slic3r {

struct TexturedMesh;

bool load_assimp_textured_model(const std::string& path, TexturedMesh& out, std::string* error_message = nullptr,
    const std::function<size_t(size_t)>& choose_triangle_count = {});

} // namespace Slic3r
