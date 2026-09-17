#pragma once
#include "core.h"
#include <mutex>
#include <thread>
#include <functional>

namespace hinge {
// Parser is shared by the real stream and contract tests. Split UTF-8 is preserved.
class EventParser {
    std::string pending_;
public:
    void append(const std::string& bytes,const std::function<void(std::string,std::string)>& deliver);
};
std::optional<AngleSample> parseFusion(const std::string& json,double receivedMs);
class FusionAngle final : public IAngleSource {
    Settings settings_;
    std::mutex mutex_;
    AngleGate gate_;
    std::string error_="Connecting to Fusion";
    std::jthread worker_;
    void run(std::stop_token stop);
public:
    explicit FusionAngle(const Settings& s);
    ~FusionAngle() override;
    AngleSample sample(double now) override;
    std::string status();
};
}
