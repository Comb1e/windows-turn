#include "window_layer.h"
#include <commctrl.h>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace hinge;
namespace {
int checks=0;
void check(bool okay,const char* message){++checks;if(!okay)throw std::runtime_error(message);}
struct Windows {
    std::vector<HWND> handles;
    ~Windows(){for(auto it=handles.rbegin();it!=handles.rend();++it)if(IsWindow(*it))DestroyWindow(*it);}
    HWND make(const wchar_t* type,DWORD ex,DWORD style,int x,int y,int w,int h,HWND owner=nullptr){
        HWND hwnd=CreateWindowExW(ex,type,L"Hinge window regression fixture",style,x,y,w,h,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
        check(hwnd!=nullptr,"Cannot create native test window");handles.push_back(hwnd);return hwnd;
    }
};
void pump(){MSG msg{};while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}}
}
int main(){try{
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    INITCOMMONCONTROLSEX cc{sizeof(cc),ICC_BAR_CLASSES};InitCommonControlsEx(&cc);Windows windows;
    auto controls=windows.make(L"STATIC",WS_EX_TOOLWINDOW,WS_POPUP,30,30,340,220);
    auto slider=windows.make(TRACKBAR_CLASSW,0,WS_CHILD|WS_VISIBLE,20,30,250,40,controls);
    SendMessageW(slider,TBM_SETRANGE,TRUE,MAKELPARAM(0,1800));
    ShowWindow(controls,SW_SHOWNOACTIVATE);
    auto overlay=windows.make(L"STATIC",WS_EX_TOOLWINDOW|WS_EX_TOPMOST|WS_EX_NOACTIVATE|WS_EX_LAYERED|WS_EX_TRANSPARENT,WS_POPUP,0,0,400,280,
        renderWindowOwner(controls,false));
    SetLayeredWindowAttributes(overlay,0,255,LWA_ALPHA);ShowWindow(overlay,SW_SHOWNOACTIVATE);pump();
    HWND foreground=GetForegroundWindow();
    keepControlsAccessible(controls,overlay,true);
    check(GetWindow(overlay,GW_OWNER)==nullptr,"Full-screen overlay still owned by controls");
    check(windowAbove(controls,overlay),"Debug controls are behind the full-screen overlay");
    check(GetForegroundWindow()==foreground,"Restacking stole foreground focus");
    check((GetWindowLongPtrW(controls,GWL_EXSTYLE)&WS_EX_TOPMOST)!=0,"Controls were not pinned during full-screen rendering");
    check(SetWindowDisplayAffinity(controls,WDA_EXCLUDEFROMCAPTURE)!=FALSE,"Control capture exclusion failed");
    check(SetWindowDisplayAffinity(overlay,WDA_EXCLUDEFROMCAPTURE)!=FALSE,"Overlay capture exclusion failed");
    DWORD affinity=0;GetWindowDisplayAffinity(controls,&affinity);check(affinity==WDA_EXCLUDEFROMCAPTURE,"Restacking changed capture exclusion");
    RECT sliderRect{};GetWindowRect(slider,&sliderRect);POINT sliderPoint{(sliderRect.left+sliderRect.right)/2,(sliderRect.top+sliderRect.bottom)/2};
    check(pointerUsesControls(controls,overlay,sliderPoint),"Slider has no native pointer");
    check(!pointerUsesControls(controls,overlay,{390,270}),"Effect area incorrectly treated as controls");
    SendMessageW(slider,TBM_SETPOS,TRUE,400);check(SendMessageW(slider,TBM_GETPOS,0,0)==400,"Slider not operable above effect");
    SetCapture(slider);check(pointerUsesControls(controls,overlay,{-1000,-1000}),"Pointer lost while dragging outside controls");ReleaseCapture();
    // Re-show/recovery is the old failing case: the effect moves to the top again.
    for(int i=0;i<3;++i){ShowWindow(overlay,SW_HIDE);keepControlsAccessible(controls,overlay,false);
        check(!(GetWindowLongPtrW(controls,GWL_EXSTYLE)&WS_EX_TOPMOST),"Controls remain topmost when effect is hidden");
        ShowWindow(overlay,SW_SHOWNOACTIVATE);SetWindowPos(overlay,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
        keepControlsAccessible(controls,overlay,true);check(windowAbove(controls,overlay),"Controls lost after effect re-show");}
    ShowWindow(controls,SW_MINIMIZE);pump();keepControlsAccessible(controls,overlay,true);
    check(IsIconic(controls),"Layer update unexpectedly restored minimized controls");
    check(IsWindowVisible(overlay),"Minimizing controls hid the independent effect");
    ShowWindow(controls,SW_SHOWNOACTIVATE);keepControlsAccessible(controls,overlay,true);check(windowAbove(controls,overlay),"Restored controls are covered");
    auto popup=windows.make(L"STATIC",WS_EX_TOOLWINDOW,WS_POPUP,80,80,150,70,controls);ShowWindow(popup,SW_SHOWNOACTIVATE);
    keepControlsAccessible(controls,overlay,true);check(windowAbove(popup,overlay),"Owned dialog is under the effect");
    check(pointerUsesControls(controls,overlay,{90,90}),"Dialog does not use native cursor");ShowWindow(popup,SW_HIDE);
    ShowWindow(overlay,SW_HIDE);keepControlsAccessible(controls,overlay,false);
    auto preview=windows.make(L"STATIC",WS_EX_TOOLWINDOW,WS_POPUP,400,30,150,100,renderWindowOwner(controls,true));
    check(GetWindow(preview,GW_OWNER)==controls,"Preview lost normal ownership");
    check(!(GetWindowLongPtrW(controls,GWL_EXSTYLE)&WS_EX_TOPMOST),"Disable/preview did not release controls topmost flag");
    DestroyWindow(overlay);check(IsWindow(controls),"Destroying effect destroyed controls");
    std::cout<<checks<<" native window checks passed (z-order, focus, pointer, slider, recovery, dialogs, minimize and cleanup)\n";return 0;
}catch(const std::exception& error){std::cerr<<"FAIL after "<<checks<<" checks: "<<error.what()<<"\n";return 1;}}
