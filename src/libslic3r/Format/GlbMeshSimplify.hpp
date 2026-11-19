#pragma once

#include <algorithm>
#include <cstddef>
#include <vector>

namespace Slic3r {

// One budget for the whole GLB, including all material meshes and node instances.
constexpr size_t glb_triangle_limit = 10000;

inline std::vector<size_t> glb_mesh_budgets(const std::vector<size_t>& counts, size_t triangle_limit = glb_triangle_limit)
{
    size_t remaining_faces = 0;
    size_t active_meshes = 0;
    for (size_t count : counts) {
        remaining_faces += count;
        active_meshes += count != 0;
    }
    if (remaining_faces <= triangle_limit)
        return counts;
    if (active_meshes > triangle_limit)
        return {}; // Cannot retain even one triangle from every material mesh.

    std::vector<size_t> budgets(counts.size(), 0);
    size_t remaining_budget = triangle_limit;
    for (size_t i = 0; i < counts.size(); ++i) {
        if (counts[i] == 0)
            continue;
        --active_meshes;
        const size_t proportional = size_t(double(remaining_budget) * double(counts[i]) / double(remaining_faces));
        budgets[i] = std::min(counts[i], std::max(size_t(1),
            std::min(proportional, remaining_budget - active_meshes)));
        remaining_budget -= budgets[i];
        remaining_faces -= counts[i];
    }
    return budgets;
}

} // namespace Slic3r
