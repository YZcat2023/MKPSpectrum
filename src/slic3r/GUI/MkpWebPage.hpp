#ifndef slic3r_MkpWebPage_hpp_
#define slic3r_MkpWebPage_hpp_

#include <wx/panel.h>
#include <wx/webview.h>
#include <wx/string.h>
#include <wx/timer.h>

class wxWebView;

namespace Slic3r {
namespace GUI {

// One MKPSpectrum page (平面 / 绘图仪 / 激光雕刻 / 拖刀切割) hosted in Orca's main tab book.
//
// The page is the MKP web front end itself. It is served by mkp_bridge.py, a small local HTTP
// server that also exposes the MKP python API (ModelAPI) over JSON-RPC; the served HTML gets a
// shim injected that turns window.pywebview.api into calls onto that server, so the unmodified
// MKP app.js runs inside WebView2. The bridge is started once per application run.
class MkpWebPage : public wxPanel
{
public:
    MkpWebPage(wxWindow *parent, const wxString &page);
    ~MkpWebPage() override;

    bool Show(bool show = true) override;
    void reload();

    // Base URL of the local bridge, starting the bridge process on first use.
    static wxString bridge_url();

private:
    void create_browser();
    void attach_browser(wxWebView *view);
    void ensure_browser();
    wxString page_url() const;
    void load_page();
    void on_loaded(wxWebViewEvent &evt);
    void on_script_message(wxWebViewEvent &evt);
    void inject_orca_bridge();
    void on_error(wxWebViewEvent &evt);

    wxString   m_page;
    wxWebView *m_browser{ nullptr };
    wxTimer    m_timer;
    int        m_attempts{ 0 };
    bool       m_loaded{ false };
};

}} // namespace Slic3r::GUI

#endif
