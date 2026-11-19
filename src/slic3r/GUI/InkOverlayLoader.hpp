#pragma once

#include "libslic3r/PNGReadWrite.hpp"

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <exception>
#include <fstream>
#include <iterator>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace Slic3r::GUI {

// Reads only the latest preview selection. No GL or wx objects cross the worker boundary.
class InkOverlayLoader
{
public:
    struct Result {
        png::ImageColorscale image{};
        bool valid = false;
    };

    InkOverlayLoader() : m_worker([this] { run(); }) {}
    ~InkOverlayLoader()
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_stopping = true;
            m_pending.clear();
        }
        m_changed.notify_one();
        m_worker.join();
    }
    InkOverlayLoader(const InkOverlayLoader &) = delete;
    InkOverlayLoader &operator=(const InkOverlayLoader &) = delete;

    void request(uint64_t generation, const std::vector<std::string> &paths)
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            if (generation != m_generation) {
                m_generation = generation;
                m_ready.clear();
            }
            m_wanted = paths;
            for (auto it = m_ready.begin(); it != m_ready.end();) {
                if (!wanted(it->first)) it = m_ready.erase(it);
                else ++it;
            }
            m_pending.clear();
            for (const auto &path : paths)
                if (m_ready.count(path) == 0 &&
                    !(m_active && m_active->first == generation && m_active->second == path))
                    m_pending.emplace_back(generation, path);
        }
        m_changed.notify_one();
    }

    std::optional<Result> take(uint64_t generation, const std::string &path)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (generation != m_generation)
            return std::nullopt;
        auto it = m_ready.find(path);
        if (it == m_ready.end())
            return std::nullopt;
        Result result = std::move(it->second);
        m_ready.erase(it);
        return result;
    }

private:
    using Request = std::pair<uint64_t, std::string>;
    bool wanted(const std::string &path) const
    {
        return std::find(m_wanted.begin(), m_wanted.end(), path) != m_wanted.end();
    }
    void run()
    {
        for (;;) {
            Request job;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_changed.wait(lock, [this] { return m_stopping || !m_pending.empty(); });
                if (m_stopping)
                    return;
                job = std::move(m_pending.front());
                m_pending.pop_front();
                m_active = job;
            }
            Result result;
            try {
                std::ifstream in(job.second, std::ios::binary);
                if (in.is_open()) {
                    const std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
                    result.valid = !bytes.empty() &&
                        png::decode_colored_png(png::ReadBuf{bytes.data(), bytes.size()}, result.image) &&
                        (result.image.bytes_per_pixel == 3 || result.image.bytes_per_pixel == 4);
                }
            } catch (const std::exception &) {
                // Reslicing can remove or replace a PNG while it is being read; retry from the UI.
            }
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_active.reset();
                if (!m_stopping && job.first == m_generation && wanted(job.second))
                    m_ready.insert_or_assign(job.second, std::move(result));
            }
        }
    }

    std::mutex m_mutex;
    std::condition_variable m_changed;
    bool m_stopping = false;
    uint64_t m_generation = 0;
    std::vector<std::string> m_wanted;
    std::deque<Request> m_pending;
    std::optional<Request> m_active;
    std::map<std::string, Result> m_ready;
    std::thread m_worker;
};

} // namespace Slic3r::GUI
