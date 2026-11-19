#ifndef slic3r_MkpInjectFloat_hpp_
#define slic3r_MkpInjectFloat_hpp_

#include <wx/panel.h>
#include <wx/webrequest.h>

#include <functional>
#include <string>
#include <vector>

class wxBoxSizer;
class wxButton;
class wxScrolledWindow;
class wxStaticText;

namespace Slic3r {
namespace GUI {

// 设备页悬浮窗：读取并补装 Klipper 侧的 shell 插件与不规则网床固件包。
//
// The panel floats over Orca's Device tab, parked at the bottom-right corner until the user drags
// it. It talks to the MKP bridge (mkp_bridge.py) over JSON-RPC - the same local server the MKP
// tabs are served from - so the SSH, hashing and installation logic stays in one place instead of
// being reimplemented here.
class MkpInjectFloat : public wxPanel
{
public:
    struct Item {
        wxString key;
        wxString label;
        wxString state;   // ok / stale / missing
        wxString detail;
    };

    MkpInjectFloat(wxWindow *parent, std::function<void()> open_settings);
    ~MkpInjectFloat() override = default;

    // Re-reads the device; auto_inject installs without asking when nothing is installed yet.
    void refresh(bool auto_inject);
    // Keeps the panel inside its parent, honouring a position the user dragged it to.
    void layout_in_parent(wxWindow *parent);

private:
    void build_ui();
    void set_collapsed(bool collapsed);
    void set_badge(const wxString &text, const wxColour &colour);
    void render(const wxString &badge, const wxColour &colour, const wxString &message,
                const std::vector<Item> &items);
    void request(const std::string &method, const std::string &args,
                 std::function<void(const std::string &)> done);
    void start_injection(bool automatic);
    void on_rpc_state(wxWebRequestEvent &evt);
    void set_busy(bool busy);

    std::function<void()> m_open_settings;

    wxPanel          *m_bar{ nullptr };
    wxStaticText     *m_title{ nullptr };
    wxStaticText     *m_dot{ nullptr };
    wxStaticText     *m_badge{ nullptr };
    wxButton         *m_min{ nullptr };
    wxPanel          *m_body{ nullptr };
    wxStaticText     *m_sub{ nullptr };
    wxScrolledWindow *m_list{ nullptr };
    wxBoxSizer       *m_list_sizer{ nullptr };
    wxStaticText     *m_message{ nullptr };
    wxButton         *m_settings{ nullptr };
    wxButton         *m_check{ nullptr };
    wxButton         *m_inject{ nullptr };

    wxWebRequest m_request;
    // Completion of the request in flight; wxWebRequest is not an event handler of its own.
    std::function<void(const std::string &)> m_on_rpc_done;
    bool         m_busy{ false };
    bool         m_confirming{ false };
    bool         m_auto_tried{ false };
    bool         m_collapsed{ false };
    bool         m_dragged{ false };
    bool         m_dragging{ false };
    wxPoint      m_drag_offset;
};

} // namespace GUI
} // namespace Slic3r

#endif
