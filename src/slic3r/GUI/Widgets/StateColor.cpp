#include "StateColor.hpp"
#include <algorithm>
#include <cmath>
#include <wx/colour.h>
#include <map>
#include <tuple>
#include <wx/string.h>

static bool gDarkMode = false;

static bool operator<(wxColour const &l, wxColour const &r) { return l.GetRGBA() < r.GetRGBA(); }

// MKP: the dark theme is deliberately violet-grey (#1a1a2e / #1e1e2e / #2a2a3a, the palette of
// the MKP design) instead of the neutral grey one, so the panels, cards and the tab bar all sit in
// one family. The ORCA accent stays teal and keeps its role; only its neighbours in the layout
// changed hue.
static std::map<wxColour, wxColour> gDarkColors{
    {"#009688", "#0E7C6E"}, // rgb(0, 150, 136)    ORCA color
    {"#1F8EEA", "#4A9EFF"}, // rgb(31, 142, 234)   accent blue of the MKP design
    {"#FF6F00", "#D9772B"}, // rgb(255, 111, 0)    Secondary color
    {"#D01B1B", "#C0394B"}, // rgb(208, 27, 27)    error red
    {"#262E30", "#E5E5EA"}, // rgb(38, 46, 48)     Button text color | Input Text Color
    {"#DFDFDF", "#27272B"}, // rgb(223, 223, 223)  Button Background color
    {"#D4D4D4", "#313136"}, // rgb(212, 212, 212)  Button Background color on Hover
    {"#6B6A6A", "#8E9099"}, // rgb(107, 107, 106)  Button Dimmed text
    {"#26A69A", "#13A08F"}, // rgb(0, 150, 136)    Button Confirm Color hover | ORCA Color Hover
    {"#6B6B6A", "#B0B1BC"}, // rgb(107, 107, 106)  Input box side text
    {"#2C2C2E", "#B0B1BC"}, // rgb(44, 44, 46)     secondary text
    {"#6B6B6B", "#7C7E8A"}, // rgb(107, 107, 107)  Disabled Text
    {"#ACACAC", "#5F616A"}, // rgb(172, 172, 172)  Disabled Text on boxes | Dimmed Elements
    {"#EEEEEE", "#313136"}, // rgb(238, 238, 238)  Separator Line | Title Line Color
    {"#E8E8E8", "#27272B"}, // rgb(232, 232, 232)  card background
    {"#323A3D", "#DADAE2"}, // rgb(50, 58, 61)     Softer text color
    {"#FFFFFF", "#1E1E22"}, // rgb(255, 255, 255)  Window background
    {"#F8F8F8", "#202024"}, // rgb(248, 248, 248)  Sidebar > Titlebar > Gradient Top
    {"#F1F1F1", "#202024"}, // rgb(241, 241, 241)  Sidebar > Titlebar > Gradient Bottom
    {"#3B4446", "#141416"}, // rgb(59, 68, 78)     Top Bar / Main tab bar bg color
    {"#CECECE", "#232327"}, // rgb(206, 206, 206)  Sidebar wxPanel bg |
    {"#DBFDD5", "#232327"}, // rgb(219, 253, 213)  Unused combo box background
    {"#000000", "#FFFFFF"}, // rgb(0, 0, 0)        Mostly Text color wxBlack
    {"#F4F4F4", "#202024"}, // rgb(244, 244, 244)  panel background
    {"#DBDBDB", "#313136"}, // rgb(219, 219, 219)  Input/Combo Box Border Color
    {"#EDFAF2", "#232327"}, // rgb(229, 240, 238)  Unused combo focused background
    {"#323A3C", "#DADAE2"}, // rgb(50, 58, 60)     Text color used on search list |
    {"#303A3C", "#DADAE2"}, // rgb(48, 58, 60)     Object Table column header | StaticBox Border
    {"#FEFFFF", "#141416"}, // rgb(254, 255, 255)  Side Tabbar bg |
    {"#A6A9AA", "#222224"}, // rgb(166, 169, 170)  Seperator color
    {"#363636", "#B0B1BC"}, // rgb(54, 54, 54)     Sidebar > Parameter Label/Title color
    {"#F0F0F1", "#232327"}, // rgb(240, 240, 241)  Disabled element background
    {"#9E9E9E", "#4A4A50"}, // rgb(158, 158, 158)  muted element
    {"#D7E8DE", "#1E2028"}, // rgb(215, 232, 222)  Unused leftover from BBS
    {"#2B3436", "#7E808A"}, // rgb(43, 52, 54)     Unused leftover from BBS (icon fill)
    {"#ABABAB", "#ABABAB"},
    {"#D9D9D9", "#222224"}, // rgb(217, 217, 217)  Sidebar > Toggle button track color
    {"#FFFEFE", "#C9CAD2"}, // rgb(255, 254, 254)  Sidebar > Toggle button thumb color
    {"#EBF9F0", "#242E33"},
    // ORCA
    {"#BFE1DE", "#26303A"}, // rgb(191, 225, 222)  Dropdown checked item background color
    {"#E5F0EE", "#243036"}, // rgb(229, 240, 238)  Combo / Dropdown focused background color
};

