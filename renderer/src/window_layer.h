#pragma once
#include <windows.h>

namespace hinge {
// Preview windows may be owned by the controls. A full-screen effect must not
// be: Windows always places owned windows above their owner.
HWND renderWindowOwner(HWND controls,bool preview);
bool windowAbove(HWND upper,HWND lower);
void keepControlsAccessible(HWND controls,HWND output,bool fullScreenVisible);
bool pointerUsesControls(HWND controls,HWND output,POINT point);
}
