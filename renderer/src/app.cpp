#include "graphics.h"
#include "settings.h"
#include "angle.h"
#include "cursor.h"
#include "window_layer.h"
#include <windows.h>
#include <commctrl.h>
#include <wtsapi32.h>
#include <shellapi.h>
#include <winrt/base.h>
#include <sstream>
#include <iomanip>
#include <map>

namespace hinge {
namespace {
constexpr int Manual=100,Source=101,MonitorChoice=102,GpuChoice=103,Slider=104,Status=105;
constexpr int ProjectionChoice=106;
constexpr int Preview=201,Enable=202,Disable=203,CloseSweep=204,OpenSweep=205,Reverse=206,Apply=207,Power=208;
struct Field {int id;const wchar_t* label;double Settings::* member;};
const Field fields[]={
    {Manual,L"Physical angle (degrees)",&Settings::manualAngle},{110,L"Reference angle (degrees)",&Settings::referenceAngle},
    {111,L"Maximum blur (pixels)",&Settings::blurPixels},{112,L"Sweep duration (seconds)",&Settings::sweepSeconds},
    {113,L"Eye distance from hinge (mm)",&Settings::eyeY},{114,L"Eye height above keyboard (mm)",&Settings::eyeZ},
    {115,L"Eye lateral offset (mm)",&Settings::eyeX},{116,L"Maximum frame rate (Hz)",&Settings::maxFps},
    {117,L"Active screen width (mm)",&Settings::screenWidth},{118,L"Active screen height (mm)",&Settings::screenHeight},
    {119,L"Hinge to active display (mm)",&Settings::hingeOffset}
};
struct App {
    HWND controls=nullptr,output=nullptr;HFONT font=nullptr;Settings settings;Renderer renderer;
    std::shared_ptr<IAngleSource> angle;std::vector<Monitor> displays;std::vector<Adapter> gpus;
    std::map<int,HWND> widgets;bool running=false,preview=true,constructing=true,sweepClosing=true,automatic=false,noPreferences=false;
    bool synthetic=false,benchmark=false;double duration=0,deadline=0;int exitCode=0;std::filesystem::path report;float scale=1;
    App(Settings s):settings(s){}
    int px(int n)const{return static_cast<int>(n*scale);}
    HWND widget(const wchar_t* kind,const wchar_t* text,DWORD style,int x,int y,int w,int h,int id){
        HWND handle=CreateWindowExW(kind==std::wstring_view(L"EDIT")?WS_EX_CLIENTEDGE:0,kind,text,WS_CHILD|WS_VISIBLE|style,
            px(x),px(y),px(w),px(h),controls,reinterpret_cast<HMENU>(INT_PTR(id)),GetModuleHandleW(nullptr),nullptr);
        SendMessageW(handle,WM_SETFONT,reinterpret_cast<WPARAM>(font),TRUE);if(id)widgets[id]=handle;return handle;
    }
    void manualSource(){auto manual=std::make_shared<ManualAngle>();manual->angle=settings.manualAngle;angle=manual;}
    void populate(){
        scale=GetDpiForWindow(controls)/96.f;LOGFONTW lf{};lf.lfHeight=-px(14);wcscpy_s(lf.lfFaceName,L"Segoe UI");font=CreateFontIndirectW(&lf);
        widget(L"STATIC",L"Hinge Glass",0,20,14,600,28,0);
        widget(L"STATIC",L"Live desktop on a fixed virtual plane. Ctrl + Alt + F12 immediately disables the effect.",0,20,48,700,36,0);
        widget(L"STATIC",L"Angle source",0,20,92,125,22,0);widget(WC_COMBOBOXW,L"",CBS_DROPDOWNLIST|WS_TABSTOP,150,88,545,120,Source);
        for(auto label:{L"Manual / debug",L"Fusion (current measurement range: 10–120 degrees)"})SendMessageW(widgets[Source],CB_ADDSTRING,0,reinterpret_cast<LPARAM>(label));
        SendMessageW(widgets[Source],CB_SETCURSEL,0,0);
        widget(L"STATIC",L"View mode",0,20,132,125,22,0);widget(WC_COMBOBOXW,L"",CBS_DROPDOWNLIST|WS_TABSTOP,150,128,545,120,ProjectionChoice);
        for(auto label:{L"Slider test only — rotating plane on stationary screen",L"Physical lid — image anchored at the reference angle"})
            SendMessageW(widgets[ProjectionChoice],CB_ADDSTRING,0,reinterpret_cast<LPARAM>(label));
        SendMessageW(widgets[ProjectionChoice],CB_SETCURSEL,settings.projectionMode=="physical"?1:0,0);
        widget(L"STATIC",L"Manual test angle: 0° closed  ←  drag to rotate  →  180° open",0,20,164,675,22,0);
        widget(TRACKBAR_CLASSW,L"",WS_TABSTOP|TBS_AUTOTICKS,20,188,675,38,Slider);
        SendMessageW(widgets[Slider],TBM_SETRANGE,TRUE,MAKELPARAM(0,1800));SendMessageW(widgets[Slider],TBM_SETPOS,TRUE,LPARAM(settings.manualAngle*10));
        SendMessageW(widgets[Slider],TBM_SETTICFREQ,100,0);
        for(size_t i=0;i<std::size(fields);++i){int col=int(i%2),row=int(i/2);int x=20+col*350,y=232+row*56;
            widget(L"STATIC",fields[i].label,0,x,y,320,21,0);std::wostringstream v;v<<settings.*(fields[i].member);
            widget(L"EDIT",v.str().c_str(),WS_TABSTOP|ES_AUTOHSCROLL,x,y+23,320,25,fields[i].id);}
        widget(L"STATIC",L"Display",0,20,569,65,22,0);widget(WC_COMBOBOXW,L"",CBS_DROPDOWNLIST|WS_TABSTOP,90,564,605,170,MonitorChoice);
        displays=monitors();int monitorIndex=0;
        for(size_t i=0;i<displays.size();++i){auto& m=displays[i];std::wostringstream text;text<<m.name<<L"   "<<m.rect.right-m.rect.left<<L" × "<<m.rect.bottom-m.rect.top<<L"   "<<m.hz<<L" Hz"<<(m.hdr?L" HDR":L" SDR");
            SendMessageW(widgets[MonitorChoice],CB_ADDSTRING,0,reinterpret_cast<LPARAM>(text.str().c_str()));if(winrt::to_string(m.name)==settings.monitor)monitorIndex=int(i);}
        SendMessageW(widgets[MonitorChoice],CB_SETCURSEL,monitorIndex,0);
        widget(L"STATIC",L"GPU",0,20,609,65,22,0);widget(WC_COMBOBOXW,L"",CBS_DROPDOWNLIST|WS_TABSTOP,90,604,605,170,GpuChoice);
        SendMessageW(widgets[GpuChoice],CB_ADDSTRING,0,reinterpret_cast<LPARAM>(L"Auto — prefer RTX 4070 when available"));gpus=adapters();int gpuIndex=0;
        for(size_t i=0;i<gpus.size();++i){SendMessageW(widgets[GpuChoice],CB_ADDSTRING,0,reinterpret_cast<LPARAM>(gpus[i].name.c_str()));if(gpus[i].id==settings.adapter)gpuIndex=int(i)+1;}
        SendMessageW(widgets[GpuChoice],CB_SETCURSEL,gpuIndex,0);
        int x=20;for(auto [id,label]:{std::pair{Preview,L"Preview"},{Enable,L"Enable screen"},{Disable,L"Disable"},{Apply,L"Apply / save"}}){widget(L"BUTTON",label,WS_TABSTOP|BS_PUSHBUTTON,x,650,160,32,id);x+=174;}
        x=20;for(auto [id,label]:{std::pair{CloseSweep,L"Close sweep"},{OpenSweep,L"Open sweep"},{Reverse,L"Reverse sweep"},{Power,L"Lid setup"}}){widget(L"BUTTON",label,WS_TABSTOP|BS_PUSHBUTTON,x,692,160,32,id);x+=174;}
        widget(L"STATIC",L"Disabled. Start with Preview, then Enable screen. Viewing geometry uses millimetres.",0,20,740,680,120,Status);
        manualSource();renderer.configure(settings,angle);constructing=false;
    }
    void readControls(bool save){
        Settings candidate=settings;
        candidate.projectionMode=SendMessageW(widgets[ProjectionChoice],CB_GETCURSEL,0,0)==1?"physical":"rotation";
        for(auto& field:fields){wchar_t value[128];GetWindowTextW(widgets[field.id],value,128);wchar_t* end=nullptr;
            double number=wcstod(value,&end);if(end==value||*end)throw std::runtime_error("Enter a valid number for each setting");candidate.*(field.member)=number;}
        auto m=SendMessageW(widgets[MonitorChoice],CB_GETCURSEL,0,0);if(m<0||size_t(m)>=displays.size())throw std::runtime_error("Select an available monitor");candidate.monitor=winrt::to_string(displays[m].name);
        auto gpu=SendMessageW(widgets[GpuChoice],CB_GETCURSEL,0,0);candidate.adapter=gpu>0&&size_t(gpu)<=gpus.size()?gpus[gpu-1].id:"auto";
        candidate.validate();bool restart=candidate.adapter!=settings.adapter||candidate.monitor!=settings.monitor;
        settings=candidate;if(save&&!noPreferences)saveSettings(settings);
        if(SendMessageW(widgets[Source],CB_GETCURSEL,0,0)==0&&dynamic_cast<ManualAngle*>(angle.get()))manualSource();
        renderer.configure(settings,angle);SendMessageW(widgets[Slider],TBM_SETPOS,TRUE,LPARAM(settings.manualAngle*10));
        if(restart&&running)start(preview);
    }
    Monitor selected(){auto i=SendMessageW(widgets[MonitorChoice],CB_GETCURSEL,0,0);if(i<0||size_t(i)>=displays.size())throw std::runtime_error("No monitor available");return displays[i];}
    void updateControlLayer(){keepControlsAccessible(controls,output,running&&!preview&&IsWindowVisible(output));}
    void disable(){running=false;renderer.stop();if(output)ShowWindow(output,SW_HIDE);updateControlLayer();}
    void start(bool inPreview){
        disable();preview=inPreview;readControls(false);auto monitor=selected();
        if(output){DestroyWindow(output);output=nullptr;}
        DWORD ex=WS_EX_TOOLWINDOW|WS_EX_NOREDIRECTIONBITMAP;
        DWORD style=WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU;
        auto previewSize=fitPreview(monitor.rect.right-monitor.rect.left,monitor.rect.bottom-monitor.rect.top);
        int x=monitor.rect.left+px(760),y=monitor.rect.top+px(40),w=previewSize.width,h=previewSize.height;
        if(!preview){ex|=WS_EX_NOACTIVATE|WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOPMOST;style=WS_POPUP;x=monitor.rect.left;y=monitor.rect.top;w=monitor.rect.right-x;h=monitor.rect.bottom-y;}
        else{RECT client{0,0,w,h};AdjustWindowRectEx(&client,style,FALSE,ex);w=client.right-client.left;h=client.bottom-client.top;
            x=std::max<int>(monitor.rect.left,std::min<int>(x,monitor.rect.right-w));}
        output=CreateWindowExW(ex,L"HingeGlassOutput",preview?L"Hinge Glass — preview":L"Hinge Glass — screen effect",style,x,y,w,h,
            renderWindowOwner(controls,preview),nullptr,GetModuleHandleW(nullptr),this);
        if(!output)winrt::throw_last_error();
        if(!preview&&!SetLayeredWindowAttributes(output,0,255,LWA_ALPHA))winrt::throw_last_error();
        if(!SetWindowDisplayAffinity(output,WDA_EXCLUDEFROMCAPTURE))throw std::runtime_error("Cannot exclude output from capture; stopping to prevent feedback");
        renderer.configure(settings,angle);running=true;
        RenderOptions options{monitor,preview,synthetic,duration,report,benchmark,controls};renderer.start(output,options);
    }
    void sweep(bool closing){
        readControls(false);auto current=angle->sample(nowMs());double from=current.valid?current.angle:settings.manualAngle;
        auto sweep=std::make_shared<SweepAngle>();sweep->start(nowMs(),from,closing?0:settings.referenceAngle,settings.sweepSeconds);
        angle=sweep;sweepClosing=closing;SendMessageW(widgets[Source],CB_SETCURSEL,0,0);renderer.configure(settings,angle);
    }
    void status(){
        updateControlLayer();
        auto t=renderer.status();std::wostringstream text;text<<stateName(t.state)<<L" · "<<std::fixed<<std::setprecision(1)<<t.angle<<L"° · "<<(t.fresh?L"live angle":L"angle stale / held")<<L"\r\n";
        text<<(t.adapter.empty()?L"GPU not started":t.adapter)<<L" · display "<<t.refreshHz<<L" Hz · "<<(t.hdr?L"HDR / scRGB":L"SDR")<<L"\r\n";
        text<<L"Capture "<<t.captureFps<<L" fps · render "<<t.renderFps<<L" fps · presented ";
        if(t.presentStatsAvailable)text<<t.presentFps<<L" fps";else text<<L"unavailable";
        text<<L"\r\nGPU "<<t.gpuMs<<L" ms · frame age "<<t.frameAgeMs<<L" ms · capture delivery "<<t.captureDeliveryMs<<L" ms · dropped "<<t.dropped<<L"\r\n";
        if(auto fusion=dynamic_cast<FusionAngle*>(angle.get()))text<<winrt::to_hstring(fusion->status()).c_str();else text<<t.message;
        SetWindowTextW(widgets[Status],text.str().c_str());
        if(automatic&&(t.state==State::Faulted||nowMs()>deadline)){exitCode=t.state==State::Faulted||t.renders==0?1:0;PostMessageW(controls,WM_CLOSE,0,0);}
    }
    void error(const std::wstring& message){SetWindowTextW(widgets[Status],message.c_str());}
};
LRESULT CALLBACK outputProc(HWND hwnd,UINT message,WPARAM w,LPARAM l){
    auto app=reinterpret_cast<App*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
    if(message==WM_NCCREATE){app=static_cast<App*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(app));}
    if(app)switch(message){
    case WM_GLASS_VISIBILITY:ShowWindow(hwnd,w&&app->running?SW_SHOWNOACTIVATE:SW_HIDE);app->updateControlLayer();return 0;
    case WM_MOUSEACTIVATE:if(!app->preview)return MA_NOACTIVATE;break;
    case WM_NCHITTEST:if(!app->preview)return HTTRANSPARENT;break;
    case WM_CLOSE:app->disable();return 0;
    case WM_ERASEBKGND:return 1;
    }
    return DefWindowProcW(hwnd,message,w,l);
}
LRESULT CALLBACK controlProc(HWND hwnd,UINT message,WPARAM w,LPARAM l){
    auto app=reinterpret_cast<App*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
    if(message==WM_NCCREATE){app=static_cast<App*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);app->controls=hwnd;SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(app));}
    if(app)try{switch(message){
    case WM_CREATE:app->populate();SetTimer(hwnd,1,250,nullptr);return 0;
    case WM_TIMER:app->status();return 0;
    case WM_HOTKEY:app->disable();return 0;
    case WM_HSCROLL:
        if(reinterpret_cast<HWND>(l)==app->widgets[Slider]){
            app->settings.manualAngle=SendMessageW(app->widgets[Slider],TBM_GETPOS,0,0)/10.;std::wostringstream text;text<<app->settings.manualAngle;
            SetWindowTextW(app->widgets[Manual],text.str().c_str());SendMessageW(app->widgets[Source],CB_SETCURSEL,0,0);
            app->manualSource();app->renderer.configure(app->settings,app->angle);
        }return 0;
    case WM_COMMAND:{int id=LOWORD(w),notification=HIWORD(w);if(app->constructing)return 0;
        if(notification==EN_KILLFOCUS){app->readControls(false);if(id==Manual){SendMessageW(app->widgets[Source],CB_SETCURSEL,0,0);app->manualSource();app->renderer.configure(app->settings,app->angle);}return 0;}
        if(id==Source&&notification==CBN_SELCHANGE){
            if(SendMessageW(app->widgets[Source],CB_GETCURSEL,0,0)==1)app->angle=std::make_shared<FusionAngle>(app->settings);else app->manualSource();
            app->renderer.configure(app->settings,app->angle);return 0;
        }
        if(id==ProjectionChoice&&notification==CBN_SELCHANGE){app->readControls(false);return 0;}
        if(notification!=BN_CLICKED)return 0;
        switch(id){case Preview:app->start(true);break;case Enable:app->start(false);break;case Disable:app->disable();break;
        case CloseSweep:app->sweep(true);break;case OpenSweep:app->sweep(false);break;case Reverse:app->sweep(!app->sweepClosing);break;case Apply:app->readControls(true);break;
        case Power:MessageBoxW(hwnd,L"To continue operating when closing the lid:\n\n1. Open Control Panel > Power Options > Choose what closing the lid does.\n2. Select Do nothing for the power modes you intend to use.\n3. Test a slow closure and reopen. Some firmware still powers down the internal panel.\n\nHinge Glass prevents idle sleep only while enabled. It does not change your power plan or override explicit sleep.\n\nWhen Windows disables the panel, visible rendering cannot continue; the renderer reconnects on resume.",L"Closed-lid operation",MB_OK|MB_ICONINFORMATION);break;}
        return 0;}
    case WM_DISPLAYCHANGE:app->renderer.recover();return 0;
    case WM_WTSSESSION_CHANGE:if(w==WTS_SESSION_LOCK)app->renderer.suspend(true);else if(w==WTS_SESSION_UNLOCK)app->renderer.suspend(false);return 0;
    case WM_POWERBROADCAST:if(w==PBT_APMSUSPEND)app->renderer.suspend(true);else if(w==PBT_APMRESUMEAUTOMATIC||w==PBT_APMRESUMESUSPEND)app->renderer.suspend(false);return TRUE;
    case WM_CLOSE:app->disable();if(app->output){DestroyWindow(app->output);app->output=nullptr;}DestroyWindow(hwnd);return 0;
    case WM_DESTROY:KillTimer(hwnd,1);UnregisterHotKey(hwnd,1);WTSUnRegisterSessionNotification(hwnd);if(app->font)DeleteObject(app->font);PostQuitMessage(app->exitCode);return 0;
    }}catch(const winrt::hresult_error& e){app->error(e.message().c_str());}catch(const std::exception& e){app->error(winrt::to_hstring(e.what()).c_str());}
    return DefWindowProcW(hwnd,message,w,l);
}
}
int runApplication(){
    int count=0;LPWSTR* argv=CommandLineToArgvW(GetCommandLineW(),&count);
    if(count>=5&&std::wstring_view(argv[1])==L"--cursor-guardian"){
        int result=cursorGuardian(wcstoul(argv[2],nullptr,10),argv[3],std::wstring_view(argv[4])==L"1");LocalFree(argv);return result;}
    winrt::init_apartment(winrt::apartment_type::single_threaded);SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    std::filesystem::path config=executableDirectory()/L"config.json";bool noPreferences=false;
    for(int i=1;i<count;++i){if(std::wstring_view(argv[i])==L"--config"&&i+1<count)config=argv[++i];else if(std::wstring_view(argv[i])==L"--no-preferences")noPreferences=true;}
    App app(loadSettings(config,!noPreferences));app.noPreferences=noPreferences;bool startPreview=true,openPreview=false;
    for(int i=1;i<count;++i){std::wstring_view a=argv[i];
        if(a==L"--smoke"||a==L"--benchmark"){app.automatic=true;app.benchmark=a==L"--benchmark";app.duration=app.benchmark?60:8;}
        else if(a==L"--synthetic")app.synthetic=true;
        else if(a==L"--overlay")startPreview=false;
        else if(a==L"--seconds"&&i+1<count)app.duration=wcstod(argv[++i],nullptr);
        else if(a==L"--report"&&i+1<count)app.report=argv[++i];
        else if(a==L"--fps"&&i+1<count)app.settings.maxFps=wcstod(argv[++i],nullptr);
        else if(a==L"--angle"&&i+1<count)app.settings.manualAngle=wcstod(argv[++i],nullptr);
        else if(a==L"--projection"&&i+1<count)app.settings.projectionMode=winrt::to_string(argv[++i]);
        else if(a==L"--preview")openPreview=true;
    }
    LocalFree(argv);app.settings.validate();INITCOMMONCONTROLSEX cc{sizeof(cc),ICC_BAR_CLASSES|ICC_STANDARD_CLASSES};InitCommonControlsEx(&cc);
    WNDCLASSEXW wc{sizeof(wc)};wc.hInstance=GetModuleHandleW(nullptr);wc.lpfnWndProc=controlProc;wc.lpszClassName=L"HingeGlassControls";
    wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);wc.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);RegisterClassExW(&wc);
    wc.lpfnWndProc=outputProc;wc.lpszClassName=L"HingeGlassOutput";wc.hbrBackground=nullptr;RegisterClassExW(&wc);
    float dpi=GetDpiForSystem()/96.f;HWND window=CreateWindowExW(0,L"HingeGlassControls",L"Hinge Glass 0.1.3 — live hinge animation",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,
        CW_USEDEFAULT,CW_USEDEFAULT,int(740*dpi),int(922*dpi),nullptr,nullptr,GetModuleHandleW(nullptr),&app);
    if(!window)winrt::throw_last_error();if(!SetWindowDisplayAffinity(window,WDA_EXCLUDEFROMCAPTURE))throw std::runtime_error("Cannot exclude controls from screen capture");
    if(!RegisterHotKey(window,1,MOD_CONTROL|MOD_ALT|MOD_NOREPEAT,VK_F12))throw std::runtime_error("Ctrl+Alt+F12 is already registered. Close the conflicting app before enabling Hinge Glass.");
    WTSRegisterSessionNotification(window,NOTIFY_FOR_THIS_SESSION);ShowWindow(window,SW_SHOWNORMAL);
    if(app.automatic){app.deadline=nowMs()+(app.duration+25)*1000;app.start(startPreview);}
    else if(openPreview)app.start(true);
    MSG msg{};while(GetMessageW(&msg,nullptr,0,0)>0){if(!IsDialogMessageW(window,&msg)){TranslateMessage(&msg);DispatchMessageW(&msg);}}
    return int(msg.wParam);
}
}
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int){try{return hinge::runApplication();}
catch(const winrt::hresult_error& e){MessageBoxW(nullptr,e.message().c_str(),L"Hinge Glass startup failed",MB_OK|MB_ICONERROR);return 1;}
catch(const std::exception& e){MessageBoxW(nullptr,winrt::to_hstring(e.what()).c_str(),L"Hinge Glass startup failed",MB_OK|MB_ICONERROR);return 1;}}
