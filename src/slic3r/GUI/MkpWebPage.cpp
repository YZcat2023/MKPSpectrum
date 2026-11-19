#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#endif

#include "MkpWebPage.hpp"

#include <wx/webview.h>
#include <wx/wx.h>
#include <wx/file.h>
#include <wx/filename.h>
#include <wx/process.h>
#include <wx/utils.h>
#include <wx/stdpaths.h>

#include "Widgets/WebView.hpp"
#include "GUI_App.hpp"
#include "NotificationManager.hpp"
#include "MainFrame.hpp"
#include "Plater.hpp"
#include "Tab.hpp"
#include "libslic3r/PresetBundle.hpp"
#include <nlohmann/json.hpp>
#include <boost/log/trivial.hpp>

#ifdef __WINDOWS__
#include <windows.h>
#endif

namespace Slic3r {
namespace GUI {

namespace {

// Reads an optional override from the environment ("" when unset).
wxString env_value(const char *name)
{
    wxString value;
    if (!wxGetEnv(wxString::FromUTF8(name), &value))
        value.clear();
    return value;
}

// Directory holding orca-slicer.exe: the installer lays mkp\ and python-mkp\ next to it,
// one level up, so a packaged build never depends on an environment variable or a dev checkout.
wxString exe_dir()
{
    wxFileName exe(wxStandardPaths::Get().GetExecutablePath());
    return exe.GetPath();
}

// A path that survives "..\" so comparisons and log lines stay readable.
wxString normalise(const wxString &path)
{
    wxFileName f(path);
    f.Normalize(wxPATH_NORM_DOTS | wxPATH_NORM_ABSOLUTE);
    return f.GetFullPath();
}

// Bridge location: MKP_BRIDGE_DIR wins when it really holds mkp_bridge.py, then the bundled
// copies beside the executable, and only then the developer checkout.
wxString mkp_dir()
{
    wxString dir = env_value("MKP_BRIDGE_DIR");
    if (!dir.IsEmpty() && wxFileName::FileExists(dir + "\\mkp_bridge.py"))
        return dir;

    const wxString base = exe_dir();
    const wxString candidates[] = { base + "\\mkp", base + "\\..\\mkp" };
    for (const auto &c : candidates) {
        const wxString full = normalise(c);
        if (wxFileName::FileExists(full + "\\mkp_bridge.py"))
            return full;
    }

    dir = "C:\\Users\\Administrator\\Desktop\\MKPSpectrum";
    return dir;
}

// Launches the bridge without a console window. wxExecute() has no creation flags on MSW, so the
// python interpreter would otherwise pop a terminal next to the slicer.
static void start_detached(const wxString &command)
{
#ifdef __WINDOWS__
    STARTUPINFOW si{};
    si.cb         = sizeof(si);
    si.dwFlags    = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    std::wstring cmd = command.ToStdWstring();
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                       CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
#else
    wxExecute(command, wxEXEC_ASYNC, nullptr);
#endif
}

// Runs a command windowless and waits for it, so a kill finishes before the next step.
static void run_hidden_and_wait(const wxString &command)
{
#ifdef __WINDOWS__
    STARTUPINFOW si{};
    si.cb          = sizeof(si);
    si.dwFlags     = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    std::wstring cmd = command.ToStdWstring();
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                       CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 2000);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
#else
    wxExecute(command, wxEXEC_SYNC);
#endif
}

// A bridge left over from an earlier run keeps the port and, worse, keeps serving the old
// front end it was started with: a rebuilt page would silently show stale behaviour. The
// bridge writes its pid next to itself, so a new run can stop the old one before starting.
static void stop_stale_bridge(const wxString &dir, const wxString &port)
{
    const wxString pid_file = dir + "\\_bridge_" + port + ".pid";
    if (!wxFileName::FileExists(pid_file))
        return;
    wxFile file;
    long pid = 0;
    if (file.Open(pid_file, wxFile::read)) {
        wxString text;
        file.ReadAll(&text);
        text.Trim().Trim(false);
        text.ToLong(&pid);
        file.Close();
    }
    if (pid > 0)
        run_hidden_and_wait(wxString::Format("cmd.exe /c taskkill /F /PID %ld >nul 2>&1", pid));
    wxRemoveFile(pid_file);
}

wxString python_exe()
{
    wxString py = env_value("MKP_PYTHON");
    if (!py.IsEmpty() && wxFileName::FileExists(py))
        return py;

    // The installer ships a private interpreter next to the slicer.
    const wxString base = exe_dir();
    const wxString bundled[] = { base + "\\python-mkp\\python.exe", base + "\\..\\python-mkp\\python.exe" };
    for (const auto &c : bundled) {
        const wxString full = normalise(c);
        if (wxFileName::FileExists(full))
            return full;
    }

    const wxString candidates[] = {
        "C:\\Users\\Administrator\\AppData\\Local\\Python\\bin\\python3.exe",
        "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
    };
    for (const auto &c : candidates)
        if (wxFileName::FileExists(c))
            return c;
    return "python";
}

// A plain TCP connect tells us whether the bridge already listens. Cheap, silent, no window.
// Poll budget shared by every MKP tab: reset when the bridge is found dead.
int g_bridge_polls = 0;

// One WebView2 controller is shared by every MKP tab. Creating one costs about 1.2 s and
// ~150 MB on this machine, and only one tab is on screen at a time, so the view is re-parented
// into whichever page is shown instead of five WebViews being built (and paid for) on click.
wxWebView  *g_shared_view = nullptr;
MkpWebPage *g_view_owner  = nullptr;
wxString    g_loaded_url;

bool tcp_listening(unsigned short port)
{
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
        return true; // cannot probe: let the webview try rather than hang forever
    bool open = false;
    SOCKET s  = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s != INVALID_SOCKET) {
        sockaddr_in addr{};
        addr.sin_family      = AF_INET;
        addr.sin_port        = htons(port);
        addr.sin_addr.s_addr = inet_addr("127.0.0.1");
        u_long nonblocking   = 1;
        ioctlsocket(s, FIONBIO, &nonblocking);
        connect(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr));
        fd_set wr, ex;
        FD_ZERO(&wr); FD_SET(s, &wr);
        FD_ZERO(&ex); FD_SET(s, &ex);
        timeval tv{0, 60000};
        if (::select(0, nullptr, &wr, &ex, &tv) > 0 && FD_ISSET(s, &wr))
            open = true;
        closesocket(s);
    }
    WSACleanup();
    return open;
#else
    (void)port;
    return true;
#endif
}


