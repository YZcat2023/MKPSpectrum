#include "Notebook.hpp"

//#ifdef _WIN32

#include "GUI_App.hpp"
#include "wxExtensions.hpp"
#include "Widgets/Button.hpp"

//BBS set font size

#include <wx/bookctrl.h>
#include <cmath>
#include <cstddef>
#include <utility>
#include <string>
#include <algorithm>
#include <wx/button.h>
#include <wx/colour.h>
#include <wx/dcclient.h>
#include <wx/event.h>
#include <wx/gdicmn.h>
#include <wx/sizer.h>
#include <wx/window.h>

wxDEFINE_EVENT(wxCUSTOMEVT_NOTEBOOK_SEL_CHANGED, wxCommandEvent);

// MKP: how round a tab is. The selected tab is a filled pill in the design, which a square
// corner cannot reproduce.
#define TAB_CORNER_RADIUS 4

ButtonsListCtrl::ButtonsListCtrl(wxWindow *parent, wxBoxSizer* side_tools) :
    wxControl(parent, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxBORDER_NONE | wxTAB_TRAVERSAL)
{
#ifdef __WINDOWS__
    SetDoubleBuffered(true);
#endif //__WINDOWS__

    wxColour default_btn_bg;
#ifdef __APPLE__
    default_btn_bg = wxColour("#3B4446"); // Gradient #414B4E
#else
    default_btn_bg = wxColour("#141416"); // MKP: the darkest violet-grey, as the MKP nav bar
#endif

   
    SetBackgroundColour(default_btn_bg);

    int em = em_unit(this);// Slic3r::GUI::wxGetApp().em_unit();
    // MKP: a gap, so the tabs read as separate rounded pills instead of one continuous strip.
    m_btn_margin = std::lround(0.45 * em);
    m_line_margin = std::lround(0.1 * em);

    m_sizer = new wxBoxSizer(wxHORIZONTAL);
    this->SetSizer(m_sizer);

    m_buttons_sizer = new wxFlexGridSizer(1, m_btn_margin, m_btn_margin);
    m_sizer->Add(m_buttons_sizer, 0, wxALIGN_CENTER_VERTICAL | wxLEFT | wxTOP | wxBOTTOM | wxRIGHT, m_btn_margin);

    if (side_tools != NULL) {
        m_sizer->AddStretchSpacer(1);
        for (size_t idx = 0; idx < side_tools->GetItemCount(); idx++) {
            wxSizerItem* item = side_tools->GetItem(idx);
            wxWindow* item_win = item->GetWindow();
            if (item_win) {
                item_win->Reparent(this);
            }
        }
        m_sizer->Add(side_tools, 0, wxALIGN_CENTER_VERTICAL | wxRIGHT | wxBOTTOM, m_btn_margin);
    }

    // BBS: disable custom paint
    //this->Bind(wxEVT_PAINT, &ButtonsListCtrl::OnPaint, this);
    Bind(wxEVT_SYS_COLOUR_CHANGED, [](auto& e){
    });
}

void ButtonsListCtrl::OnPaint(wxPaintEvent&)
{
    //Slic3r::GUI::wxGetApp().UpdateDarkUI(this);
    const wxSize sz = GetSize();
    wxPaintDC dc(this);

    if (m_selection < 0 || m_selection >= (int)m_pageButtons.size())
        return;

    wxColour selected_btn_bg("#1F8EEA");
    wxColour default_btn_bg("#3B4446"); // Gradient #414B4E
    const wxColour& btn_marker_color = Slic3r::GUI::wxGetApp().get_color_hovered_btn_label();

    // highlight selected notebook button

    for (int idx = 0; idx < int(m_pageButtons.size()); idx++) {
        Button* btn = m_pageButtons[idx];

        btn->SetBackgroundColor(idx == m_selection ? selected_btn_bg : default_btn_bg);

        wxPoint pos = btn->GetPosition();
        wxSize size = btn->GetSize();
        const wxColour& clr = idx == m_selection ? btn_marker_color : default_btn_bg;
        dc.SetPen(clr);
        dc.SetBrush(clr);
        dc.DrawRectangle(pos.x, pos.y + size.y, size.x, sz.y - size.y);
    }
    // Draw orange bottom line

    dc.SetPen(btn_marker_color);
    dc.SetBrush(btn_marker_color);
    dc.DrawRectangle(1, sz.y - m_line_margin, sz.x, m_line_margin);
}

void ButtonsListCtrl::UpdateMode()
{
    //m_mode_sizer->SetMode(Slic3r::GUI::wxGetApp().get_mode());
}

