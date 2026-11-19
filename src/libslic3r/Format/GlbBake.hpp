#pragma once
#include <cstddef>
#include <string>
#include <vector>

struct aiMesh;
namespace Slic3r {
struct TexturedMesh;
bool reduce_glb_native(const std::vector<const aiMesh *> &meshes, const std::vector<size_t> &budgets,
                       TexturedMesh &out, std::string &error);
}