// ---- MKPSpectrum preset channel -------------------------------------------------
// The manufacturing pages carry a small side panel (machine preset, process preset and a
// handful of shortcuts). Those shortcuts are ordinary Orca preset options now, so the page
// reads and writes the live preset bundle through this channel instead of a private JSON file.
const char *const kMkpMachineKeys[] = {
    "mkp_inkjet_device", "mkp_inkjet_offset_x", "mkp_inkjet_offset_y", "mkp_inkjet_offset_z",
    "mkp_brush_offset_x", "mkp_brush_offset_y", "mkp_brush_offset_z",
    "mkp_pen_offset_x", "mkp_pen_offset_y", "mkp_pen_offset_z",
    "mkp_knife_offset_x", "mkp_knife_offset_y", "mkp_knife_offset_z",
    "mkp_laser_offset_x", "mkp_laser_offset_y", "mkp_laser_offset_z",
    "mkp_grab_brush_gcode", "mkp_release_brush_gcode",
    "mkp_grab_inkjet_gcode", "mkp_release_inkjet_gcode",
};

const char *const kMkpProcessKeys[] = {
    "mkp_surface_enabled", "mkp_surface_speed", "mkp_surface_wall_speed", "mkp_surface_inner_walls", "mkp_surface_pattern", "mkp_surface_line_spacing",
    "mkp_inkjet_density", "mkp_inkjet_speed", "mkp_inkjet_repeat", "mkp_inkjet_dry_time",
    "mkp_inkjet_flush_mode", "mkp_inkjet_flush_interval",
    "mkp_inkjet_retract_length", "mkp_inkjet_recovery_length",
    "mkp_inkjet_c", "mkp_inkjet_m", "mkp_inkjet_y",
    "mkp_inkjet_saturation", "mkp_inkjet_brightness", "mkp_inkjet_contrast", "mkp_inkjet_shear",
    "mkp_inkjet_wall_band",
    "mkp_full_height_prime_tower",
};