std::tuple<double, double, double> StateColor::GetLAB(const wxColour& color) {
    // Convert color to RGB color space
    double r = color.Red() / 255.0;
    double g = color.Green() / 255.0;
    double b = color.Blue() / 255.0;

    // Convert to XYZ color space
    double x = 0.412453*r + 0.357580*g + 0.180423*b;
    double y = 0.212671*r + 0.715160*g + 0.072169*b;
    double z = 0.019334*r + 0.119193*g + 0.950227*b;

    // Normalize XYZ values
    double x_n = x / 0.950456;
    double y_n = y / 1.0;
    double z_n = z / 1.088754;

    // Convert to LAB color space
    double epsilon = 0.008856;
    double kappa = 903.3;
    double fx = (x_n > epsilon) ? cbrt(x_n) : (kappa*x_n + 16.0) / 116.0;
    double fy = (y_n > epsilon) ? cbrt(y_n) : (kappa*y_n + 16.0) / 116.0;
    double fz = (z_n > epsilon) ? cbrt(z_n) : (kappa*z_n + 16.0) / 116.0;

    double l = 116.0 * fy - 16.0;
    double a = 500.0 * (fx - fy);
    double b_lab = 200.0 * (fy - fz);

    return std::tuple<double, double, double>(l, a, b_lab);
}

double StateColor::LAB_Delta_E(const wxColour& color1, const wxColour& color2) {
    auto [l1, a1, b1] = GetLAB(color1);
    auto [l2, a2, b2] = GetLAB(color2);
    return sqrt((l1 - l2) * (l1 - l2) + (a1 - a2) * (a1 - a2) + (b1 - b2) * (b1 - b2));
}

double StateColor::GetColorDifference(const wxColour& color1, const wxColour& color2) {
    return LAB_Delta_E(color1, color2);
}

double StateColor::GetLightness(const wxColour& color) {
    auto [l, a, b_lab] = GetLAB(color);
    return l;
}

// Function to lighten or darken a wxColour using LAB color space
wxColour StateColor::SetLightness(const wxColour& color, double lightness) {
    auto [l, a, b_lab] = GetLAB(color);

    // Clamp lightness value
    l = std::max(0.0, std::min(100.0, lightness));

    // Convert back to XYZ color space
    double fy_3 = (l + 16.0) / 116.0;
    double fx_3 = a / 500.0 + fy_3;
    double fz_3 = fy_3 - b_lab / 200.0;

    double epsilon = 0.008856;
    double kappa = 903.3;
    double x_3 = (fx_3 > epsilon) ? fx_3 * fx_3 * fx_3 : (116.0 * fx_3 - 16.0) / kappa;
    double y_3 = (l > kappa*epsilon) ? fy_3 * fy_3 * fy_3 : l / kappa;
    double z_3 = (fz_3 > epsilon) ? fz_3 * fz_3 * fz_3 : (116.0 * fz_3 - 16.0) / kappa;

    // Denormalize XYZ values
    double x = x_3 * 0.950456;
    double y = y_3 * 1.0;
    double z = z_3 * 1.088754;

    // Convert XYZ to RGB
    double r_new = 3.240479*x - 1.537150*y - 0.498535*z;
    double g_new = -0.969256*x + 1.875992*y + 0.041556*z;
    double b_new = 0.055648*x - 0.204043*y + 1.057311*z;

    // Clamp RGB values
    r_new = std::max(0.0, std::min(1.0, r_new));
    g_new = std::max(0.0, std::min(1.0, g_new));
    b_new = std::max(0.0, std::min(1.0, b_new));

    // Convert back to wxColour
    int r_int = static_cast<int>(r_new * 255);
    int g_int = static_cast<int>(g_new * 255);
    int b_int = static_cast<int>(b_new * 255);

    return wxColour(r_int, g_int, b_int);
}

wxColour StateColor::LightenDarkenColor(const wxColour& color, int amount) {
    auto [l, a, b_lab] = GetLAB(color);

    // Modify lightness
    l += amount;

    // Clamp lightness value
    l = std::max(0.0, std::min(100.0, l));

    // Convert back to XYZ color space
    double fy_3 = (l + 16.0) / 116.0;
    double fx_3 = a / 500.0 + fy_3;
    double fz_3 = fy_3 - b_lab / 200.0;

    double epsilon = 0.008856;
    double kappa = 903.3;
    double x_3 = (fx_3 > epsilon) ? fx_3 * fx_3 * fx_3 : (116.0 * fx_3 - 16.0) / kappa;
    double y_3 = (l > kappa*epsilon) ? fy_3 * fy_3 * fy_3 : l / kappa;
    double z_3 = (fz_3 > epsilon) ? fz_3 * fz_3 * fz_3 : (116.0 * fz_3 - 16.0) / kappa;

    // Denormalize XYZ values
    double x = x_3 * 0.950456;
    double y = y_3 * 1.0;
    double z = z_3 * 1.088754;

    // Convert XYZ to RGB
    double r_new = 3.240479*x - 1.537150*y - 0.498535*z;
    double g_new = -0.969256*x + 1.875992*y + 0.041556*z;
    double b_new = 0.055648*x - 0.204043*y + 1.057311*z;

    // Clamp RGB values
    r_new = std::max(0.0, std::min(1.0, r_new));
    g_new = std::max(0.0, std::min(1.0, g_new));
    b_new = std::max(0.0, std::min(1.0, b_new));

    // Convert back to wxColour
    int r_int = static_cast<int>(r_new * 255);
    int g_int = static_cast<int>(g_new * 255);
    int b_int = static_cast<int>(b_new * 255);

    return wxColour(r_int, g_int, b_int);
}

