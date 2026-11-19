#ifndef slic3r_MkpMbd_hpp_
#define slic3r_MkpMbd_hpp_

#include <cstdint>
#include <functional>
#include <vector>

namespace Slic3r {
namespace mkp {

// One head strip is 14.29 mm wide and the head addresses 684 rows across that width, so a strip
// pixel is 14.29/684 mm in both directions - the strip grid is the only grid .mbd knows about.
constexpr int MBD_STRIP_ROWS = 684;

// sRGB8 -> .mbd, the byte-for-byte equivalent of the chain the post-processor ran through a resident
// Node worker (mbd_exact.js + mbd_pack_exact.js): Lanczos3 horizontal halving, a 40% white colorize,
// Floyd-Steinberg into the head's fixed 8-colour palette, then the 5-bit interleave the head reads.
// `blend` is the post-processor's (100 - density), i.e. 40 for the default density of 60.
// `rows` must be MBD_STRIP_ROWS. Returns false when the image cannot be encoded.
bool encode_mbd_strip(const uint8_t *rgb, int width, int rows, int blend, std::vector<uint8_t> &out,
                      const std::function<void()> &throw_if_canceled = {});

} // namespace mkp
} // namespace Slic3r

#endif // slic3r_MkpMbd_hpp_