PresetCollection *mkp_presets_for(const std::string &kind)
{
    PresetBundle *bundle = wxGetApp().preset_bundle;
    if (bundle == nullptr)
        return nullptr;
    return kind == "machine" ? &bundle->printers : &bundle->prints;
}

Preset::Type mkp_preset_type(const std::string &kind)
{
    return kind == "machine" ? Preset::Type::TYPE_PRINTER : Preset::Type::TYPE_PRINT;
}

// Values travel as the serialised strings ConfigBase already produces, so the page never has to
// know whether an option is a float, an int, an enum or a string.
std::string mkp_preset_state(const std::string &kind)
{
    nlohmann::json out;
    out["kind"] = kind;
    out["current"] = std::string();
    out["names"] = nlohmann::json::array();
    out["values"] = nlohmann::json::object();
    PresetCollection *collection = mkp_presets_for(kind);
    if (collection == nullptr)
        return out.dump();
    out["current"] = collection->get_selected_preset_name();
    const bool machine = kind == "machine";
    for (const Preset &preset : collection->get_presets()) {
        if (!preset.is_visible || preset.name.empty())
            continue;
        // 工艺预设只列与当前打印机兼容的：否则下拉里会混进上百条 Ender-3 之类的无关项。
        // 机器预设则保持全量（换机器本来就是这里的用途）。
        if (!machine && !preset.is_compatible && preset.name != out["current"].get<std::string>())
            continue;
        out["names"].push_back(preset.name);
    }
    const Preset &selected = collection->get_selected_preset();
    out["can_save"] = selected.can_overwrite();
    const DynamicPrintConfig &config = collection->get_edited_preset().config;
    const char *const *keys = machine ? kMkpMachineKeys : kMkpProcessKeys;
    const size_t count = machine ? sizeof(kMkpMachineKeys) / sizeof(kMkpMachineKeys[0])
                                 : sizeof(kMkpProcessKeys) / sizeof(kMkpProcessKeys[0]);
    for (size_t i = 0; i < count; ++ i)
        if (config.has(keys[i]))
            out["values"][keys[i]] = config.opt_serialize(keys[i]);
    return out.dump();
}

// A preset that cannot be overwritten (system / bundled one) is saved next to itself instead of
// failing, and the caller gets the name that was actually written.
std::string mkp_unique_preset_name(PresetCollection *collection, const std::string &base)
{
    auto taken = [collection](const std::string &name) {
        for (const Preset &preset : collection->get_presets())
            if (preset.name == name)
                return true;
        return false;
    };
    if (!taken(base))
        return base;
    for (int i = 2; i < 1000; ++ i) {
        const std::string candidate = base + " (" + std::to_string(i) + ")";
        if (!taken(candidate))
            return candidate;
    }
    return base;
}

void mkp_push_config(Plater *plater)
{
    if (plater == nullptr || wxGetApp().preset_bundle == nullptr)
        return;
    plater->on_config_change(wxGetApp().preset_bundle->full_config());
}
} // namespace

wxString MkpWebPage::bridge_url()
{
    // One bridge per application run: the first MKP tab starts it, the others just point at it.
    static wxString s_url;
    if (!s_url.IsEmpty())
        return s_url;

    const wxString port = "8787";
    s_url = wxString::Format("http://127.0.0.1:%s", port);

    const wxString dir    = mkp_dir();
    const wxString script = dir + "\\mkp_bridge.py";
    if (!wxFileName::FileExists(script)) {
        wxLogWarning("MKP bridge script not found: %s", script);
        return s_url;
    }

    stop_stale_bridge(dir, port);

    wxString cmd = wxString::Format("\"%s\" \"%s\" --port %s", python_exe(), script, port);
    // A detached, hidden console: the bridge has no UI of its own.
    start_detached(cmd);
    return s_url;
}

