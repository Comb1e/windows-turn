#include "angle.h"
#include <windows.h>
#include <winhttp.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <condition_variable>
#include <memory>
#include <stdexcept>
namespace hinge {
void EventParser::append(const std::string& bytes,const std::function<void(std::string,std::string)>& deliver){
    pending_+=bytes;if(pending_.size()>1024*1024)throw std::runtime_error("Fusion stream exceeded message bound");
    for(;;){
        size_t end=pending_.find("\n\n"),count=2,cr=pending_.find("\r\n\r\n");
        if(cr<end){end=cr;count=4;}if(end==std::string::npos)return;
        std::string block=pending_.substr(0,end);pending_.erase(0,end+count);
        std::string event="message",data;size_t start=0;
        while(start<block.size()){
            size_t n=block.find('\n',start);if(n==std::string::npos)n=block.size();
            std::string line=block.substr(start,n-start);if(!line.empty()&&line.back()=='\r')line.pop_back();
            size_t colon=line.find(':');std::string field=line.substr(0,colon);
            std::string value=colon==std::string::npos?"":line.substr(colon+1);if(value.starts_with(' '))value.erase(0,1);
            if(field=="event")event=value;else if(field=="data"){if(!data.empty())data+='\n';data+=value;}start=n+1;
        }
        if(!data.empty())deliver(event,data);
    }
}
std::optional<AngleSample> parseFusion(const std::string& text,double received){
    using namespace winrt::Windows::Data::Json;
    try{
        auto o=JsonObject::Parse(winrt::to_hstring(text));
        if(!o.HasKey(L"sessionId")||o.GetNamedValue(L"sessionId").ValueType()!=JsonValueType::String||
           !o.HasKey(L"displayAngleDeg")||o.GetNamedValue(L"displayAngleDeg").ValueType()!=JsonValueType::Number)return {};
        AngleSample s;s.angle=o.GetNamedNumber(L"displayAngleDeg");s.velocity=o.GetNamedNumber(L"displayVelocityDegS",0);
        s.sourceMs=o.GetNamedNumber(L"timestampMs");s.receivedMs=received;s.session=winrt::to_string(o.GetNamedString(L"sessionId"));
        auto state=o.GetNamedString(L"controllerState",L"STALE");
        if(s.session.empty()||!std::isfinite(s.angle)||s.angle<10||s.angle>120||!std::isfinite(s.velocity)
           ||!std::isfinite(s.sourceMs)||s.sourceMs<0||!std::isfinite(received)||received<0
           ||(state!=L"TRACKING"&&state!=L"CHASING"&&state!=L"STALE"))return {};
        s.valid=true;s.source="fusion";s.fresh=state!=L"STALE";
        // Retained/provisional display values remain usable. Freshness follows the existing controller.
        return s;
    }catch(...){return {};}
}
namespace {
struct Internet {HINTERNET h=nullptr;~Internet(){if(h)WinHttpCloseHandle(h);}Internet(HINTERNET value):h(value){}
    Internet(const Internet&)=delete;Internet& operator=(const Internet&)=delete;operator HINTERNET()const{return h;}};
void require(bool okay,const char* what){if(!okay)throw std::runtime_error(std::string(what)+" ("+std::to_string(GetLastError())+")");}
}
FusionAngle::FusionAngle(const Settings& s):settings_(s),worker_([this](std::stop_token stop){run(stop);}){}
FusionAngle::~FusionAngle(){worker_.request_stop();if(worker_.joinable())worker_.join();}
AngleSample FusionAngle::sample(double now){std::lock_guard lock(mutex_);return gate_.sample(now,settings_.staleMs,settings_.predictionMs);}
std::string FusionAngle::status(){
    std::lock_guard lock(mutex_);std::string message;
    switch(state_){
    case FusionState::Connecting:message="Connecting to Fusion";break;
    case FusionState::WaitingForCamera:message="Fusion connected; start camera in Fusion";break;
    case FusionState::WaitingForAngle:message="Fusion connected; waiting for a valid angle";break;
    case FusionState::Streaming:
        message=gate_.sample(nowMs(),settings_.staleMs,0).fresh?
            "Fusion connected; live angle (10–120 degrees)":"Fusion connected; angle stale / held";break;
    case FusionState::Retrying:message="Fusion reconnecting; holding angle: "+detail_;break;
    }
    return message+" — "+settings_.fusionUrl;
}
void FusionAngle::accept(const std::string& json){
    std::lock_guard lock(mutex_);
    if(auto value=parseFusion(json,nowMs())){
        auto last=gate_.sample(nowMs(),settings_.staleMs,0);
        if(gate_.ingest(*value)||(state_==FusionState::Retrying&&value->session==last.session&&value->sourceMs==last.sourceMs))
            state_=FusionState::Streaming;
        return;
    }
    gate_.disconnect();state_=FusionState::WaitingForAngle;
    try{
        auto o=winrt::Windows::Data::Json::JsonObject::Parse(winrt::to_hstring(json));
        if(o.GetNamedString(L"state",L"")==L"STOPPED"){
            gate_.endSession();state_=FusionState::WaitingForCamera;
        }
    }catch(...){}
}
void FusionAngle::run(std::stop_token stop){
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    while(!stop.stop_requested()){
        try{
            std::wstring url=winrt::to_hstring(settings_.fusionUrl).c_str();URL_COMPONENTS parts{sizeof(parts)};
            parts.dwHostNameLength=DWORD(-1);parts.dwUrlPathLength=DWORD(-1);require(WinHttpCrackUrl(url.c_str(),0,0,&parts),"Invalid Fusion URL");
            std::wstring host(parts.lpszHostName,parts.dwHostNameLength);
            Internet session(WinHttpOpen(L"HingeGlass/0.1",WINHTTP_ACCESS_TYPE_NO_PROXY,nullptr,nullptr,0));require(session.h!=nullptr,"WinHttpOpen");
            require(WinHttpSetTimeouts(session,1000,1000,1000,1000),"Fusion timeouts");
            Internet connection(WinHttpConnect(session,host.c_str(),parts.nPort,0));require(connection.h!=nullptr,"WinHttpConnect");
            {std::lock_guard lock(mutex_);gate_.connection();}
            auto request=[&](const wchar_t* path,bool streaming){
                Internet req(WinHttpOpenRequest(connection,L"GET",path,nullptr,WINHTTP_NO_REFERER,WINHTTP_DEFAULT_ACCEPT_TYPES,0));require(req.h!=nullptr,"WinHttpOpenRequest");
                DWORD redirect=WINHTTP_OPTION_REDIRECT_POLICY_NEVER;WinHttpSetOption(req,WINHTTP_OPTION_REDIRECT_POLICY,&redirect,sizeof(redirect));
                require(WinHttpSendRequest(req,WINHTTP_NO_ADDITIONAL_HEADERS,0,nullptr,0,0,0),"Fusion request");
                require(WinHttpReceiveResponse(req,nullptr),"Fusion response");DWORD code=0,size=sizeof(code);
                require(WinHttpQueryHeaders(req,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,nullptr,&code,&size,nullptr),"HTTP status");
                if(code!=200)throw std::runtime_error("Fusion HTTP "+std::to_string(code));
                EventParser parser;std::string snapshot;char buffer[8192];DWORD read=0;
                while(!stop.stop_requested()){
                    // Direct reads try to fill 8 KiB, delaying small SSE events until
                    // later publications (or timeout). Consume available bytes now.
                    DWORD available=0;
                    require(WinHttpQueryDataAvailable(req,&available),"Fusion stream availability");
                    DWORD bytes=available?std::min<DWORD>(available,sizeof(buffer)):sizeof(buffer);
                    require(WinHttpReadData(req,buffer,bytes,&read),"Fusion stream read");if(!read)break;
                    if(!streaming){snapshot.append(buffer,read);if(snapshot.size()>1024*1024)throw std::runtime_error("Fusion snapshot too large");}
                    else parser.append(std::string(buffer,read),[&](std::string event,std::string data){
                        if(event=="stopped"){
                            std::lock_guard lock(mutex_);gate_.endSession();state_=FusionState::WaitingForCamera;
                        }else if(event=="angle")accept(data);
                    });
                }
                if(!streaming)accept(snapshot);
                else if(!stop.stop_requested())throw std::runtime_error("event stream closed");
            };
            request(L"/api/angle",false);if(!stop.stop_requested())request(L"/api/events",true);
        }catch(const std::exception& e){std::lock_guard lock(mutex_);state_=FusionState::Retrying;detail_=e.what();gate_.disconnect();}
        catch(...){std::lock_guard lock(mutex_);state_=FusionState::Retrying;detail_="Fusion unavailable";gate_.disconnect();}
        std::mutex waitMutex;std::condition_variable_any cv;std::unique_lock waitLock(waitMutex);
        cv.wait_for(waitLock,stop,std::chrono::milliseconds(static_cast<int>(settings_.retryMs)),[]{return false;});
    }
    winrt::uninit_apartment();
}
}
