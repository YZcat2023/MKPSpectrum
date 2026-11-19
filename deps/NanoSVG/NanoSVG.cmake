# In PrusaSlicer 2.6.0 we switched from https://github.com/memononen/nanosvg to its fork https://github.com/fltk/nanosvg
# because this last implements the new function nsvgRasterizeXY() which we now use in GLTexture::load_from_svg()
# for rasterizing svg files from their original size to a squared power of two texture on Windows systems using
# AMD Radeon graphics cards

orcaslicer_add_cmake_project(NanoSVG
    DEPENDS dep_Boost
    URL https://github.com/SoftFever/nanosvg/archive/863f6aa97ef62028126fa2c19bd4350394c2e15e.zip
        # Upstream repo renamed SoftFever/nanosvg -> Orca-deps-nanosvg; GitHub regenerated the archive, so the hash below is the current one for the same commit.
    URL_HASH SHA256=1e3f94a052dd2abb139993ed3496c90ed4458d6f907027bf03cbaed889fe2567
)