MkpWebPage::MkpWebPage(wxWindow *parent, const wxString &page)
    : wxPanel(parent), m_page(page), m_timer(this)
{
    // 深色底：避免 WebView 首帧白底闪一下
    SetBackgroundColour(wxColour(0x14, 0x14, 0x16));
    // The page owns the browser through a sizer of its own; LazyPage only adds this panel.
    SetSizer(new wxBoxSizer(wxVERTICAL));
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: creating page '" << page.ToUTF8().data() << "'";

    Bind(wxEVT_TIMER, [this](wxTimerEvent &) { load_page(); });

    // The bridge needs a moment to import the MKP modules and bind the port; probing with a
    // premature LoadURL would only paint an error page into the tab.
    bridge_url();
}

MkpWebPage::~MkpWebPage()
{
    if (g_view_owner != this || g_shared_view == nullptr)
        return;
    // Only the page that currently holds the shared view tears it down.
    g_view_owner = nullptr;
    wxWebView *view = g_shared_view;
    g_shared_view = nullptr;
    g_loaded_url.clear();
    GetSizer()->Detach(view);
    view->Destroy();
}

wxString MkpWebPage::page_url() const
{
    return wxString::Format("%s/index.html?mkp_page=%s", bridge_url(), m_page);
}

// Moves the shared view into this page. The previous owner keeps its pointer cleared and
// re-attaches when its tab is shown again, so no page ever touches a view it does not own.
void MkpWebPage::attach_browser(wxWebView *view)
{
    if (view == nullptr)
        return;
    if (g_view_owner != nullptr && g_view_owner != this) {
        g_view_owner->GetSizer()->Detach(view);
        if (g_view_owner->m_browser == view)
            g_view_owner->m_browser = nullptr;
        g_view_owner->m_loaded   = false;
        g_view_owner->m_attempts = 0;
        view->Unbind(wxEVT_WEBVIEW_LOADED, &MkpWebPage::on_loaded, g_view_owner);
        view->Unbind(wxEVT_WEBVIEW_ERROR, &MkpWebPage::on_error, g_view_owner);
        view->Unbind(wxEVT_WEBVIEW_SCRIPT_MESSAGE_RECEIVED, &MkpWebPage::on_script_message, g_view_owner);
    }
    view->Reparent(this);
    GetSizer()->Add(view, wxSizerFlags().Expand().Proportion(1));
    view->Bind(wxEVT_WEBVIEW_LOADED, &MkpWebPage::on_loaded, this);
    view->Bind(wxEVT_WEBVIEW_ERROR, &MkpWebPage::on_error, this);
    view->Bind(wxEVT_WEBVIEW_SCRIPT_MESSAGE_RECEIVED, &MkpWebPage::on_script_message, this);
    m_browser    = view;
    g_view_owner = this;
    // m_loaded says "this view has a document", not "that document is this page": a view holding
    // another MKP page is switched in place by ensure_browser() instead of being navigated again.
    m_loaded     = !g_loaded_url.IsEmpty();
    m_attempts   = 0;
    Layout();
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: attached shared webview to page '" << m_page.ToUTF8().data()
                            << "' loaded=" << m_loaded;
}

// Attach the one shared view, creating it only the first time any MKP page is shown.
void MkpWebPage::ensure_browser()
{
    if (m_browser != nullptr && g_view_owner == this) {
        if (!m_loaded)
            load_page();
        return;
    }
    if (g_shared_view != nullptr) {
        attach_browser(g_shared_view);
        if (m_loaded) {
            // A document is already up: switch its page instead of reloading, which keeps every
            // page's state and costs nothing compared to a fresh navigation.
            const wxString js = wxString::Format("window.__mkpShow && window.__mkpShow('%s')", m_page);
            WebView::RunScript(m_browser, js);
            BOOST_LOG_TRIVIAL(info) << "MkpWebPage: switching shared webview to page '" << m_page.ToUTF8().data() << "'";
        } else {
            load_page();
        }
        return;
    }
    create_browser();
    if (m_browser != nullptr && !m_loaded)
        load_page();
}

