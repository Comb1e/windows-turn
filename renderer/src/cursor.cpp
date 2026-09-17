#include "cursor.h"
#include "settings.h"
#include <magnification.h>
#include <vector>
#include <stdexcept>
namespace hinge {
namespace {
// One guardian for the application lifetime, shared across capture/device restarts.
struct GuardianHandle {HANDLE value=nullptr;~GuardianHandle(){if(value)CloseHandle(value);}};
GuardianHandle guardianHandle;
}
int cursorGuardian(DWORD parent,const wchar_t* readyName,bool original){
    HANDLE process=OpenProcess(SYNCHRONIZE,FALSE,parent),ready=OpenEventW(EVENT_MODIFY_STATE,FALSE,readyName);
    if(!process||!ready||!MagInitialize())return 2;
    SetEvent(ready);CloseHandle(ready);WaitForSingleObject(process,INFINITE);
    MagShowSystemCursor(original);MagUninitialize();CloseHandle(process);return 0;
}
CursorLayer::CursorLayer(ID3D11Device* device){device_.copy_from(device);if(!MagInitialize())throw std::runtime_error("Cannot initialize cursor visibility API");}
CursorLayer::~CursorLayer(){hide(false);MagUninitialize();}
void CursorLayer::ensureGuardian(){
    guardian_=guardianHandle.value;
    if(guardian_){if(WaitForSingleObject(guardian_,0)!=WAIT_TIMEOUT)throw std::runtime_error("Cursor recovery guardian stopped");return;}
    std::wstring name=L"Local\\HingeGlassCursor"+std::to_wstring(GetCurrentProcessId());
    HANDLE ready=CreateEventW(nullptr,TRUE,FALSE,name.c_str());if(!ready)throw std::runtime_error("Cannot create cursor guardian event");
    std::wstring cmd=L"\""+(executableDirectory()/L"HingeGlass.exe").wstring()+L"\" --cursor-guardian "+std::to_wstring(GetCurrentProcessId())+L" "+name+L" "+(originalVisible_?L"1":L"0");
    STARTUPINFOW si{sizeof(si)};si.dwFlags=STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;PROCESS_INFORMATION pi{};
    bool okay=CreateProcessW(nullptr,cmd.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&si,&pi)!=FALSE;
    if(okay){CloseHandle(pi.hThread);guardian_=pi.hProcess;guardianHandle.value=guardian_;okay=WaitForSingleObject(ready,3000)==WAIT_OBJECT_0;}
    CloseHandle(ready);if(!okay)throw std::runtime_error("Cursor guardian could not start; effect not enabled");
}
void CursorLayer::hide(bool hidden){
    if(hidden==hidden_)return;
    if(hidden){ensureGuardian();if(!MagShowSystemCursor(FALSE))throw std::runtime_error("Cannot hide duplicate system cursor");}
    else MagShowSystemCursor(originalVisible_);
    hidden_=hidden;
}
bool CursorLayer::load(HCURSOR cursor){
    ICONINFO info{};if(!GetIconInfo(cursor,&info))return false;
    struct Cleanup{ICONINFO& i;~Cleanup(){if(i.hbmColor)DeleteObject(i.hbmColor);if(i.hbmMask)DeleteObject(i.hbmMask);}} cleanup{info};
    BITMAP bm{};GetObjectW(info.hbmColor?info.hbmColor:info.hbmMask,sizeof(bm),&bm);
    width_=static_cast<UINT>(bm.bmWidth);height_=static_cast<UINT>(info.hbmColor?bm.bmHeight:bm.bmHeight/2);
    if(!width_||!height_||width_>512||height_>512)return false;
    hotX_=info.xHotspot;hotY_=info.yHotspot;
    auto pixels=[&](HBITMAP bitmap,UINT h){
        std::vector<unsigned char> result(width_*h*4);BITMAPINFO bi{};bi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
        bi.bmiHeader.biWidth=static_cast<LONG>(width_);bi.bmiHeader.biHeight=-static_cast<LONG>(h);bi.bmiHeader.biPlanes=1;bi.bmiHeader.biBitCount=32;bi.bmiHeader.biCompression=BI_RGB;
        HDC dc=GetDC(nullptr);int rows=GetDIBits(dc,bitmap,0,h,result.data(),&bi,DIB_RGB_COLORS);ReleaseDC(nullptr,dc);
        if(!rows)throw std::runtime_error("Cannot read cursor shape");return result;
    };
    auto maskPixels=pixels(info.hbmMask,info.hbmColor?height_:height_*2);
    auto colors=info.hbmColor?pixels(info.hbmColor,height_):std::vector<unsigned char>(width_*height_*4);
    std::vector<unsigned char> masks(width_*height_*4,0);bool hasAlpha=false;
    for(size_t i=3;i<colors.size();i+=4)if(colors[i]){hasAlpha=true;break;}
    for(size_t i=0;i<colors.size();i+=4){
        if(info.hbmColor){std::swap(colors[i],colors[i+2]);
            if(hasAlpha&&colors[i+3])for(int c=0;c<3;++c)colors[i+c]=static_cast<unsigned char>(std::min(255,colors[i+c]*255/colors[i+3]));
        }else{for(int c=0;c<3;++c)colors[i+c]=maskPixels[colors.size()+i];}
        masks[i]=maskPixels[i];masks[i+1]=hasAlpha?0:255;
    }
    auto texture=[&](const std::vector<unsigned char>& bytes,winrt::com_ptr<ID3D11ShaderResourceView>& srv){
        D3D11_TEXTURE2D_DESC desc{};desc.Width=width_;desc.Height=height_;desc.MipLevels=1;desc.ArraySize=1;desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
        desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_IMMUTABLE;desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA data{bytes.data(),width_*4,0};winrt::com_ptr<ID3D11Texture2D> tex;
        winrt::check_hresult(device_->CreateTexture2D(&desc,&data,tex.put()));srv=nullptr;winrt::check_hresult(device_->CreateShaderResourceView(tex.get(),nullptr,srv.put()));
    };
    texture(colors,color);texture(masks,mask);return true;
}
void CursorLayer::update(const RECT& monitor){
    CURSORINFO info{sizeof(info)};visible=false;
    if(!GetCursorInfo(&info)||!(info.flags&CURSOR_SHOWING)||!info.hCursor)return;
    if(!PtInRect(&monitor,info.ptScreenPos))return;
    // Animated handles may retain identity; reload periodically to update their image.
    static thread_local double nextShape=0;double now=nowMs();
    if(info.hCursor!=previous_||now>=nextShape){if(!load(info.hCursor))return;previous_=info.hCursor;nextShape=now+100;}
    float w=static_cast<float>(monitor.right-monitor.left),h=static_cast<float>(monitor.bottom-monitor.top);
    rectangle={static_cast<float>(info.ptScreenPos.x-monitor.left-static_cast<LONG>(hotX_))/w,
        static_cast<float>(info.ptScreenPos.y-monitor.top-static_cast<LONG>(hotY_))/h,width_/w,height_/h};visible=true;
}
}