std::map<wxColour, wxColour> const & StateColor::GetDarkMap()
{
    return gDarkColors;
}

void StateColor::SetDarkMode(bool dark) { gDarkMode = dark; }

inline wxColour darkModeColorFor2(wxColour const &color)
{
    if (!gDarkMode)
        return color;
    auto iter = gDarkColors.find(color);
    if (iter != gDarkColors.end()) return iter->second;
    return color;
}

std::map<wxColour, wxColour> revert(std::map<wxColour, wxColour> const & map)
{
    std::map<wxColour, wxColour> map2;
    for (auto &p : map) map2.emplace(p.second, p.first);
    return map2;
}

wxColour StateColor::lightModeColorFor(wxColour const &color)
{
    static std::map<wxColour, wxColour> gLightColors = revert(gDarkColors);
    auto iter = gLightColors.find(color);
    if (iter != gLightColors.end()) return iter->second;
    return color;
}

wxColour StateColor::darkModeColorFor(wxColour const &color) { return darkModeColorFor2(color); }

StateColor::StateColor(wxColour const &color) { append(color, 0); }

StateColor::StateColor(wxString const &color) { append(color, 0); }

StateColor::StateColor(unsigned long color) { append(color, 0); }

void StateColor::append(wxColour const & color, int states)
{
    statesList_.push_back(states);
    colors_.push_back(color);
}

void StateColor::append(wxString const & color, int states)
{
    wxColour c1(color);
    append(c1, states);
}

void StateColor::append(unsigned long color, int states)
{
    if ((color & 0xff000000) == 0)
        color |= 0xff000000;
    wxColour cl; cl.SetRGBA((color & 0xff00ff00) | ((color & 0xff) << 16) | ((color >> 16) & 0xff));
    append(cl, states);
}

void StateColor::clear()
{
    statesList_.clear();
    colors_.clear();
}

int StateColor::states() const
{
    int states = 0;
    for (auto s : statesList_) states |= s;
    states = (states & 0xffff) | (states >> 16);
    if (takeFocusedAsHovered_ && (states & Hovered))
        states |= Focused;
    return states;
}

wxColour StateColor::defaultColor() {
    return colorForStates(0);
}

wxColour StateColor::colorForStates(int states)
{
    bool focused = takeFocusedAsHovered_ && (states & Focused);
    for (int i = 0; i < statesList_.size(); ++i) {
        int s = statesList_[i];
        int on = s & 0xffff;
        int off = s >> 16;
        if ((on & states) == on && (off & ~states) == off) {
            return darkModeColorFor2(colors_[i]);
        }
        if (focused && (on & Hovered)) {
            on |= Focused;
            on &= ~Hovered;
            if ((on & states) == on && (off & ~states) == off) {
                return darkModeColorFor2(colors_[i]);
            }
        }
    }
    return wxColour(0, 0, 0, 0);
}

wxColour StateColor::colorForStatesNoDark(int states)
{
    bool focused = takeFocusedAsHovered_ && (states & Focused);
    for (int i = 0; i < statesList_.size(); ++i) {
        int s = statesList_[i];
        int on = s & 0xffff;
        int off = s >> 16;
        if ((on & states) == on && (off & ~states) == off) {
            return colors_[i];
        }
        if (focused && (on & Hovered)) {
            on |= Focused;
            on &= ~Hovered;
            if ((on & states) == on && (off & ~states) == off) {
                return colors_[i];
            }
        }
    }
    return wxColour(0, 0, 0, 0);
}

int StateColor::colorIndexForStates(int states)
{
    for (int i = 0; i < statesList_.size(); ++i) {
        int s   = statesList_[i];
        int on  = s & 0xffff;
        int off = s >> 16;
        if ((on & states) == on && (off & ~states) == off) { return i; }
    }
    return -1;
}

bool StateColor::setColorForStates(wxColour const &color, int states)
{
    for (int i = 0; i < statesList_.size(); ++i) {
        if (statesList_[i] == states) {
            colors_[i] = color;
            return true;
        }
    }
    return false;
}

void StateColor::setTakeFocusedAsHovered(bool set) { takeFocusedAsHovered_ = set; }