void MkpWebPage::create_browser()
{
    if (g_shared_view != nullptr) {
        attach_browser(g_shared_view);
        return;
    }
    wxWebView *view = WebView::CreateWebView(this, "");
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: webview " << (view ? "created" : "FAILED");
    if (!view) {
        // No WebView2 runtime: say so instead of leaving a dead dark panel behind.
        auto *hint = new wxStaticText(this, wxID_ANY,
            "MKP 页面需要 WebView2 运行时，当前系统未检测到。\n"
            "请安装 Microsoft Edge WebView2 Runtime 后重启 OrcaSlicer。");
        hint->SetForegroundColour(wxColour(0xE0, 0xE0, 0xE0));
        GetSizer()->Add(hint, wxSizerFlags().Border(wxALL, 24));
        Layout();
        return;
    }
    // Chromium's own right-click menu (Refresh / Save as / Print / Inspect) has no business
    // inside a slicer panel.
    view->EnableContextMenu(false);
    g_shared_view = view;
    attach_browser(view);
}

void MkpWebPage::load_page()
{
    // A page that does not own the shared view has nothing to load; it re-attaches on show.
    if (!m_browser || g_view_owner != this)
        return;
    // Cold start: the bridge imports the MKP modules for 10-20 s before it binds the port.
    // Loading it too early paints Chromium's "connection refused" page, so poll quietly first;
    // nothing is shown in the tab until the port answers.
    if (!tcp_listening(8787) && g_bridge_polls < 60) {
        ++g_bridge_polls;
        if (g_bridge_polls % 5 == 1)
            BOOST_LOG_TRIVIAL(info) << "MkpWebPage: waiting for bridge (" << g_bridge_polls << ")";
        m_timer.StartOnce(400);
        return;
    }
    ++m_attempts;
    // Another page may have navigated the shared view meanwhile: reload through page_url(), which
    // is what the loaded-url bookkeeping compares against.
    const wxString url = page_url();
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: load " << url.ToUTF8().data() << " (attempt " << m_attempts << ")";
    WebView::LoadUrl(m_browser, url);
}

void MkpWebPage::on_loaded(wxWebViewEvent &evt)
{
    if (g_view_owner != this) {
        evt.Skip();
        return;
    }
    m_loaded     = true;
    g_loaded_url = evt.GetURL();
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: loaded " << evt.GetURL().ToUTF8().data();
    inject_orca_bridge();
    evt.Skip();
}

void MkpWebPage::on_error(wxWebViewEvent &evt)
{
    if (g_view_owner != this) {
        evt.Skip();
        return;
    }
    g_loaded_url.clear();
    // The bridge is not up yet (or died): retry a few times before giving up on the page.
    BOOST_LOG_TRIVIAL(warning) << "MkpWebPage: load error " << evt.GetString().ToUTF8().data();
    if (!m_loaded && m_attempts < 12) {
        if (!tcp_listening(8787))
            g_bridge_polls = 0; // bridge died: go back to quiet polling instead of error pages
        m_timer.StartOnce(900);
    }
    evt.Skip();
}

void MkpWebPage::reload()
{
    m_attempts = 0;
    load_page();
}

