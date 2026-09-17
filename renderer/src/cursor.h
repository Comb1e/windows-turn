#pragma once
#include <windows.h>
#include <d3d11.h>
#include <winrt/base.h>
#include <array>
namespace hinge {
int cursorGuardian(DWORD parent,const wchar_t* readyName,bool originalVisible);
class CursorLayer {
    winrt::com_ptr<ID3D11Device> device_;
    HCURSOR previous_=nullptr;
    bool hidden_=false,originalVisible_=true;
    HANDLE guardian_=nullptr;
    UINT width_=1,height_=1,hotX_=0,hotY_=0;
    bool load(HCURSOR cursor);
    void ensureGuardian();
public:
    winrt::com_ptr<ID3D11ShaderResourceView> color,mask;
    std::array<float,4> rectangle{};
    bool visible=false;
    explicit CursorLayer(ID3D11Device* device);
    ~CursorLayer();
    void update(const RECT& monitor);
    void hide(bool hidden);
};
}
