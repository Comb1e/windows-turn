#include "angle.h"
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <iostream>

// Exercises the production WinHTTP worker, without starting capture or a camera.
int main(int argc,char** argv){
    if(argc!=2)return 2;
    winrt::init_apartment();
    hinge::Settings settings;settings.fusionUrl=argv[1];settings.retryMs=100;settings.staleMs=200;settings.predictionMs=0;
    settings.validate();hinge::FusionAngle source(settings);
    using namespace winrt::Windows::Data::Json;
    std::cout<<"ready"<<std::endl;
    for(std::string command;std::getline(std::cin,command)&&command!="quit";){
        auto sample=source.sample(hinge::nowMs());JsonObject result;
        result.Insert(L"angle",JsonValue::CreateNumberValue(sample.angle));
        result.Insert(L"timestampMs",JsonValue::CreateNumberValue(sample.sourceMs));
        result.Insert(L"valid",JsonValue::CreateBooleanValue(sample.valid));
        result.Insert(L"fresh",JsonValue::CreateBooleanValue(sample.fresh));
        result.Insert(L"session",JsonValue::CreateStringValue(winrt::to_hstring(sample.session)));
        result.Insert(L"status",JsonValue::CreateStringValue(winrt::to_hstring(source.status())));
        std::cout<<winrt::to_string(result.Stringify())<<std::endl;
    }
}