// 把「切片」这一步接进当前 Orca 实例：
//   页面照常导出 STL / 纹理 OBJ 并写 pending_slice.json，随后调用
//   window.pywebview.api.open_with_orca_slicer(stl, path)。这时不再启动第二个 Orca，
//   而是把 STL 直接装进当前盘子，用户在本窗口按「切片」即可；
//   工艺里的 post_process 会在切片结束时调用 MKPSpectrum 完成后处理。
void MkpWebPage::inject_orca_bridge()
{
    static const char *kJs = R"JS(
(function () {
  if (!window.pywebview || !window.pywebview.api) return false;
  function post(o) {
    if (window.chrome && window.chrome.webview)
      window.chrome.webview.postMessage(JSON.stringify(o));
  }
  var base = window.pywebview.api;
  var overrides = {
    open_with_orca_slicer: function (stl, path) {
      post({ mkp: 'load', path: String(stl || '') });
      return Promise.resolve({ success: true, in_app: true });
    },
    in_app_slice: function () {
      post({ mkp: 'slice' });
      return Promise.resolve({ success: true });
    }
  };
  window.pywebview.api = new Proxy(overrides, {
    get: function (t, n) {
      if (n === 'then') return undefined;
      if (n in t) return t[n];
      return function () { return base[n].apply(base, Array.prototype.slice.call(arguments)); };
    }
  });
  // 所有 MKP 页共用一个 WebView2：切 Orca 页签时只切这份文档里的页面，不重新导航，
  // 这样导入的图片/刀路、切片预览等状态都留着，切换也是即时的。
  window.__mkpShow = function (page) {
    var el = document.getElementById('nav-' + page);
    if (!el) return false;
    el.click();
    return true;
  };
  return true;
})()
)JS";
    if (m_browser)
        WebView::RunScript(m_browser, wxString::FromUTF8(kJs));
}

