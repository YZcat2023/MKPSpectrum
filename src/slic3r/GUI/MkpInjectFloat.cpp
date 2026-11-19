#include "MkpInjectFloat.hpp"

#include "MkpWebPage.hpp"

#include <wx/wx.h>
#include <wx/button.h>
#include <wx/mstream.h>
#include <wx/scrolwin.h>
#include <wx/sizer.h>
#include <wx/stattext.h>
#include <wx/webrequest.h>

#include <nlohmann/json.hpp>
#include <boost/log/trivial.hpp>

#include <algorithm>

namespace Slic3r {
namespace GUI {

namespace {

const wxColour kPanelBg(28, 32, 36);
const wxColour kBarBg(35, 40, 45);
const wxColour kRowBg(32, 37, 42);
const wxColour kTextColour(0xd8, 0xdd, 0xe2);
const wxColour kMutedColour(0x98, 0xa2, 0xab);
const wxColour kOkColour(0x2e, 0xc8, 0xa6);
const wxColour kWarnColour(0xe0, 0xa3, 0x3a);
const wxColour kErrorColour(0xe0, 0x5c, 0x5c);
const wxColour kBusyColour(0x4a, 0xa8, 0xff);

wxColour state_colour(const wxString &state)
{
    if (state == "ok")      return kOkColour;
    if (state == "stale")   return kWarnColour;
    if (state == "missing") return kErrorColour;
    return kMutedColour;
}

} // namespace

MkpInjectFloat::MkpInjectFloat(wxWindow *parent, std::function<void()> open_settings)
    : wxPanel(parent, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxBORDER_SIMPLE),
      m_open_settings(std::move(open_settings))
{
    SetBackgroundColour(kPanelBg);
    build_ui();
    Hide();
}

void MkpInjectFloat::build_ui()
{
    auto *outer = new wxBoxSizer(wxVERTICAL);

    // ---- 标题栏（可拖动） ----
    m_bar = new wxPanel(this);
    m_bar->SetBackgroundColour(kBarBg);
    auto *bar = new wxBoxSizer(wxHORIZONTAL);
    m_dot   = new wxStaticText(m_bar, wxID_ANY, "●");
    m_title = new wxStaticText(m_bar, wxID_ANY, "插件注入");
    m_badge = new wxStaticText(m_bar, wxID_ANY, "待检查");
    m_min   = new wxButton(m_bar, wxID_ANY, "–", wxDefaultPosition, FromDIP(wxSize(24, 22)), wxBU_EXACTFIT);

    m_dot->SetForegroundColour(kMutedColour);
    m_title->SetForegroundColour(wxColour(0xee, 0xf2, 0xf5));
    m_title->SetFont(m_title->GetFont().Bold());
    m_badge->SetForegroundColour(kMutedColour);

    bar->Add(m_dot, wxSizerFlags().CentreVertical().Border(wxLEFT, 8));
    bar->Add(m_title, wxSizerFlags().CentreVertical().Border(wxLEFT, 6));
    bar->AddStretchSpacer();
    bar->Add(m_badge, wxSizerFlags().CentreVertical().Border(wxRIGHT, 8));
    bar->Add(m_min, wxSizerFlags().CentreVertical().Border(wxRIGHT, 4).Border(wxTOP | wxBOTTOM, 4));
    m_bar->SetSizer(bar);
    outer->Add(m_bar, wxSizerFlags().Expand());

    // ---- 主体 ----
    m_body = new wxPanel(this);
    m_body->SetBackgroundColour(kPanelBg);
    auto *body = new wxBoxSizer(wxVERTICAL);

    m_sub = new wxStaticText(m_body, wxID_ANY, "shell 插件 + 不规则网床固件包");
    m_sub->SetForegroundColour(kMutedColour);
    body->Add(m_sub, wxSizerFlags().Border(wxLEFT | wxRIGHT | wxTOP, 8));

    m_list = new wxScrolledWindow(m_body, wxID_ANY, wxDefaultPosition, FromDIP(wxSize(272, 170)), wxVSCROLL);
    m_list->SetBackgroundColour(kPanelBg);
    m_list->SetScrollRate(0, FromDIP(8));
    m_list_sizer = new wxBoxSizer(wxVERTICAL);
    m_list->SetSizer(m_list_sizer);
    body->Add(m_list, wxSizerFlags().Expand().Border(wxLEFT | wxRIGHT, 8));

    m_message = new wxStaticText(m_body, wxID_ANY, "切入设备页后自动检查设备注入状态。");
    m_message->SetForegroundColour(wxColour(0xa9, 0xb3, 0xbc));
    body->Add(m_message, wxSizerFlags().Expand().Border(wxLEFT | wxRIGHT | wxTOP, 8));
    m_message->Wrap(FromDIP(270));

    auto *actions = new wxBoxSizer(wxHORIZONTAL);
    m_settings = new wxButton(m_body, wxID_ANY, "打印机设置");
    m_check    = new wxButton(m_body, wxID_ANY, "重新检查");
    m_inject   = new wxButton(m_body, wxID_ANY, "立即注入");
    m_inject->Enable(false);
    actions->AddStretchSpacer();
    actions->Add(m_settings, wxSizerFlags().Border(wxLEFT, 4));
    actions->Add(m_check, wxSizerFlags().Border(wxLEFT, 4));
    actions->Add(m_inject, wxSizerFlags().Border(wxLEFT, 4));
    body->Add(actions, wxSizerFlags().Expand().Border(wxALL, 8));

    m_body->SetSizer(body);
    outer->Add(m_body, wxSizerFlags(1).Expand());

    SetSizer(outer);
    Fit();

    // ---- 事件 ----
    m_min->Bind(wxEVT_BUTTON, [this](wxCommandEvent &) { set_collapsed(!m_collapsed); });

    auto begin_drag = [this](wxMouseEvent &) {
        m_dragging    = true;
        m_dragged     = true;
        m_drag_offset = wxGetMousePosition() - GetScreenPosition();
        if (!HasCapture())
            CaptureMouse();
    };
    m_bar->Bind(wxEVT_LEFT_DOWN, begin_drag);
    m_dot->Bind(wxEVT_LEFT_DOWN, begin_drag);
    m_title->Bind(wxEVT_LEFT_DOWN, begin_drag);
    m_badge->Bind(wxEVT_LEFT_DOWN, begin_drag);

    Bind(wxEVT_MOTION, [this](wxMouseEvent &) {
        if (!m_dragging)
            return;
        SetPosition(wxGetMousePosition() - m_drag_offset);
    });
    Bind(wxEVT_LEFT_UP, [this](wxMouseEvent &) {
        if (!m_dragging)
            return;
        m_dragging = false;
        if (HasCapture())
            ReleaseMouse();
        layout_in_parent(GetParent());
    });

    m_settings->Bind(wxEVT_BUTTON, [this](wxCommandEvent &) {
        if (m_open_settings)
            m_open_settings();
    });
    m_check->Bind(wxEVT_BUTTON, [this](wxCommandEvent &) { refresh(false); });
    m_inject->Bind(wxEVT_BUTTON, [this](wxCommandEvent &) { start_injection(false); });

    // wxWebRequest reports through the handler given to CreateRequest, which is this panel.
    Bind(wxEVT_WEBREQUEST_STATE, &MkpInjectFloat::on_rpc_state, this);
}

void MkpInjectFloat::set_busy(bool busy)
{
    m_busy = busy;
    if (m_check)
        m_check->Enable(!busy);
}

void MkpInjectFloat::set_badge(const wxString &text, const wxColour &colour)
{
    if (!m_badge)
        return;
    m_badge->SetLabel(text);
    m_badge->SetForegroundColour(colour);
    m_badge->Refresh();
    if (m_dot) {
        m_dot->SetForegroundColour(colour);
        m_dot->Refresh();
    }
}

void MkpInjectFloat::set_collapsed(bool collapsed)
{
    m_collapsed = collapsed;
    if (m_body)
        m_body->Show(!collapsed);
    if (m_min)
        m_min->SetLabel(collapsed ? "+" : "–");
    GetSizer()->Layout();
    Fit();
    layout_in_parent(GetParent());
}

void MkpInjectFloat::render(const wxString &badge, const wxColour &colour, const wxString &message,
                            const std::vector<Item> &items)
{
    set_badge(badge, colour);

    if (m_list_sizer) {
        m_list_sizer->Clear(true);
        if (items.empty()) {
            auto *empty = new wxStaticText(m_list, wxID_ANY, "未读取到设备文件状态");
            empty->SetForegroundColour(kMutedColour);
            m_list_sizer->Add(empty, wxSizerFlags().Border(wxALL, 4));
        }
        for (const Item &item : items) {
            auto *row = new wxPanel(m_list);
            row->SetBackgroundColour(kRowBg);
            auto *row_sizer = new wxBoxSizer(wxHORIZONTAL);
            auto *dot = new wxStaticText(row, wxID_ANY, "●");
            dot->SetForegroundColour(state_colour(item.state));
            auto *text = new wxStaticText(row, wxID_ANY, item.label + "\n" + item.detail);
            text->SetForegroundColour(kTextColour);
            row_sizer->Add(dot, wxSizerFlags().Border(wxLEFT | wxTOP, 6));
            row_sizer->Add(text, wxSizerFlags(1).Border(wxLEFT | wxTOP | wxRIGHT | wxBOTTOM, 6));
            row->SetSizer(row_sizer);
            m_list_sizer->Add(row, wxSizerFlags().Expand().Border(wxBOTTOM, 4));
        }
        m_list->FitInside();
        m_list->Layout();
    }

    if (m_message) {
        m_message->SetLabel(message);
        m_message->Wrap(FromDIP(270));
    }
    GetSizer()->Layout();
    Fit();
    layout_in_parent(GetParent());
}

void MkpInjectFloat::layout_in_parent(wxWindow *parent)
{
    if (!parent)
        return;
    const wxSize area = parent->GetClientSize();
    const wxSize mine = GetSize();
    if (area.x <= 0 || mine.x <= 0)
        return;
    const int margin = FromDIP(24);
    int x = m_dragged ? GetPosition().x : area.x - mine.x - margin;
    int y = m_dragged ? GetPosition().y : area.y - mine.y - margin;
    x = std::max(0, std::min(x, std::max(0, area.x - mine.x)));
    y = std::max(0, std::min(y, std::max(0, area.y - mine.y)));
    SetPosition(wxPoint(x, y));
    Raise();
}

void MkpInjectFloat::request(const std::string &method, const std::string &args,
                             std::function<void(const std::string &)> done)
{
    const wxString url = MkpWebPage::bridge_url() + "/__rpc";
    nlohmann::json body;
    body["method"] = method;
    body["args"]   = nlohmann::json::parse(args, nullptr, false);
    if (!body["args"].is_array())
        body["args"] = nlohmann::json::array();
    const std::string payload = body.dump();

    m_request = wxWebSession::GetDefault().CreateRequest(this, url);
    if (!m_request.IsOk()) {
        done(std::string());
        return;
    }
    m_request.SetMethod("POST");
    m_request.SetHeader("Content-Type", "application/json");
    m_request.SetTimeouts(5000, 0);   // installing restarts Klipper: no data timeout
    auto *stream = new wxMemoryInputStream(payload.data(), payload.size());
    m_request.SetData(stream, "application/json");
    m_on_rpc_done = std::move(done);
    m_request.Start();
}

void MkpInjectFloat::refresh(bool auto_inject)
{
    if (m_busy)
        return;
    set_busy(true);
    m_confirming = false;
    if (m_inject)
        m_inject->SetLabel("立即注入");
    set_badge("检查中", kBusyColour);
    if (m_message)
        m_message->SetLabel("正在读取设备注入状态…");
    GetSizer()->Layout();

    request("check_printer_injection_status", "[\"\"]", [this, auto_inject](const std::string &raw) {
        set_busy(false);
        std::vector<Item> items;
        wxString message = "无法从 MKP 桥接获取设备状态";
        bool success = false, ssh_ready = false, injected = false;
        try {
            const nlohmann::json env = nlohmann::json::parse(raw);
            if (env.contains("result") && !env["result"].is_null()) {
                const nlohmann::json &result = env["result"];
                success   = result.value("success", false);
                ssh_ready = result.value("ssh_ready", false);
                injected  = result.value("injected", false);
                message   = wxString::FromUTF8(result.value("message", std::string()));
                if (result.contains("items") && result["items"].is_array()) {
                    for (const nlohmann::json &entry : result["items"]) {
                        Item item;
                        item.key    = wxString::FromUTF8(entry.value("key", std::string()));
                        item.label  = wxString::FromUTF8(entry.value("label", std::string()));
                        item.state  = wxString::FromUTF8(entry.value("state", std::string()));
                        item.detail = wxString::FromUTF8(entry.value("detail", std::string()));
                        items.push_back(item);
                    }
                }
            } else if (env.contains("error")) {
                message = wxString::FromUTF8(env.value("error", std::string()));
            }
        } catch (const std::exception &e) {
            message = wxString::FromUTF8(std::string("返回内容无法解析：") + e.what());
        }

        wxString badge  = "SSH 未就绪";
        wxColour colour = kWarnColour;
        if (success && injected) {
            badge  = "已注入";
            colour = kOkColour;
        } else if (ssh_ready) {
            badge  = "未注入";
            colour = kWarnColour;
        }
        render(badge, colour, message, items);
        if (m_inject)
            m_inject->Enable(success && ssh_ready && !injected && !m_busy);

        if (auto_inject && success && ssh_ready && !injected && !m_auto_tried) {
            m_auto_tried = true;
            start_injection(true);
        }
    });
}

void MkpInjectFloat::start_injection(bool automatic)
{
    if (m_busy)
        return;
    if (!automatic && !m_confirming) {
        m_confirming = true;
        if (m_inject)
            m_inject->SetLabel("再次点击确认");
        if (m_message) {
            m_message->SetLabel("将备份设备文件、注入 shell 插件与不规则网床固件包，并把区域调平设为 "
                                "Adaptive 后重启 Klipper；请确认打印机空闲。");
            m_message->Wrap(FromDIP(270));
        }
        GetSizer()->Layout();
        Fit();
        layout_in_parent(GetParent());
        return;
    }
    m_confirming = false;
    if (m_inject) {
        m_inject->SetLabel("立即注入");
        m_inject->Enable(false);
    }
    set_busy(true);
    set_badge("注入中", kBusyColour);
    if (m_message) {
        m_message->SetLabel(automatic ? "检测到设备尚未注入，正在自动注入 shell 插件与不规则网床固件包…"
                                      : "正在注入，请勿关闭窗口…");
        m_message->Wrap(FromDIP(270));
    }
    GetSizer()->Layout();

    request("load_printer_settings", "[]", [this](const std::string &raw) {
        wxString address;
        try {
            const nlohmann::json env = nlohmann::json::parse(raw);
            if (env.contains("result") && env["result"].contains("settings"))
                address = wxString::FromUTF8(
                    env["result"]["settings"].value("printerAddress", std::string()));
        } catch (const std::exception &) {
        }
        address.Trim().Trim(false);

        if (address.IsEmpty()) {
            set_busy(false);
            set_badge("未配置地址", kWarnColour);
            if (m_message) {
                m_message->SetLabel("未配置打印机地址：请先在「打印机设置」里填写 U1 地址与 SSH 主机密钥指纹。");
                m_message->Wrap(FromDIP(270));
            }
            GetSizer()->Layout();
            Fit();
            layout_in_parent(GetParent());
            return;
        }

        nlohmann::json args = nlohmann::json::array();
        args.push_back(address.ToStdString());
        args.push_back(true);
        request("install_printer_plugin", args.dump(), [this](const std::string &installed) {
            set_busy(false);
            wxString message = "注入失败";
            try {
                const nlohmann::json env = nlohmann::json::parse(installed);
                if (env.contains("result") && !env["result"].is_null())
                    message = wxString::FromUTF8(env["result"].value("message", std::string()));
                else if (env.contains("error"))
                    message = wxString::FromUTF8(env.value("error", std::string()));
            } catch (const std::exception &) {
            }
            BOOST_LOG_TRIVIAL(info) << "MkpInjectFloat: install result: " << message.ToUTF8().data();
            if (m_message) {
                m_message->SetLabel(message);
                m_message->Wrap(FromDIP(270));
            }
            GetSizer()->Layout();
            Fit();
            layout_in_parent(GetParent());
            refresh(false);   // 重新体检，面板按真实状态显示
        });
    });
}

void MkpInjectFloat::on_rpc_state(wxWebRequestEvent &evt)
{
    std::string payload;
    bool finished = false;
    switch (evt.GetState()) {
    case wxWebRequest::State_Completed:
        payload  = evt.GetResponse().AsString().ToStdString();
        finished = true;
        break;
    case wxWebRequest::State_Failed:
    case wxWebRequest::State_Cancelled:
    case wxWebRequest::State_Unauthorized:
        BOOST_LOG_TRIVIAL(warning) << "MkpInjectFloat: rpc failed: " << evt.GetErrorDescription().ToUTF8().data();
        finished = true;
        break;
    default:
        break;
    }
    if (!finished)
        return;
    // Cleared before the callback runs: it may start the next request.
    auto done = std::move(m_on_rpc_done);
    m_on_rpc_done = nullptr;
    if (done)
        done(payload);
}

} // namespace GUI
} // namespace Slic3r
