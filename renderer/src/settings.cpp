#include "settings.h"
#include <windows.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <fstream>
#include <iterator>
namespace hinge {
using namespace winrt::Windows::Data::Json;
std::filesystem::path executableDirectory(){wchar_t p[32768];DWORD n=GetModuleFileNameW(nullptr,p,32768);return std::filesystem::path(std::wstring(p,n)).parent_path();}
std::filesystem::path preferencesPath(){wchar_t p[32768];DWORD n=GetEnvironmentVariableW(L"LOCALAPPDATA",p,32768);
    if(!n||n>=32768)throw std::runtime_error("LOCALAPPDATA is unavailable");return std::filesystem::path(p)/L"HingeGlass"/L"preferences.json";}
static void merge(Settings& s,const std::filesystem::path& p){
    std::ifstream file(p);if(!file)throw std::runtime_error("Cannot read settings: "+p.string());
    std::string text((std::istreambuf_iterator<char>(file)),{});auto o=JsonObject::Parse(winrt::to_hstring(text));
    if(o.GetNamedNumber(L"version",0)!=1)throw std::runtime_error("Unsupported configuration version");
#define NUMBER(x) if(o.HasKey(L###x))s.x=o.GetNamedNumber(L###x)
    NUMBER(manualAngle);NUMBER(referenceAngle);NUMBER(blurPixels);NUMBER(frostResponse);NUMBER(frostDistanceMm);NUMBER(eyeY);
    NUMBER(screenWidth);NUMBER(screenHeight);NUMBER(maxFps);NUMBER(sweepSeconds);
    NUMBER(staleMs);NUMBER(predictionMs);NUMBER(retryMs);NUMBER(captureTimeoutMs);NUMBER(blurScale);
#undef NUMBER
#define STRING(x) if(o.HasKey(L###x))s.x=winrt::to_string(o.GetNamedString(L###x))
    STRING(fusionUrl);STRING(monitor);STRING(adapter);
#undef STRING
}
Settings loadSettings(const std::filesystem::path& p,bool preferences){Settings s;merge(s,p);
    if(preferences&&std::filesystem::exists(preferencesPath()))merge(s,preferencesPath());s.validate();return s;}
void saveSettings(const Settings& s,const std::filesystem::path& path){s.validate();JsonObject o;o.Insert(L"version",JsonValue::CreateNumberValue(1));
#define NUMBER(x) o.Insert(L###x,JsonValue::CreateNumberValue(s.x))
    NUMBER(manualAngle);NUMBER(referenceAngle);NUMBER(blurPixels);NUMBER(frostResponse);NUMBER(frostDistanceMm);NUMBER(eyeY);
    NUMBER(screenWidth);NUMBER(screenHeight);NUMBER(maxFps);NUMBER(sweepSeconds);
    NUMBER(staleMs);NUMBER(predictionMs);NUMBER(retryMs);NUMBER(captureTimeoutMs);NUMBER(blurScale);
#undef NUMBER
#define STRING(x) o.Insert(L###x,JsonValue::CreateStringValue(winrt::to_hstring(s.x)))
    STRING(fusionUrl);STRING(monitor);STRING(adapter);
#undef STRING
    std::filesystem::create_directories(path.parent_path());auto tmp=path;tmp+=L".tmp";
    {std::ofstream file(tmp,std::ios::binary|std::ios::trunc);file<<winrt::to_string(o.Stringify());file.flush();if(!file)throw std::runtime_error("Cannot save preferences");}
    if(!MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("Cannot publish preferences");
}
}
