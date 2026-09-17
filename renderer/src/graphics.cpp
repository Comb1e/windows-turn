#include "graphics.h"
#include "settings.h"
#include "cursor.h"
#include "window_layer.h"
#include <d3d11.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <wincodec.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <condition_variable>
#include <fstream>
#include <sstream>
#include <numeric>

namespace hinge {
using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
namespace {
std::string adapterId(LUID id){return std::to_string(id.HighPart)+":"+std::to_string(id.LowPart);}
com_ptr<IDXGIFactory6> factory(){com_ptr<IDXGIFactory6> f;check_hresult(CreateDXGIFactory1(__uuidof(IDXGIFactory6),f.put_void()));return f;}
double qpcMs(){LARGE_INTEGER t,f;QueryPerformanceCounter(&t);QueryPerformanceFrequency(&f);return static_cast<double>(t.QuadPart)*1000/f.QuadPart;}
struct Signal {HANDLE handle=CreateEventW(nullptr,FALSE,FALSE,nullptr);~Signal(){if(handle)CloseHandle(handle);}};
struct Target {
    com_ptr<ID3D11Texture2D> texture;com_ptr<ID3D11RenderTargetView> rtv;com_ptr<ID3D11ShaderResourceView> srv;UINT width=0,height=0;
    void create(ID3D11Device* device,UINT w,UINT h,DXGI_FORMAT format=DXGI_FORMAT_R16G16B16A16_FLOAT){
        texture=nullptr;rtv=nullptr;srv=nullptr;width=w;height=h;D3D11_TEXTURE2D_DESC d{};
        d.Width=w;d.Height=h;d.MipLevels=1;d.ArraySize=1;d.Format=format;d.SampleDesc.Count=1;d.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
        check_hresult(device->CreateTexture2D(&d,nullptr,texture.put()));check_hresult(device->CreateRenderTargetView(texture.get(),nullptr,rtv.put()));
        check_hresult(device->CreateShaderResourceView(texture.get(),nullptr,srv.put()));
    }
};
struct alignas(16) Constants {
    float rows[3][4]{};float sizes[4]{};float effect[4]{};float direction[4]{};float cursorRect[4]{};float cursorInfo[4]{};
};
struct Query {com_ptr<ID3D11Query> disjoint,begin,end;bool pending=false;};
double percentile(std::vector<double> values,double p){if(values.empty())return 0;std::sort(values.begin(),values.end());return values[static_cast<size_t>((values.size()-1)*p)];}
class Pipeline {
public:
    com_ptr<ID3D11Device> device;com_ptr<ID3D11DeviceContext> context;com_ptr<IDXGISwapChain3> swap;
    com_ptr<IDCompositionDevice> composition;com_ptr<IDCompositionTarget> compositionTarget;com_ptr<IDCompositionVisual> visual;
    com_ptr<ID3D11VertexShader> vs;com_ptr<ID3D11PixelShader> warp,blur,composite,pattern,lightShader;
    com_ptr<ID3D11Buffer> constants;com_ptr<ID3D11SamplerState> sampler;
    Target source,projected,smallA,smallB,lightField;
    com_ptr<ID3D11RenderTargetView> back;
    GraphicsCaptureItem item{nullptr};Direct3D11CaptureFramePool pool{nullptr};GraphicsCaptureSession session{nullptr};
    event_token arrived{},closed{};std::shared_ptr<Signal> signal=std::make_shared<Signal>();std::shared_ptr<std::atomic<bool>> captureClosed=std::make_shared<std::atomic<bool>>(false);
    std::unique_ptr<CursorLayer> cursor;
    std::array<Query,8> queries;size_t queryIndex=0;
    HANDLE frameWait=nullptr;UINT width=0,height=0;bool hdr=false,synthetic=false;
    uint64_t captures=0,dropped=0;double captureTime=0,delivery=0,cursorMs=0,presentMs=0;std::wstring adapterName;
    Pipeline(HWND hwnd,const Settings& settings,const RenderOptions& options){
        synthetic=options.synthetic;hdr=options.monitor.hdr;auto f=factory();com_ptr<IDXGIAdapter1> chosen;
        for(UINT i=0;;++i){com_ptr<IDXGIAdapter1> a;if(f->EnumAdapterByGpuPreference(i,DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,__uuidof(IDXGIAdapter1),a.put_void())==DXGI_ERROR_NOT_FOUND)break;
            DXGI_ADAPTER_DESC1 d{};a->GetDesc1(&d);if(d.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)continue;
            if(settings.adapter=="auto"){
                if(!chosen)chosen=a;
                if(std::wstring(d.Description).find(L"4070")!=std::wstring::npos){chosen=a;break;}
            }else if(adapterId(d.AdapterLuid)==settings.adapter){chosen=a;break;}
        }
        if(!chosen)throw std::runtime_error("Selected GPU is unavailable. Select Auto or another GPU.");
        DXGI_ADAPTER_DESC1 ad{};chosen->GetDesc1(&ad);adapterName=ad.Description;
        const D3D_FEATURE_LEVEL levels[]={D3D_FEATURE_LEVEL_11_1,D3D_FEATURE_LEVEL_11_0};D3D_FEATURE_LEVEL level;
        check_hresult(D3D11CreateDevice(chosen.get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,levels,2,D3D11_SDK_VERSION,device.put(),&level,context.put()));
        RECT bounds{};GetClientRect(hwnd,&bounds);width=std::max(1L,bounds.right);height=std::max(1L,bounds.bottom);
        DXGI_SWAP_CHAIN_DESC1 sd{};sd.Width=width;sd.Height=height;sd.Format=hdr?DXGI_FORMAT_R16G16B16A16_FLOAT:DXGI_FORMAT_B8G8R8A8_UNORM;
        sd.SampleDesc.Count=1;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.BufferCount=3;sd.SwapEffect=DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        sd.AlphaMode=DXGI_ALPHA_MODE_IGNORE;sd.Flags=DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;sd.Scaling=DXGI_SCALING_STRETCH;
        com_ptr<IDXGISwapChain1> first;check_hresult(f->CreateSwapChainForComposition(device.get(),&sd,nullptr,first.put()));swap=first.as<IDXGISwapChain3>();
        check_hresult(swap->SetMaximumFrameLatency(2));frameWait=swap->GetFrameLatencyWaitableObject();
        check_hresult(swap->SetColorSpace1(hdr?DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709:DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709));
        auto dxgi=device.as<IDXGIDevice>();check_hresult(DCompositionCreateDevice(dxgi.get(),__uuidof(IDCompositionDevice),composition.put_void()));
        check_hresult(composition->CreateTargetForHwnd(hwnd,TRUE,compositionTarget.put()));check_hresult(composition->CreateVisual(visual.put()));
        check_hresult(visual->SetContent(swap.get()));check_hresult(compositionTarget->SetRoot(visual.get()));check_hresult(composition->Commit());
        com_ptr<ID3D11Texture2D> buffer;check_hresult(swap->GetBuffer(0,__uuidof(ID3D11Texture2D),buffer.put_void()));
        check_hresult(device->CreateRenderTargetView(buffer.get(),nullptr,back.put()));
        auto compile=[&](const char* entry,const char* target){com_ptr<ID3DBlob> code,errors;
            HRESULT hr=D3DCompileFromFile((executableDirectory()/L"glass.hlsl").c_str(),nullptr,D3D_COMPILE_STANDARD_FILE_INCLUDE,entry,target,D3DCOMPILE_OPTIMIZATION_LEVEL3,0,code.put(),errors.put());
            if(FAILED(hr))throw std::runtime_error(errors?static_cast<const char*>(errors->GetBufferPointer()):"Shader compilation failed");return code;};
        auto code=compile("VS","vs_5_0");check_hresult(device->CreateVertexShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,vs.put()));
        auto pixel=[&](const char* entry,com_ptr<ID3D11PixelShader>& shader){auto c=compile(entry,"ps_5_0");check_hresult(device->CreatePixelShader(c->GetBufferPointer(),c->GetBufferSize(),nullptr,shader.put()));};
        pixel("Warp",warp);pixel("Blur",blur);pixel("Composite",composite);pixel("Pattern",pattern);pixel("Light",lightShader);
        D3D11_BUFFER_DESC bd{};bd.ByteWidth=sizeof(Constants);bd.Usage=D3D11_USAGE_DYNAMIC;bd.BindFlags=D3D11_BIND_CONSTANT_BUFFER;bd.CPUAccessFlags=D3D11_CPU_ACCESS_WRITE;
        check_hresult(device->CreateBuffer(&bd,nullptr,constants.put()));D3D11_SAMPLER_DESC ss{};ss.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        ss.AddressU=ss.AddressV=ss.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;ss.MaxLOD=D3D11_FLOAT32_MAX;check_hresult(device->CreateSamplerState(&ss,sampler.put()));
        projected.create(device.get(),width,height);smallA.create(device.get(),std::max(1U,UINT(width*settings.blurScale)),std::max(1U,UINT(height*settings.blurScale)));
        smallB.create(device.get(),smallA.width,smallA.height);lightField.create(device.get(),1,1);
        for(auto& q:queries){D3D11_QUERY_DESC d{D3D11_QUERY_TIMESTAMP_DISJOINT,0};check_hresult(device->CreateQuery(&d,q.disjoint.put()));d.Query=D3D11_QUERY_TIMESTAMP;
            check_hresult(device->CreateQuery(&d,q.begin.put()));check_hresult(device->CreateQuery(&d,q.end.put()));}
        cursor=std::make_unique<CursorLayer>(device.get());
        if(synthetic){source.create(device.get(),options.monitor.rect.right-options.monitor.rect.left,options.monitor.rect.bottom-options.monitor.rect.top);}
        else{
            if(!GraphicsCaptureSession::IsSupported())throw std::runtime_error("Windows screen capture is unavailable");
            auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
            check_hresult(interop->CreateForMonitor(options.monitor.handle,guid_of<GraphicsCaptureItem>(),put_abi(item)));
            com_ptr<IInspectable> wrapped;check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(),wrapped.put()));
            pool=Direct3D11CaptureFramePool::CreateFreeThreaded(wrapped.as<IDirect3DDevice>(),hdr?DirectXPixelFormat::R16G16B16A16Float:DirectXPixelFormat::B8G8R8A8UIntNormalized,2,item.Size());
            session=pool.CreateCaptureSession(item);session.IsCursorCaptureEnabled(false);
            // The OS capture border is retained unless Windows allows borderless capture for this app.
            // No UI permission is silently granted by the renderer.
            auto eventSignal=signal;arrived=pool.FrameArrived([eventSignal](auto&&,auto&&){SetEvent(eventSignal->handle);});
            auto closure=captureClosed;closed=item.Closed([closure,eventSignal](auto&&,auto&&){*closure=true;SetEvent(eventSignal->handle);});
            session.StartCapture();
        }
    }
    ~Pipeline(){
        if(cursor){try{cursor->hide(false);}catch(...){}cursor.reset();}
        try{if(pool)pool.FrameArrived(arrived);if(item)item.Closed(closed);if(session)session.Close();if(pool)pool.Close();}catch(...){}
        if(context){context->ClearState();context->Flush();}if(frameWait)CloseHandle(frameWait);
    }
    bool capture(){
        if(synthetic)return true;
        if(*captureClosed)throw std::runtime_error("Capture monitor closed or disconnected");
        if(WaitForSingleObject(signal->handle,0)!=WAIT_OBJECT_0)return false;
        Direct3D11CaptureFrame latest{nullptr};
        while(auto frame=pool.TryGetNextFrame()){if(latest){latest.Close();++dropped;}latest=frame;}
        if(!latest)return false;
        auto size=latest.ContentSize();if(size.Width<1||size.Height<1){latest.Close();return false;}
        auto texture=latest.Surface().as<IDirect3DDxgiInterfaceAccess>();com_ptr<ID3D11Texture2D> native;
        check_hresult(texture->GetInterface(__uuidof(ID3D11Texture2D),native.put_void()));D3D11_TEXTURE2D_DESC desc{};native->GetDesc(&desc);
        if(UINT(size.Width)!=desc.Width||UINT(size.Height)!=desc.Height){latest.Close();throw std::runtime_error("Capture dimensions changed; recreating capture");}
        if(!source.texture||source.width!=desc.Width||source.height!=desc.Height)source.create(device.get(),desc.Width,desc.Height,desc.Format);
        context->CopyResource(source.texture.get(),native.get());captureTime=latest.SystemRelativeTime().count()/10000.0;
        delivery=std::max(0.,qpcMs()-captureTime);++captures;latest.Close();return true;
    }
    void draw(ID3D11PixelShader* shader,ID3D11RenderTargetView* output,UINT w,UINT h,Constants& p,ID3D11ShaderResourceView* input,ID3D11ShaderResourceView* second=nullptr){
        ID3D11ShaderResourceView* empty[5]{};context->PSSetShaderResources(0,5,empty);context->OMSetRenderTargets(1,&output,nullptr);
        D3D11_VIEWPORT vp{0,0,static_cast<float>(w),static_cast<float>(h),0,1};context->RSSetViewports(1,&vp);
        D3D11_MAPPED_SUBRESOURCE mapped{};check_hresult(context->Map(constants.get(),0,D3D11_MAP_WRITE_DISCARD,0,&mapped));memcpy(mapped.pData,&p,sizeof(p));context->Unmap(constants.get(),0);
        auto cb=constants.get();context->PSSetConstantBuffers(0,1,&cb);context->VSSetShader(vs.get(),nullptr,0);context->PSSetShader(shader,nullptr,0);
        auto samplerPtr=sampler.get();context->PSSetSamplers(0,1,&samplerPtr);ID3D11ShaderResourceView* views[]={input,second,cursor->color.get(),cursor->mask.get(),shader==warp.get()?lightField.srv.get():nullptr};
        context->PSSetShaderResources(0,5,views);context->IASetInputLayout(nullptr);context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);context->Draw(3,0);
        context->PSSetShaderResources(0,5,empty);context->OMSetRenderTargets(0,nullptr,nullptr);
    }
    double collect(){double last=-1;
        for(auto& q:queries)if(q.pending){D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};UINT64 begin=0,end=0;
            if(context->GetData(q.disjoint.get(),&disjoint,sizeof(disjoint),D3D11_ASYNC_GETDATA_DONOTFLUSH)==S_OK&&
               context->GetData(q.begin.get(),&begin,sizeof(begin),D3D11_ASYNC_GETDATA_DONOTFLUSH)==S_OK&&
               context->GetData(q.end.get(),&end,sizeof(end),D3D11_ASYNC_GETDATA_DONOTFLUSH)==S_OK){
                q.pending=false;if(!disjoint.Disjoint&&disjoint.Frequency)last=double(end-begin)*1000/disjoint.Frequency;
            }}return last;
    }
    void render(const Settings& s,double angle,const Monitor& monitor,double elapsed,UINT syncInterval=1,bool nativePointer=false){
        auto& query=queries[queryIndex];bool measure=!query.pending;if(measure){context->Begin(query.disjoint.get());context->End(query.begin.get());}
        Constants p{};auto map=projection(s,angle);for(int row=0;row<3;++row)for(int col=0;col<3;++col)p.rows[row][col]=static_cast<float>(map.h[row*3+col]);
        p.sizes[0]=static_cast<float>(width);p.sizes[1]=static_cast<float>(height);p.sizes[2]=static_cast<float>(source.width);p.sizes[3]=static_cast<float>(source.height);
        p.effect[0]=static_cast<float>(frosting(angle,s.referenceAngle,s.frostResponse));p.effect[1]=static_cast<float>(s.blurPixels);p.effect[2]=hdr||synthetic?0.f:1.f;p.effect[3]=hdr?1.f:0.f;
        p.direction[3]=static_cast<float>(elapsed);
        if(synthetic){draw(pattern.get(),source.rtv.get(),source.width,source.height,p,nullptr);++captures;captureTime=qpcMs();}
        double cursorStart=nowMs();cursor->update(monitor.rect);cursorMs=nowMs()-cursorStart;std::copy(cursor->rectangle.begin(),cursor->rectangle.end(),p.cursorRect);p.cursorInfo[0]=cursor->visible&&!nativePointer?1.f:0.f;
        draw(lightShader.get(),lightField.rtv.get(),1,1,p,source.srv.get());
        draw(warp.get(),projected.rtv.get(),width,height,p,source.srv.get());
        float reducedRadius=static_cast<float>(s.blurPixels*p.effect[0]*smallA.width/width);
        p.direction[0]=1.f/smallA.width;p.direction[1]=0;p.direction[2]=std::ceil(reducedRadius);p.direction[3]=reducedRadius/3;
        draw(blur.get(),smallA.rtv.get(),smallA.width,smallA.height,p,projected.srv.get());
        reducedRadius=static_cast<float>(s.blurPixels*p.effect[0]*smallA.height/height);
        p.direction[0]=0;p.direction[1]=1.f/smallA.height;p.direction[2]=std::ceil(reducedRadius);p.direction[3]=reducedRadius/3;
        draw(blur.get(),smallB.rtv.get(),smallB.width,smallB.height,p,smallA.srv.get());
        draw(composite.get(),back.get(),width,height,p,projected.srv.get(),smallB.srv.get());
        if(measure){context->End(query.end.get());context->End(query.disjoint.get());query.pending=true;queryIndex=(queryIndex+1)%queries.size();}
        double presentStart=nowMs();check_hresult(swap->Present(syncInterval,0));presentMs=nowMs()-presentStart;
    }
    // Explicit synthetic diagnostics only. Live desktop pixels never take this CPU path.
    void snapshot(const std::filesystem::path& path){
        if(!synthetic||hdr||path.empty())return;
        com_ptr<ID3D11Resource> resource;back->GetResource(resource.put());auto texture=resource.as<ID3D11Texture2D>();
        D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
        com_ptr<ID3D11Texture2D> staging;check_hresult(device->CreateTexture2D(&desc,nullptr,staging.put()));context->CopyResource(staging.get(),texture.get());
        D3D11_MAPPED_SUBRESOURCE mapped{};check_hresult(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));
        struct Unmap {ID3D11DeviceContext* c;ID3D11Resource* r;~Unmap(){c->Unmap(r,0);}} unmap{context.get(),staging.get()};
        if(!path.parent_path().empty())std::filesystem::create_directories(path.parent_path());
        auto wic=create_instance<IWICImagingFactory>(CLSID_WICImagingFactory);com_ptr<IWICStream> stream;check_hresult(wic->CreateStream(stream.put()));
        check_hresult(stream->InitializeFromFilename(path.c_str(),GENERIC_WRITE));com_ptr<IWICBitmapEncoder> encoder;check_hresult(wic->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()));
        check_hresult(encoder->Initialize(stream.get(),WICBitmapEncoderNoCache));com_ptr<IWICBitmapFrameEncode> frame;check_hresult(encoder->CreateNewFrame(frame.put(),nullptr));
        check_hresult(frame->Initialize(nullptr));check_hresult(frame->SetSize(width,height));WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;check_hresult(frame->SetPixelFormat(&format));
        check_hresult(frame->WritePixels(height,mapped.RowPitch,mapped.RowPitch*height,static_cast<BYTE*>(mapped.pData)));check_hresult(frame->Commit());check_hresult(encoder->Commit());
    }
};
void writeReport(const std::filesystem::path& path,const Telemetry& t,const RenderOptions& options,const Settings& settings,double seconds){
    if(path.empty())return;using namespace winrt::Windows::Data::Json;JsonObject o;
    auto num=[&](const wchar_t* k,double v){o.Insert(k,JsonValue::CreateNumberValue(v));};
    o.Insert(L"adapter",JsonValue::CreateStringValue(t.adapter));o.Insert(L"state",JsonValue::CreateStringValue(stateName(t.state)));o.Insert(L"message",JsonValue::CreateStringValue(t.message));
    o.Insert(L"synthetic",JsonValue::CreateBooleanValue(options.synthetic));o.Insert(L"preview",JsonValue::CreateBooleanValue(options.preview));
    o.Insert(L"presentStatisticsAvailable",JsonValue::CreateBooleanValue(t.presentStatsAvailable));
    auto previewSize=fitPreview(options.monitor.rect.right-options.monitor.rect.left,options.monitor.rect.bottom-options.monitor.rect.top);
    num(L"seconds",seconds);num(L"renderWidth",options.preview?previewSize.width:options.monitor.rect.right-options.monitor.rect.left);
    num(L"renderHeight",options.preview?previewSize.height:options.monitor.rect.bottom-options.monitor.rect.top);num(L"monitorRefreshHz",options.monitor.hz);
    o.Insert(L"projectionMode",JsonValue::CreateStringValue(to_hstring(settings.projectionMode)));
    num(L"maxBlurPixels",settings.blurPixels);num(L"frostResponse",settings.frostResponse);num(L"finalAngle",t.angle);
    num(L"requestedCap",settings.maxFps);num(L"captures",double(t.captures));num(L"renders",double(t.renders));num(L"presents",double(t.presents));
    num(L"averageRenderFps",seconds>0?t.renders/seconds:0);num(L"gpuP95Ms",t.p95GpuMs);num(L"frameIntervalP99Ms",t.p99FrameMs);num(L"droppedCaptures",double(t.dropped));
    num(L"cpuCaptureMs",t.cpuCaptureMs);num(L"cpuRenderMs",t.cpuRenderMs);num(L"cpuCursorMs",t.cpuCursorMs);num(L"presentWaitMs",t.presentWaitMs);num(L"pacingWaitMs",t.pacingWaitMs);
    o.Insert(L"rtx240Verified",JsonValue::CreateBooleanValue(!options.preview&&options.monitor.hz>=239&&t.adapter.find(L"4070")!=std::wstring::npos&&t.presentStatsAvailable&&seconds>=59&&t.presents/seconds>=237&&t.p95GpuMs<1000./240));
    if(!path.parent_path().empty())std::filesystem::create_directories(path.parent_path());std::ofstream file(path);file<<to_string(o.Stringify());
}
}
std::vector<Adapter> adapters(){std::vector<Adapter> result;auto f=factory();
    for(UINT i=0;;++i){com_ptr<IDXGIAdapter1> a;if(f->EnumAdapters1(i,a.put())==DXGI_ERROR_NOT_FOUND)break;DXGI_ADAPTER_DESC1 d{};a->GetDesc1(&d);
        if(!(d.Flags&DXGI_ADAPTER_FLAG_SOFTWARE))result.push_back({adapterId(d.AdapterLuid),d.Description,d.VendorId});}return result;}
