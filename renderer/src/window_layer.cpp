#include "window_layer.h"

namespace hinge {
HWND renderWindowOwner(HWND controls,bool preview){return preview?controls:nullptr;}
bool windowAbove(HWND upper,HWND lower){
    if(!upper||!lower||upper==lower)return false;
    for(HWND current=GetWindow(lower,GW_HWNDPREV);current;current=GetWindow(current,GW_HWNDPREV))
        if(current==upper)return true;
    return false;
}
void keepControlsAccessible(HWND controls,HWND output,bool fullScreenVisible){
    if(!IsWindow(controls))return;
    bool topmost=(GetWindowLongPtrW(controls,GWL_EXSTYLE)&WS_EX_TOPMOST)!=0;
    const UINT flags=SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER;
    if(fullScreenVisible&&IsWindowVisible(output)){
        if(!topmost||(!IsIconic(controls)&&!windowAbove(controls,output)))
            SetWindowPos(controls,HWND_TOPMOST,0,0,0,0,flags);
    }else if(topmost){
        SetWindowPos(controls,HWND_NOTOPMOST,0,0,0,0,flags);
    }
}
bool pointerUsesControls(HWND controls,HWND output,POINT point){
    if(!IsWindow(controls)||!IsWindowVisible(controls)||IsIconic(controls))return false;
    auto isControlWindow=[&](HWND window){
        if(!window||window==output||IsChild(output,window))return false;
        return window==controls||IsChild(controls,window)||GetAncestor(window,GA_ROOTOWNER)==controls;
    };
    // Retain the native pointer during slider/window drags beyond the panel edge.
    GUITHREADINFO info{sizeof(info)};
    if(GetGUIThreadInfo(GetWindowThreadProcessId(controls,nullptr),&info)&&isControlWindow(info.hwndCapture))return true;
    HWND hit=WindowFromPoint(point);
    if(isControlWindow(hit))return true;
    // Popup combo lists and menus may use their own top-level owner relationship.
    return hit&&hit!=output&&GetWindowThreadProcessId(hit,nullptr)==GetWindowThreadProcessId(controls,nullptr);
}
}
