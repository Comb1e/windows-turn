#pragma once
#include "core.h"
#include <windows.h>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <filesystem>
namespace hinge {
constexpr UINT WM_GLASS_VISIBILITY=WM_APP+1;
struct Monitor {HMONITOR handle=nullptr;RECT rect{};std::wstring name;double hz=60;bool hdr=false;};
struct Adapter {std::string id;std::wstring name;unsigned vendor=0;};
std::vector<Monitor> monitors();
std::vector<Adapter> adapters();
struct Telemetry {
    State state=State::Disabled;
    std::wstring message,adapter;
    double captureFps=0,renderFps=0,presentFps=0,gpuMs=0,frameAgeMs=0,captureDeliveryMs=0,angle=110,refreshHz=60;
    double p95GpuMs=0,p99FrameMs=0;
    double cpuCaptureMs=0,cpuRenderMs=0,cpuCursorMs=0,presentWaitMs=0,pacingWaitMs=0;
    uint64_t captures=0,renders=0,presents=0,dropped=0;
    bool fresh=true,hdr=false,presentStatsAvailable=false;
};
struct RenderOptions {Monitor monitor;bool preview=true,synthetic=false;double durationSeconds=0;std::filesystem::path report;bool benchmark=false;};
class Renderer {
    mutable std::mutex mutex_;
    Settings settings_;
    std::shared_ptr<IAngleSource> source_;
    Telemetry telemetry_;
    std::jthread worker_;
    std::atomic<bool> restart_{false},suspended_{false};
    void run(std::stop_token stop,HWND window,RenderOptions options);
public:
    ~Renderer();
    void configure(const Settings& s,std::shared_ptr<IAngleSource> source);
    void start(HWND window,const RenderOptions& options);
    void stop();
    void recover(){restart_=true;}
    void suspend(bool s){suspended_=s;restart_=true;}
    Telemetry status()const;
};
}