void ButtonsListCtrl::Rescale()
{
    //m_mode_sizer->msw_rescale();
    int em = em_unit(this);
    for (Button* btn : m_pageButtons) {
        // MKP: keep the compact, caption-hugging size after a DPI/font change as well. The old
        // 132x36 minimum made every tab turn into a wide slab again on the first rescale.
        const wxString label = btn->GetLabel();
        int text_w = 0;
        if (!label.empty()) {
            wxClientDC dc(btn);
            dc.SetFont(btn->GetFont());
            dc.GetTextExtent(label, &text_w, nullptr);
        }
        const int w = label.empty() ? std::lround(4.0 * em) : text_w + std::lround(2.7 * em);
        btn->SetMinSize({w, std::lround(3.6 * em)});
        btn->Rescale();
    }

    // BBS: no gap
    //m_btn_margin = std::lround(0.3 * em);
    //m_line_margin = std::lround(0.1 * em);
    //m_buttons_sizer->SetVGap(m_btn_margin);
    //m_buttons_sizer->SetHGap(m_btn_margin);

    m_sizer->Layout();
}

void ButtonsListCtrl::SetSelection(int sel)
{
    // Repaint every tab from scratch. Restoring only the previously tracked tab was not enough:
    // a tab can also be painted as selected from another path (a page switch during startup, a
    // freshly inserted page), and the stale card then stayed highlighted next to the real one.
    m_selection = (sel >= 0 && sel < static_cast<int>(m_pageButtons.size())) ? sel : -1;

    for (int idx = 0; idx < static_cast<int>(m_pageButtons.size()); ++idx) {
        Button *btn = m_pageButtons[idx];
        if (idx == m_selection) {
            // Selected: the blue-tinted card of the MKP design, which stays put while hovered so
            // the selected tab never flickers back to the idle colour.
            btn->SetBackgroundColor(StateColor(
                std::pair{wxColour(0x33, 0x33, 0x5C), (int) StateColor::Hovered},
                std::pair{wxColour(0x2A, 0x2A, 0x4A), (int) StateColor::Normal}));
            btn->SetTextColor(StateColor(
                std::pair{wxColour(0xE8, 0xE8, 0xF2), (int) StateColor::Normal}));
        } else {
            // Idle: caption on the bar, no visible rectangle; the card appears under the pointer.
            btn->SetBackgroundColor(StateColor(
                std::pair{wxColour(0x2A, 0x2A, 0x30), (int) StateColor::Hovered},
                std::pair{wxColour(0x14, 0x14, 0x16), (int) StateColor::Normal}));
            btn->SetTextColor(StateColor(
                std::pair{wxColour(0xA8, 0xA8, 0xBE), (int) StateColor::Hovered},
                std::pair{wxColour(0xA8, 0xA8, 0xBE), (int) StateColor::Normal}));
        }
        btn->Refresh();
    }
    Refresh();
}

bool ButtonsListCtrl::InsertPage(size_t n, const wxString &text, bool bSelect /* = false*/, const std::string &bmp_name /* = ""*/, const wxBitmap &bmp /* = wxNullBitmap */)
{
    // MKP: the captions carry no icons any more - an icon per tab ate a lot of horizontal
    // space without adding information. Only an icon-only tab (the home button, which has an
    // empty caption) still gets a bitmap, otherwise nothing would be drawn on it.
    Button * btn = text.empty() ? new Button(this, text, bmp_name, wxNO_BORDER)
                                : new Button(this, text, "", wxNO_BORDER);
    btn->SetCornerRadius(TAB_CORNER_RADIUS);

    if (text.empty() && bmp_name.empty() && bmp.IsOk())
        btn->SetIcon(bmp);

    int em = em_unit(this);
    //BBS set size for button
    // A compact pill: the label with little padding, so the card hugs the caption the
    // way it does in the MKP design instead of filling the whole strip.
    {
        const int pad_x = std::lround(0.95 * em);
        btn->SetPaddingSize({pad_x, std::lround(0.35 * em)});
    }
    {
        // Hug the caption: text width plus a little breathing room, instead of a fixed 104.
        int text_w = 0;
        if (!text.empty()) {
            wxClientDC dc(btn);
            dc.SetFont(btn->GetFont());
            dc.GetTextExtent(text, &text_w, nullptr);
        }
        const int w = text.empty() ? std::lround(4.0 * em) : text_w + std::lround(2.7 * em);
        btn->SetMinSize({w, std::lround(3.6 * em)});
    }

    // Idle tab: a slightly lifted purple-grey card that brightens under the cursor. The selected
    // one is repainted by SetSelection() below.
    // At rest a tab is just its caption on the bar: same colour, so no rectangle is visible. The
    // rounded card only appears under the pointer (hover) or on the selected tab.
    StateColor bg_color = StateColor(
        std::pair{wxColour(0x2A, 0x2A, 0x30), (int) StateColor::Hovered},
        std::pair{wxColour(0x14, 0x14, 0x16), (int) StateColor::Normal});

    btn->SetBackgroundColor(bg_color);
    // Hovering must not recolour the caption, so both states carry the same colour.
    StateColor text_color = StateColor(
        std::pair{wxColour(0xA8, 0xA8, 0xBE), (int) StateColor::Hovered},
        std::pair{wxColour(0xA8, 0xA8, 0xBE), (int) StateColor::Normal});
    btn->SetTextColor(text_color);
    btn->Bind(wxEVT_BUTTON, [this, btn](wxCommandEvent& event) {
        if (auto it = std::find(m_pageButtons.begin(), m_pageButtons.end(), btn); it != m_pageButtons.end()) {
            auto sel = it - m_pageButtons.begin();
            //do it later
            //SetSelection(sel);
            
            wxCommandEvent evt = wxCommandEvent(wxCUSTOMEVT_NOTEBOOK_SEL_CHANGED);
            evt.SetId(sel);
            wxPostEvent(this->GetParent(), evt);
        }
    });
    Slic3r::GUI::wxGetApp().UpdateDarkUI(btn);
    m_pageButtons.insert(m_pageButtons.begin() + n, btn);
    m_pageLabels.insert(m_pageLabels.begin() + n, text); // ORCA
    m_pageIcons.insert(m_pageIcons.begin() + n, bmp_name);
    m_buttons_sizer->Insert(n, new wxSizerItem(btn));
    m_buttons_sizer->SetCols(m_buttons_sizer->GetCols() + 1);
    m_sizer->Layout();
    return true;
}