void MkpWebPage::on_script_message(wxWebViewEvent &evt)
{
    const wxString raw = evt.GetString();
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage: script message " << raw.ToUTF8().data();
    evt.Skip();
    try {
        const auto j = nlohmann::json::parse(raw.ToUTF8().data());
        const std::string cmd = j.value("mkp", "");
        MainFrame *mf = wxGetApp().mainframe;
        if (mf == nullptr || mf->plater() == nullptr)
            return;
        Plater *plater = mf->plater();
        if (cmd == "load") {
            const std::string path = j.value("path", "");
            if (path.empty() || !wxFileName::FileExists(wxString::FromUTF8(path)))
                return;
            // 立刻切回「准备」页，装进来的模型马上可见。
            mf->select_tab(wxString(TAB_ID_PREPARE));
            std::vector<boost::filesystem::path> files{ boost::filesystem::path(path) };
            plater->load_files(files, LoadStrategy::LoadModel, false);
        } else if (cmd == "slice") {
            mf->select_tab(wxString(TAB_ID_PREPARE));
            // 把「切片」接成一条无人值守的链：导出 G-code 走的就是 Orca 正常的切片流程，
            // 工艺预设里的 post_process 会在 finalize_gcode() 里执行 MKPSpectrum 的后处理
            // （纹理切片 → 喷墨条带 → GCode 后处理 → _temp.zip），
            // 所以这里不弹保存框，直接给一个临时路径。
            wxString dir = wxFileName::GetHomeDir() + "\\Documents\\MKPSpectrum\\Temp\\OrcaSlice";
            wxFileName::Mkdir(dir, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL);
            const wxString name = wxString::Format("mkp_slice_%s.gcode",
                                                   wxDateTime::Now().Format("%Y%m%d_%H%M%S"));
            const wxString full = dir + "\\" + name;
            BOOST_LOG_TRIVIAL(info) << "MkpWebPage: export gcode to " << full.ToUTF8().data();
            plater->export_gcode_to_path(std::string(full.ToUTF8().data()));
        } else if (cmd == "preset_query") {
            const std::string kind  = j.value("kind", "process");
            const int         req   = j.value("req", 0);
            const std::string state = mkp_preset_state(kind);
            bool ran = false;
            if (m_browser) {
                wxString js = wxString::Format("window.__mkpPreset && window.__mkpPreset(%d,", req);
                js += wxString::FromUTF8(state.c_str());
                js += ");";
                ran = WebView::RunScript(m_browser, js);
            }
            BOOST_LOG_TRIVIAL(info) << "MkpWebPage: preset_query " << kind << " run=" << ran
                                    << " len=" << state.size() << " head=" << state.substr(0, 240);
        } else if (cmd == "preset_set") {
            // A shortcut was edited: write it straight into the edited preset so the next
            // slice uses it, and let the settings tab re-read the preset afterwards.
            const std::string kind  = j.value("kind", "process");
            const std::string key   = j.value("key", "");
            const std::string value = j.value("value", "");
            PresetCollection *collection = mkp_presets_for(kind);
            Tab              *tab        = wxGetApp().get_tab(mkp_preset_type(kind));
            if (collection != nullptr && tab != nullptr && !key.empty() &&
                collection->get_edited_preset().config.has(key)) {
                collection->get_edited_preset().config.set_deserialize_strict(key, value);
                tab->reload_config();
                tab->update_dirty();
                mkp_push_config(plater);
                BOOST_LOG_TRIVIAL(info) << "MkpWebPage: preset_set " << kind << " " << key << " = " << value;
            } else {
                BOOST_LOG_TRIVIAL(warning) << "MkpWebPage: preset_set rejected " << kind << " " << key
                                           << " (collection=" << (collection != nullptr)
                                           << " tab=" << (tab != nullptr) << ")";
            }
        } else if (cmd == "preset_save") {
            const std::string kind = j.value("kind", "process");
            PresetCollection *collection = mkp_presets_for(kind);
            Tab              *tab        = wxGetApp().get_tab(mkp_preset_type(kind));
            std::string name, error;
            if (collection != nullptr) {
                const Preset &selected = collection->get_selected_preset();
                name = selected.can_overwrite() ? selected.name
                                                : mkp_unique_preset_name(collection, selected.name + " - MKP");
                try {
                    collection->save_current_preset(name, false, false);
                } catch (const std::exception &e) {
                    error = e.what();
                    BOOST_LOG_TRIVIAL(warning) << "MkpWebPage: preset_save failed: " << e.what();
                }
                if (tab != nullptr) {
                    tab->reload_config();
                    tab->update_dirty();
                }
                mkp_push_config(plater);
                // Reuse Orca's own "Configuration saved." notification instead of the MKP toast.
                if (error.empty() && plater != nullptr) {
                    if (NotificationManager *ntf = plater->get_notification_manager())
                        ntf->push_notification(NotificationType::CustomNotification,
                                               NotificationManager::NotificationLevel::RegularNotificationLevel,
                                               _u8L("Configuration saved."));
                }
            }
            if (m_browser) {
                nlohmann::json reply;
                reply["kind"]  = kind;
                reply["name"]  = name;
                reply["error"] = error;
                wxString js = wxString::Format("window.__mkpPresetSaved && window.__mkpPresetSaved(");
                js += wxString::FromUTF8(reply.dump().c_str());
                js += ");";
                WebView::RunScript(m_browser, js);
            }
        } else if (cmd == "preset_select") {
            const std::string kind = j.value("kind", "process");
            const std::string name = j.value("name", "");
            Tab *tab = wxGetApp().get_tab(mkp_preset_type(kind));
            bool ok = false;
            if (tab != nullptr && !name.empty()) {
                wxWindowUpdateLocker no_updates(tab);
                ok = tab->select_preset(name);
            }
            BOOST_LOG_TRIVIAL(info) << "MkpWebPage: preset_select " << kind << " '" << name
                                    << "' tab=" << (tab != nullptr) << " ok=" << ok;
            if (tab != nullptr && !name.empty() && ok) {
                mkp_push_config(plater);
                const std::string state = mkp_preset_state(kind);
                if (m_browser) {
                    wxString js = wxString::Format("window.__mkpPreset && window.__mkpPreset(0,");
                    js += wxString::FromUTF8(state.c_str());
                    js += ");";
                    WebView::RunScript(m_browser, js);
                }
            }
        }
    } catch (const std::exception &e) {
        BOOST_LOG_TRIVIAL(warning) << "MkpWebPage: bad script message: " << e.what();
    }
}

bool MkpWebPage::Show(bool show)
{
    BOOST_LOG_TRIVIAL(info) << "MkpWebPage::Show(" << show << ") page '" << m_page.ToUTF8().data() << "'";
    // The shared webview is taken (and, the very first time, created) here, before the page is
    // painted, so the tab never shows an empty panel.
    if (show)
        ensure_browser();
    return wxPanel::Show(show);
}

}} // namespace Slic3r::GUI
