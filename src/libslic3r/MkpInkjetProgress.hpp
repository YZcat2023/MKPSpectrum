#pragma once

#include <functional>
#include "MkpInkjet.hpp"

namespace Slic3r { namespace mkp {
std::map<const Layer *, InkLayer> build_inkjet_layers(const PrintObject &object, Zipper &zip, const std::string &prefix,
    const std::string &preview_dir, const InkjetParams &params,
    const std::function<void(double, const std::string &)> &progress);
}}
