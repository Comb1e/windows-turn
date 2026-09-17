#pragma once
#include "core.h"
#include <filesystem>
namespace hinge {
std::filesystem::path executableDirectory();
std::filesystem::path preferencesPath();
Settings loadSettings(const std::filesystem::path& defaults,bool preferences=true);
void saveSettings(const Settings& s,const std::filesystem::path& path=preferencesPath());
}