void ButtonsListCtrl::RemovePage(size_t n)
{
    if (n >= m_pageButtons.size())
        return;

    if (m_selection == static_cast<int>(n))
        m_selection = -1;
    else if (m_selection > static_cast<int>(n))
        --m_selection;

    Button* btn = m_pageButtons[n];
    m_pageButtons.erase(m_pageButtons.begin() + n);
    m_pageLabels.erase(m_pageLabels.begin() + n); // ORCA
    m_pageIcons.erase(m_pageIcons.begin() + n);
    m_buttons_sizer->Remove(n);
#if __WXOSX__
    RemoveChild(btn);
#else
    btn->Reparent(nullptr);
#endif
    btn->Destroy();
    m_sizer->Layout();
}

bool ButtonsListCtrl::SetPageImage(size_t n, const std::string& bmp_name) const
{
    if (n >= m_pageButtons.size())
        return false;
     
    // BBS
    //return m_pageButtons[n]->SetBitmap_(bmp_name);
    ScalableBitmap bitmap(NULL, bmp_name);
    //m_pageButtons[n]->SetBitmap_(bitmap);
    return true;
}

void ButtonsListCtrl::SetPageText(size_t n, const wxString& strText)
{
    Button* btn = m_pageButtons[n];
    btn->SetLabel(strText);
    if(!strText.empty())  // ORCA
        m_pageLabels[n] = strText;
}

// ORCA
void ButtonsListCtrl::SetCompact(size_t n, bool compact)
{
    // MKP: the tabs no longer carry icons, so blanking the caption would leave nothing to click.
    // The tabs are already as narrow as their caption, so "compact" and normal are the same size.
    (void)compact;
    int em = em_unit(this);
    Button* btn = m_pageButtons[n];
    const wxString label = m_pageLabels[n];
    int text_w = 0;
    if (!label.empty()) {
        wxClientDC dc(btn);
        dc.SetFont(btn->GetFont());
        dc.GetTextExtent(label, &text_w, nullptr);
    }
    btn->SetMinSize({label.empty() ? std::lround(3.2 * em) : text_w + std::lround(2.7 * em),
                     std::lround(3.6 * em)});
    btn->SetLabel(label);
}

wxString ButtonsListCtrl::GetPageText(size_t n) const
{
    Button* btn = m_pageButtons[n];
    return btn->GetLabel();
}

// ORCA
wxString ButtonsListCtrl::GetPageLabel(size_t n) const
{
    return n < m_pageLabels.size() ? m_pageLabels[n] : wxString();
}

// ORCA
void ButtonsListCtrl::SetOverflowButton(wxWindow* button)
{
    if (m_overflow_button == button)
        return;

    if (m_overflow_button != nullptr)
        m_sizer->Detach(m_overflow_button);

    m_overflow_button = button;

    if (m_overflow_button != nullptr)
        // Right after the tab buttons (index 0), ahead of any stretch spacer / side_tools.
        m_sizer->Insert(1, m_overflow_button, 0, wxALIGN_CENTER_VERTICAL | wxLEFT | wxBOTTOM, m_btn_margin);

    m_sizer->Layout();
}

//#endif // _WIN32

void Notebook::Init()
{
    // We don't need any border as we don't have anything to separate the
    // page contents from.
    SetInternalBorder(0);

    // No effects by default.
    m_showEffect = m_hideEffect = wxSHOW_EFFECT_NONE;

    m_showTimeout = m_hideTimeout = 0;

    m_pageNames.clear();

    /* On Linux, Gstreamer wxMediaCtrl does not seem to get along well with
     * 32-bit X11 visuals (the overlay does not work).  Is this a wxWindows
     * bug?  Is this a Gstreamer bug?  No idea, but it is our problem ... 
     * and anyway, this transparency thing just isn't all that interesting,
     * so we just don't do it on Linux. 
     */
#ifndef __WXGTK__
    SetBackgroundStyle(wxBG_STYLE_TRANSPARENT);
#endif
}
