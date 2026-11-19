#include "MkpMbd.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace Slic3r {
namespace mkp {
namespace {

constexpr double QMAX = 65535.;
constexpr double EPS  = 1e-12;

// The head's eight inks, in the order the packed stream indexes them.
const int PALETTE[8][3] = { { 0, 173, 239 }, { 237, 0, 140 }, { 254, 242, 0 }, { 46, 49, 146 },
                            { 237, 27, 36 }, { 0, 166, 82 },  { 29, 24, 28 },  { 255, 255, 255 } };

inline int clamp_to_quantum(double v)
{
    if (v <= 0.)
        return 0;
    if (v >= QMAX)
        return int(QMAX);
    return int(v + 0.5);
}

// Lanczos3 the way ImageMagick builds it: the windowed sinc below is its own approximation, and the
// chain is only byte-comparable against the old worker if this polynomial is used rather than
// sin() directly.
double sincfast(double x)
{
    const double PI = 3.14159265358979323846;
    if (x > 4.0) {
        const double a = PI * x;
        return std::sin(a) / a;
    }
    const double xx = x * x;
    // Horner over ImageMagick's minimax polynomial; the coefficients are listed high order first.
    static const double C[10] = { -0.177084805010701112639035485248501049364e-15,
                                  0.253524321426864752676094495396308636823e-13,
                                  -0.187208577776590710853865174371617338991e-11,
                                  0.957694196677572570319816780188718518330e-10,
                                  -0.372895101408779549368465614321137048875e-8,
                                  0.111902032818095784414237782071368805120e-6,
                                  -0.250963301609117217660068889165550534856e-5,
                                  0.394201182359318128221229891724947048771e-4,
                                  -0.384240921114946632192116762889211361285e-3,
                                  0.173611107357320220183368594093166520811e-2 };
    double p = C[0];
    for (int i = 1; i < 10; ++i)
        p = C[i] + xx * p;
    return (xx - 1.0) * (xx - 4.0) * (xx - 9.0) * (xx - 16.0) * p;
}

inline double lanczos3(double x)
{
    const double xb = std::abs(x);
    return sincfast(xb) * sincfast(xb * (1.0 / 3.0));
}

// Horizontal 50% reduction into Q16, with ImageMagick's coefficients. This is the step that decides
// which of the two source columns a strip pixel comes from, so the arithmetic has to stay in double.
std::vector<int> resize_halve(const uint8_t *src, int W, int H, int &W2,
                            const std::function<void()> &throw_if_canceled)
{
    W2 = int(std::floor(W * 0.5 + 0.5));
    if (W2 < 1)
        W2 = 1;
    const double xf      = double(W2) / double(W);
    const double scale   = std::max(1.0 / xf + EPS, 1.0);
    const double support = scale * 3.0;
    const double s       = 1.0 / scale;

    std::vector<int>    idx(size_t(W2) * 16, 0);
    std::vector<double> wt(size_t(W2) * 16, 0.);
    std::vector<int>    cnt(size_t(W2), 0);
    for (int x = 0; x < W2; ++x) {
        const double bisect = (x + 0.5) / xf + EPS;
        const int    start  = int(std::max(std::trunc(bisect - support + 0.5), 0.0));
        const int    stop   = int(std::min(std::trunc(bisect + support + 0.5), double(W)));
        const int    n      = stop - start;
        const size_t base   = size_t(x) * 16;
        double       d      = 0.;
        for (int k = 0; k < n && k < 16; ++k) {
            const double w    = lanczos3(s * ((start + k) - bisect + 0.5));
            idx[base + size_t(k)] = start + k;
            wt[base + size_t(k)]  = w;
            d += w;
        }
        if (d != 0. && d != 1.) {
            d = 1. / d;
            for (int k = 0; k < n && k < 16; ++k)
                wt[base + size_t(k)] *= d;
        }
        cnt[size_t(x)] = n;
    }

    std::vector<int> qsrc(size_t(W) * size_t(H) * 3);
    for (size_t i = 0, n = qsrc.size(); i < n; ++i)
        qsrc[i] = int(src[i]) * 257;

    std::vector<int> out(size_t(H) * size_t(W2) * 3);
    for (int y = 0; y < H; ++y) {
        if (throw_if_canceled) throw_if_canceled();
        const size_t ro = size_t(y) * size_t(W) * 3;
        const size_t oo = size_t(y) * size_t(W2) * 3;
        for (int x = 0; x < W2; ++x) {
            const int    n    = std::min(cnt[size_t(x)], 16);
            const size_t base = size_t(x) * 16;
            double       r = 0., g = 0., b = 0.;
            for (int k = 0; k < n; ++k) {
                const double w = wt[base + size_t(k)];
                const size_t p = ro + size_t(idx[base + size_t(k)]) * 3;
                r += w * double(qsrc[p]);
                g += w * double(qsrc[p + 1]);
                b += w * double(qsrc[p + 2]);
            }
            out[oo + size_t(x) * 3]     = clamp_to_quantum(r);
            out[oo + size_t(x) * 3 + 1] = clamp_to_quantum(g);
            out[oo + size_t(x) * 3 + 2] = clamp_to_quantum(b);
        }
    }
    return out;
}

// ImageMagick's -colorize: pull every channel straight towards white by `blend` percent.
void colorize(std::vector<int> &img, int blend, const std::function<void()> &throw_if_canceled)
{
    const double b = double(blend);
    size_t processed = 0;
    for (int &v : img) {
        if ((processed++ & 65535) == 0 && throw_if_canceled) throw_if_canceled();
        v = clamp_to_quantum((double(v) * (100.0 - b) + QMAX * b) / 100.0);
    }
}

inline int s2c(int q)
{
    const int t = q + 128;
    return (t - (t >> 8)) >> 8;
}

// Floyd-Steinberg against the eight inks. The palette search prunes by growing partial distances,
// and a later colour is allowed to replace an equally distant earlier one - both details decide the
// bytes, so neither is "cleaned up" here.
std::vector<uint8_t> dither(const std::vector<int> &img, int W2, int H,
                           const std::function<void()> &throw_if_canceled)
{
    struct Node
    {
        int child[8];
        int nu     = 0;
        int cn     = -1;
        int parent = -1;
    };
    std::vector<Node> nodes;
    nodes.emplace_back();
    for (int i = 0; i < 8; ++i)
        for (int c = 0; c < 8; ++c)
            nodes.back().child[c] = -1;

    auto new_node = [&nodes]() {
        nodes.emplace_back();
        for (int c = 0; c < 8; ++c)
            nodes.back().child[c] = -1;
        return int(nodes.size()) - 1;
    };

    int CM[8][3];
    int cm_count = 0;
    for (int pi = 0; pi < 8; ++pi) {
        const int rc = s2c(PALETTE[pi][0] * 257), gc = s2c(PALETTE[pi][1] * 257),
                  bc = s2c(PALETTE[pi][2] * 257);
        int n = 0;
        for (int i = 7; i >= 0; --i) {
            const int nid = ((rc >> i) & 1) | (((gc >> i) & 1) << 1) | (((bc >> i) & 1) << 2);
            int       nx  = nodes[size_t(n)].child[nid];
            if (nx < 0) {
                nx                            = new_node();
                nodes[size_t(n)].child[nid]   = nx;
                nodes[size_t(nx)].parent      = n;
            }
            n = nx;
        }
        nodes[size_t(n)].nu = 1;
        nodes[size_t(n)].cn = cm_count;
        CM[cm_count][0]     = PALETTE[pi][0] * 257;
        CM[cm_count][1]     = PALETTE[pi][1] * 257;
        CM[cm_count][2]     = PALETTE[pi][2] * 257;
        ++cm_count;
    }

    // Every palette colour terminates its own path, so cn is already the palette index.
    std::vector<std::vector<int>> sub(nodes.size());
    for (size_t i = 0; i < nodes.size(); ++i) {
        std::vector<int> list;
        std::vector<std::pair<int, int>> work;
        work.emplace_back(int(i), 0);
        while (! work.empty()) {
            auto &top = work.back();
            if (top.second < 8) {
                const int c = nodes[size_t(top.first)].child[top.second++];
                if (c >= 0)
                    work.emplace_back(c, 0);
            } else {
                if (nodes[size_t(top.first)].nu != 0)
                    list.push_back(nodes[size_t(top.first)].cn);
                work.pop_back();
            }
        }
        sub[i] = std::move(list);
    }

    std::vector<int>     cache(262144, 0);
    std::vector<double>  row0(size_t(W2) * 3), row1(size_t(W2) * 3);
    std::vector<uint8_t> cls(size_t(W2) * size_t(H));

    const double DF = 4.0 * (QMAX + 1.) * (QMAX + 1.) + 1.0;
    for (int y = 0; y < H; ++y) {
        if (throw_if_canceled) throw_if_canceled();
        const bool   odd   = (y & 1) != 0;
        double      *curA  = odd ? row1.data() : row0.data();
        double      *prevA = odd ? row0.data() : row1.data();
        const size_t ro    = size_t(y) * size_t(W2) * 3;
        for (int xi = 0; xi < W2; ++xi) {
            const int u = odd ? (W2 - 1 - xi) : xi;
            const int v = odd ? -1 : 1;
            const size_t p = ro + size_t(u) * 3;
            double r = double(img[p]), g = double(img[p + 1]), b = double(img[p + 2]);
            if (xi > 0) {
                const size_t k = size_t(u - v) * 3;
                r += 7.0 * curA[k] / 16;
                g += 7.0 * curA[k + 1] / 16;
                b += 7.0 * curA[k + 2] / 16;
            }
            if (y > 0) {
                if (xi < W2 - 1) {
                    const size_t k = size_t(u + v) * 3;
                    r += prevA[k] / 16;
                    g += prevA[k + 1] / 16;
                    b += prevA[k + 2] / 16;
                }
                size_t k = size_t(u) * 3;
                r += 5.0 * prevA[k] / 16;
                g += 5.0 * prevA[k + 1] / 16;
                b += 5.0 * prevA[k + 2] / 16;
                if (xi > 0) {
                    k = size_t(u - v) * 3;
                    r += 3.0 * prevA[k] / 16;
                    g += 3.0 * prevA[k + 1] / 16;
                    b += 3.0 * prevA[k + 2] / 16;
                }
            }
            r = r <= 0. ? 0. : (r >= QMAX ? QMAX : double(int(r + 0.5)));
            g = g <= 0. ? 0. : (g >= QMAX ? QMAX : double(int(g + 0.5)));
            b = b <= 0. ? 0. : (b >= QMAX ? QMAX : double(int(b + 0.5)));

            const int ri = int(r), gi = int(g), bi = int(b);
            const int cr = s2c(ri), cg = s2c(gi), cb = s2c(bi);
            const int key = ((cr >> 2) << 12) | ((cg >> 2) << 6) | (cb >> 2);
            int       ci1 = cache[size_t(key)];
            if (ci1 == 0) {
                int n = 0;
                for (int i = 7; i > 0; --i) {
                    const int nid = ((cr >> i) & 1) | (((cg >> i) & 1) << 1) | (((cb >> i) & 1) << 2);
                    const int nx  = nodes[size_t(n)].child[nid];
                    if (nx < 0)
                        break;
                    n = nx;
                }
                const int start = nodes[size_t(n)].parent < 0 ? 0 : nodes[size_t(n)].parent;
                double    best  = DF;
                int       besti = -1;
                for (int cn : sub[size_t(start)]) {
                    double d = double(CM[cn][0]) - r;
                    d *= d;
                    if (d <= best) {
                        double dg = double(CM[cn][1]) - g;
                        d += dg * dg;
                        if (d <= best) {
                            double db = double(CM[cn][2]) - b;
                            d += db * db;
                            if (d <= best) {
                                best  = d;
                                besti = cn;
                            }
                        }
                    }
                }
                ci1 = besti + 1;
                cache[size_t(key)] = ci1;
            }
            const int cn = ci1 - 1;
            cls[ro / 3 + size_t(u)] = uint8_t(cn);
            const size_t k2 = size_t(u) * 3;
            curA[k2]        = r - double(CM[cn][0]);
            curA[k2 + 1]    = g - double(CM[cn][1]);
            curA[k2 + 2]    = b - double(CM[cn][2]);
        }
    }
    return cls;
}

// The head reads 5-bit groups interleaved across four quadrants and three channels; this lays the
// class map out that way. Table layout follow mbd_pack_exact.js exactly.
const int T_ELSE[3][4] = { { 20, 22, 0, 2 }, { 58, 56, 78, 76 }, { 114, 112, 134, 132 } };
const int TB[3][9]     = { { 7, 5, 3, 1, 8, 6, 4, 2, 0 },
                           { 2, 0, 7, 5, 3, 1, 8, 6, 4 },
                           { 3, 1, 8, 6, 4, 2, 0, 7, 5 } };
const int SEL[4][3]    = { { 0, 1, 1 }, { 0, 2, 2 }, { 2, 0, 0 }, { 1, 0, 0 } };
const int GROUPS[4][5] = { { 0, 2, 4, 6, 8 }, { 1, 3, 5, 7, 9 }, { 10, 12, 14, 16, 18 }, { 11, 13, 15, 17, 19 } };
const int HALF0[12][4] = { { 2, 0, 0, 0 }, { 2, 3, 0, 3 }, { 2, 0, 1, 0 }, { 2, 3, 1, 3 },
                           { 1, 3, 0, 3 }, { 1, 0, 0, 0 }, { 1, 3, 1, 3 }, { 1, 0, 1, 0 },
                           { 0, 3, 0, 3 }, { 0, 0, 0, 0 }, { 0, 3, 1, 3 }, { 0, 0, 1, 0 } };
const int HALF1[12][4] = { { 2, 1, 0, 1 }, { 2, 2, 0, 2 }, { 2, 1, 1, 1 }, { 2, 2, 1, 2 },
                           { 1, 2, 0, 2 }, { 1, 1, 0, 1 }, { 1, 2, 1, 2 }, { 1, 1, 1, 1 },
                           { 0, 2, 0, 2 }, { 0, 1, 0, 1 }, { 0, 2, 1, 2 }, { 0, 1, 1, 1 } };

std::vector<uint8_t> pack_classes(const std::vector<uint8_t> &cls, int N, int H, int dpi, int pad, int invert,
                                  const std::function<void()> &throw_if_canceled)
{
    const size_t pbits_size = size_t(3) * 4 * size_t(N) * 180;
    std::vector<uint8_t> pbits(pbits_size, 0);
    for (int y = 0; y < H; ++y) {
        if (throw_if_canceled) throw_if_canceled();
        const int    ph   = y & 3;
        const size_t slot = size_t(4 + (y >> 2));
        const size_t cy   = size_t(H - 1 - y) * size_t(N);
        for (int x = 0; x < N; ++x) {
            const uint8_t c   = cls[cy + size_t(x)];
            const int    *pal = PALETTE[c & 7];
            // Channel 0, 1, 2 live in three consecutive blocks of 4*N*180 bytes; inside a block the
            // phase is the outer index and x the inner one.
            for (int ch = 0; ch < 3; ++ch) {
                const size_t pb = (size_t(ch * 4 + ph) * size_t(N) + size_t(x)) * 180 + slot;
                pbits[pb]       = pal[ch] < 128 ? 1 : 0;
            }
        }
    }

    std::vector<uint8_t> arr(size_t(3) * 4 * size_t(N) * 36, 0);
    for (int c = 0; c < 4; ++c)
        for (int ch = 0; ch < 3; ++ch) {
            const int   sel  = SEL[c][ch];
            const int  *offs = TB[sel];
            const size_t pbase = (size_t(ch) * 4 + size_t(c)) * size_t(N) * 180;
            const size_t abase = (size_t(ch) * 4 + size_t(c)) * size_t(N) * 36;
            for (int x = 0; x < N; ++x) {
                if ((x & 255) == 0 && throw_if_canceled) throw_if_canceled();
                const size_t po = pbase + size_t(x) * 180;
                const size_t ao = abase + size_t(x) * 36;
                for (int si = 0; si < 36; ++si) {
                    // Slots are generated q-major then k, and written at k*4+q.
                    const int q        = si / 9;
                    const int k        = si % 9;
                    const int slot_out = k * 4 + q;
                    int       v        = 0;
                    for (int j = 0; j < 5; ++j)
                        v |= pbits[po + size_t(9 * GROUPS[q][j]) + size_t(offs[k])] << j;
                    arr[ao + size_t(slot_out)] = uint8_t(v);
                }
            }
        }

    const int             L     = N + pad / dpi;
    const size_t          total = 16 + size_t(L) * 272;
    std::vector<uint8_t>  out(total, 0);

    // (ch, ph, shift) -> the [column, byte] pairs that go on that line.
    struct Group
    {
        int                              ch, sh;
        std::vector<std::pair<int, int>> spec;
    };
    std::vector<Group> groups;
    auto find_group = [&groups](int ch, int ph, int sh) -> Group & {
        for (Group &g : groups)
            if (g.ch == ch * 4 + ph && g.sh == sh)
                return g;
        groups.push_back(Group{ ch * 4 + ph, sh, {} });
        return groups.back();
    };
    for (int B = 0; B < 18; ++B)
        for (int e = 0; e < 12; ++e) {
            const int *h0 = HALF0[e];
            const int *h1 = HALF1[e];
            find_group(h0[0], h0[1], T_ELSE[h0[0]][h0[3]] / dpi).spec.emplace_back(12 * B + e, 2 * B + h0[2]);
            find_group(h1[0], h1[1], T_ELSE[h1[0]][h1[3]] / dpi).spec.emplace_back(216 + 12 * B + e, 2 * B + h1[2]);
        }

    std::vector<uint8_t> G(size_t(L) * 432, 0);
    for (const Group &g : groups) {
        if (throw_if_canceled) throw_if_canceled();
        const size_t abase = size_t(g.ch) * size_t(N) * 36;
        for (int r = 0; r < N; ++r) {
            const int line = r + g.sh;
            if (line >= L)
                continue;
            const size_t ao = abase + size_t(r) * 36;
            const size_t go = size_t(line) * 432;
            for (const auto &sp : g.spec)
                G[go + size_t(sp.first)] = arr[ao + size_t(sp.second)];
        }
    }

    ::memcpy(out.data(), "MBrush", 6);
    out[8] = uint8_t(invert);
    out[9] = uint8_t(dpi);
    size_t o = 16;
    for (int line = 0; line < L; ++line) {
        if ((line & 255) == 0 && throw_if_canceled) throw_if_canceled();
        out[o]     = 0;
        out[o + 1] = 0x87;
        o += 2;
        const size_t go = size_t(line) * 432;
        for (int grp = 0; grp < 54; ++grp) {
            const size_t b  = go + size_t(grp) * 8;
            const int    g0 = G[b], g1 = G[b + 1], g2 = G[b + 2], g3 = G[b + 3];
            const int    g4 = G[b + 4], g5 = G[b + 5], g6 = G[b + 6], g7 = G[b + 7];
            out[o++] = uint8_t((g0 | (g1 << 5)) & 0xFF);
            out[o++] = uint8_t(((g2 << 2) | (g1 >> 3) | (g3 << 7)) & 0xFF);
            out[o++] = uint8_t(((g4 << 4) | (g3 >> 1)) & 0xFF);
            out[o++] = uint8_t(((g5 << 1) | (g4 >> 4) | (g6 << 6)) & 0xFF);
            out[o++] = uint8_t(((g7 << 3) | (g6 >> 2)) & 0xFF);
        }
    }
    return out;
}

} // namespace

bool encode_mbd_strip(const uint8_t *rgb, int width, int rows, int blend, std::vector<uint8_t> &out,
                      const std::function<void()> &throw_if_canceled)
{
    if (rgb == nullptr || width < 1 || rows != MBD_STRIP_ROWS)
        return false;
    int              W2 = 0;
    if (throw_if_canceled) throw_if_canceled();
    std::vector<int> q  = resize_halve(rgb, width, rows, W2, throw_if_canceled);
    colorize(q, blend, throw_if_canceled);
    std::vector<uint8_t> cls = dither(q, W2, rows, throw_if_canceled);
    out                      = pack_classes(cls, W2, rows, 2, 134, 0, throw_if_canceled);
    return true;
}

} // namespace mkp
} // namespace Slic3r