std::vector<Monitor> monitors(){std::vector<Monitor> result;
    EnumDisplayMonitors(nullptr,nullptr,[](HMONITOR handle,HDC,LPRECT,LPARAM parameter)->BOOL{
        auto& list=*reinterpret_cast<std::vector<Monitor>*>(parameter);MONITORINFOEXW info{};info.cbSize=sizeof(info);GetMonitorInfoW(handle,&info);
        DEVMODEW mode{};mode.dmSize=sizeof(mode);EnumDisplaySettingsW(info.szDevice,ENUM_CURRENT_SETTINGS,&mode);
        list.push_back({handle,info.rcMonitor,info.szDevice,double(mode.dmDisplayFrequency>1?mode.dmDisplayFrequency:60),false});return TRUE;
    },reinterpret_cast<LPARAM>(&result));auto f=factory();
    for(UINT i=0;;++i){com_ptr<IDXGIAdapter1> a;if(f->EnumAdapters1(i,a.put())==DXGI_ERROR_NOT_FOUND)break;
        for(UINT j=0;;++j){com_ptr<IDXGIOutput> output;if(a->EnumOutputs(j,output.put())==DXGI_ERROR_NOT_FOUND)break;auto advanced=output.try_as<IDXGIOutput6>();if(!advanced)continue;
            DXGI_OUTPUT_DESC1 d{};advanced->GetDesc1(&d);for(auto& m:result)if(m.handle==d.Monitor)m.hdr=d.ColorSpace==DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;}}
    return result;
}
Renderer::~Renderer(){stop();}
void Renderer::configure(const Settings& s,std::shared_ptr<IAngleSource> source){s.validate();std::lock_guard lock(mutex_);settings_=s;source_=std::move(source);}
void Renderer::start(HWND window,const RenderOptions& options){stop();restart_=false;suspended_=false;worker_=std::jthread([this,window,options](std::stop_token stop){run(stop,window,options);});}
void Renderer::stop(){worker_.request_stop();if(worker_.joinable())worker_.join();std::lock_guard lock(mutex_);telemetry_.state=State::Disabled;}
Telemetry Renderer::status()const{std::lock_guard lock(mutex_);return telemetry_;}
void Renderer::run(std::stop_token stop,HWND window,RenderOptions options){
    init_apartment(apartment_type::multi_threaded);Lifecycle life;life.transition(State::Starting);double totalStart=nowMs();
    Telemetry stats;Settings settings;std::vector<double> gpuTimes,frameTimes;unsigned failures=0;double angle=110;bool haveAngle=false;
    double measureStart=0;uint64_t warmRenders=0,warmPresents=0,warmCaptures=0;SweepAngle benchmarkSweep;
    struct ThreadCleanup{~ThreadCleanup(){SetThreadExecutionState(ES_CONTINUOUS);uninit_apartment();}} cleanup;
    auto publish=[&]{std::lock_guard lock(mutex_);stats.state=life.state;telemetry_=stats;};
    std::condition_variable_any waiter;std::mutex waitMutex;
    auto wait=[&](double ms){std::unique_lock lock(waitMutex);waiter.wait_for(lock,stop,std::chrono::milliseconds(static_cast<int>(ms)),[]{return false;});};
    while(!stop.stop_requested()){
        if(suspended_){if(life.state!=State::Suspended)life.transition(State::Suspended);publish();wait(100);continue;}
        try{
            if(life.state!=State::Starting)life.transition(State::Starting);publish();
            {std::lock_guard lock(mutex_);settings=settings_;}
            // Rebind by persistent display name after monitor/adapter changes; never pick a different screen silently.
            auto displays=monitors();auto selected=std::find_if(displays.begin(),displays.end(),[&](auto& m){return m.name==options.monitor.name;});
            if(selected==displays.end())throw std::runtime_error("Selected monitor is disconnected");options.monitor=*selected;
            Pipeline pipeline(window,settings,options);stats.adapter=pipeline.adapterName;stats.refreshHz=options.monitor.hz;stats.hdr=pipeline.hdr;
            stats.message=L"Waiting for first capture";publish();SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED);
            const uint64_t captureBase=stats.captures,presentBase=stats.presents,dropBase=stats.dropped;
            double started=nowMs(),firstFrameAt=0,lastFrame=0,lastPublish=started;uint64_t lastCaptures=0,lastRenders=stats.renders,lastPresents=stats.presents;
            if(!haveAngle)angle=settings.manualAngle;bool shown=false;restart_=false;
            while(!stop.stop_requested()&&!restart_&&!suspended_){
                std::shared_ptr<IAngleSource> source;{std::lock_guard lock(mutex_);settings=settings_;source=source_;}
                const double now=nowMs();auto value=options.benchmark&&measureStart>0?benchmarkSweep.sample(now):(source?source->sample(now):AngleSample{});
                if(value.valid&&std::isfinite(value.angle)&&(value.fresh||!haveAngle)){angle=value.angle;haveAngle=true;}stats.angle=angle;stats.fresh=value.fresh;
                double captureAt=nowMs();pipeline.capture();stats.cpuCaptureMs=.9*stats.cpuCaptureMs+.1*(nowMs()-captureAt);
                stats.captures=captureBase+pipeline.captures;stats.dropped=dropBase+pipeline.dropped;stats.captureDeliveryMs=pipeline.delivery;
                if(!pipeline.source.texture){
                    if(now-started>settings.captureTimeoutMs)throw std::runtime_error("No capture frame received. Check capture permissions and monitor availability.");
                    wait(5);continue;
                }
                const bool shouldShow=options.preview||angle<settings.referenceAngle;
                if(shouldShow!=shown){PostMessageW(window,WM_GLASS_VISIBILITY,shouldShow,0);shown=shouldShow;}
                POINT mouse{};GetCursorPos(&mouse);
                bool nativePointer=pointerUsesControls(options.controls,window,mouse);
                pipeline.cursor->hide(!options.preview&&shouldShow&&!nativePointer&&PtInRect(&options.monitor.rect,mouse));
                if(life.state!=State::Active){life.transition(State::Active);stats.message=options.synthetic?L"Synthetic moving pattern":L"Live capture; input unchanged";publish();}
                double cap=std::min(settings.maxFps,options.monitor.hz),period=1000/cap;
                double ratio=options.monitor.hz/cap;UINT sync=static_cast<UINT>(std::clamp(std::round(ratio),1.,4.));
                bool integral=std::abs(ratio-sync)<.01;
                // Vsync already paces native refresh and integer divisors. An extra sleep here loses refreshes.
                double pacingAt=nowMs();if(pipeline.frameWait)WaitForSingleObject(pipeline.frameWait,50);
                if(!integral){double remaining=lastFrame+period-nowMs();if(remaining>1)wait(remaining);sync=1;}
                stats.pacingWaitMs=.9*stats.pacingWaitMs+.1*(nowMs()-pacingAt);
                if(stop.stop_requested())break;
                double frameAt=nowMs();if(lastFrame)frameTimes.push_back(frameAt-lastFrame);lastFrame=frameAt;
                value=options.benchmark&&measureStart>0?benchmarkSweep.sample(frameAt):(source?source->sample(frameAt):AngleSample{});
                if(value.valid&&std::isfinite(value.angle)&&(value.fresh||!haveAngle)){angle=value.angle;haveAngle=true;}stats.angle=angle;stats.fresh=value.fresh;
                GetCursorPos(&mouse);nativePointer=pointerUsesControls(options.controls,window,mouse);
                pipeline.cursor->hide(!options.preview&&shouldShow&&!nativePointer&&PtInRect(&options.monitor.rect,mouse));
                double renderAt=nowMs();pipeline.render(settings,angle,options.monitor,(frameAt-totalStart)/1000,sync,nativePointer);++stats.renders;
                stats.cpuRenderMs=.9*stats.cpuRenderMs+.1*(nowMs()-renderAt);stats.cpuCursorMs=.9*stats.cpuCursorMs+.1*pipeline.cursorMs;stats.presentWaitMs=.9*stats.presentWaitMs+.1*pipeline.presentMs;
                double gpu=pipeline.collect();if(gpu>=0){stats.gpuMs=gpu;gpuTimes.push_back(gpu);}
                DXGI_FRAME_STATISTICS fs{};if(SUCCEEDED(pipeline.swap->GetFrameStatistics(&fs))){stats.presentStatsAvailable=true;stats.presents=presentBase+fs.PresentCount;}
                if(!firstFrameAt)firstFrameAt=frameAt;
                if(options.benchmark&&!measureStart&&frameAt-firstFrameAt>=2000){
                    measureStart=frameAt;warmRenders=stats.renders;warmPresents=stats.presents;warmCaptures=captureBase+pipeline.captures;
                    gpuTimes.clear();frameTimes.clear();benchmarkSweep.start(frameAt,settings.referenceAngle,0,options.durationSeconds);
                }
                stats.frameAgeMs=std::max(0.,qpcMs()-pipeline.captureTime);
                if(frameAt-lastPublish>=500){double seconds=(frameAt-lastPublish)/1000;
                    stats.captureFps=(pipeline.captures-lastCaptures)/seconds;stats.renderFps=(stats.renders-lastRenders)/seconds;stats.presentFps=(stats.presents-lastPresents)/seconds;
                    stats.p95GpuMs=percentile(gpuTimes,.95);stats.p99FrameMs=percentile(frameTimes,.99);publish();
                    lastPublish=frameAt;lastCaptures=pipeline.captures;lastRenders=stats.renders;lastPresents=stats.presents;
                    if(gpuTimes.size()>15000)gpuTimes.erase(gpuTimes.begin(),gpuTimes.begin()+7500);if(frameTimes.size()>15000)frameTimes.erase(frameTimes.begin(),frameTimes.begin()+7500);
                }
                if(frameAt-started>10000)failures=0;
                double timingStart=options.benchmark?measureStart:totalStart;
                if(options.durationSeconds>0&&timingStart>0&&frameAt-timingStart>=options.durationSeconds*1000){
                    stats.captures=captureBase+pipeline.captures;stats.p95GpuMs=percentile(gpuTimes,.95);stats.p99FrameMs=percentile(frameTimes,.99);
                    if(options.synthetic&&!options.report.empty()){auto imagePath=options.report;imagePath.replace_extension(L".png");pipeline.snapshot(imagePath);}
                    auto measured=stats;measured.renders-=warmRenders;measured.presents-=warmPresents;measured.captures-=warmCaptures;
                    writeReport(options.report,measured,options,settings,(frameAt-timingStart)/1000);SetThreadExecutionState(ES_CONTINUOUS);
                    PostMessageW(options.controls,WM_CLOSE,0,0);return;
                }
            }
            pipeline.cursor->hide(false);PostMessageW(window,WM_GLASS_VISIBILITY,FALSE,0);SetThreadExecutionState(ES_CONTINUOUS);
            if(!stop.stop_requested())life.transition(suspended_?State::Suspended:State::Recovering);
        }catch(const hresult_error& e){stats.message=e.message().c_str();life.transition(State::Recovering);}
        catch(const std::exception& e){stats.message=to_hstring(e.what()).c_str();life.transition(State::Recovering);}
        SetThreadExecutionState(ES_CONTINUOUS);PostMessageW(window,WM_GLASS_VISIBILITY,FALSE,0);
        if(life.state==State::Recovering){if(++failures>=3){life.transition(State::Faulted);publish();writeReport(options.report,stats,options,settings,(nowMs()-totalStart)/1000);break;}publish();wait(settings.retryMs*failures);}
    }
    PostMessageW(window,WM_GLASS_VISIBILITY,FALSE,0);SetThreadExecutionState(ES_CONTINUOUS);publish();
}
}
