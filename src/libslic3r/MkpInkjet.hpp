#ifndef slic3r_MkpInkjet_hpp_
#define slic3r_MkpInkjet_hpp_

#include <map>
#include <cstdint>
#include <string>
#include <vector>

#include "libslic3r.h"
#include "Point.hpp"

namespace Slic3r {

class Layer;
class PrintObject;
class Zipper;

namespace mkp {

// One ink pass: the head fires from x0 to x1 while it sweeps along y. Coordinates are the object's
// own scaled ones, which is the space GCode::process_layer already emits in. Blocks closer to each
// other than the post-processor's 20 mm merge gap are already merged, and the block already starts
// 7 mm left of its content so the bar is moving before the strip reaches it.
struct InkBand
{
    coordf_t y  = 0;
    coordf_t x0 = 0;
    coordf_t x1 = 0;
};

// What one layer gets. Empty is the normal answer for every layer the painted texture does not
// reach, and it means "spray nothing here".
struct SurfaceTone {
    Vec2d origin = Vec2d::Zero();
    static constexpr double cell_mm = 0.25;
    int width = 0, height = 0;
    std::vector<uint8_t> darkness;
    double lightness_at(const Vec2d &position) const;
};

struct InkLayer {
    std::vector<InkBand> bands;
    SurfaceTone tone;
    bool empty() const { return bands.empty(); }
};

// Texture slicing, run once per object before any G-code is written: for every layer, cut the
// painted faces with that layer's slab, project the result from above, sample the texture's colour
// on it, and encode one .mbd strip per ink pass into `zip` as "<prefix>layer_XXXX/XXXXX.mbd".
// Returns where the head has to travel; the strips it refers to are already in the archive.
// `wall_band_mm` is the band an ink pass lays along an upright face: such a face projects to a
// line with no area to fill, so its contour is drawn with a band of that total width, centred on
// it, 35% of that width outside the silhouette and 65% inside. 30 px of ink, i.e. 0.627 mm.
// Everything the ink itself is made of. These used to be UI-only: the controls existed, the values
// were saved, and nothing downstream ever read them, so moving a slider changed the print by nothing
// at all. Each one is now consumed here, by the strip that is encoded.
struct InkjetParams
{
    // Ink amount. It is the post-processor's density as a multiplier of the 60% every validated run
    // used, so 1.0 leaves the strips byte-identical to what those runs produced, and anything else
    // walks the colorize towards (less) or away from (more) white.
    double density    = 1.0;
    // The three ink channels, as multipliers on the amount each one carries.
    double c = 1.0, m = 1.0, y = 1.0;
    // Post-processing of the printed colour, the same three knobs the old pipeline had.
    double saturation = 0.0, brightness = 0.0, contrast = 1.0;
    // Head skew compensation: how far the top row of a strip sits to the right of its bottom row.
    double shear_mm   = 0.0;
    // Band an ink pass lays along an upright face (see below).
    double wall_band_mm = 0.62675;
    bool surface_tone = false;
    // Printing-speed modulation also needs the tone map when no inkjet pass is requested.
    bool encode_strips = true;
};

std::map<const Layer *, InkLayer> build_inkjet_layers(const PrintObject &object, Zipper &zip, const std::string &prefix,
                                                       const std::string &preview_dir, const InkjetParams &params);

} // namespace mkp
} // namespace Slic3r

#endif // slic3r_MkpInkjet_hpp_
