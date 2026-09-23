#include "core.h"
#include "shader_parameters.h"
#include <d3d11.h>
#include <d3dcompiler.h>
#include <winrt/base.h>
#include <filesystem>
#include <iostream>
#include <numbers>
#include <span>
using namespace hinge;
using namespace winrt;
namespace {
int assertions=0;
void check(bool ok,const char* message){++assertions;if(!ok)throw std::runtime_error(message);}
struct Pixel {float r,g,b,a;};
struct Image {
    com_ptr<ID3D11Texture2D> texture;com_ptr<ID3D11RenderTargetView> target;com_ptr<ID3D11ShaderResourceView> view;
    UINT width,height;
};
class Gpu {
public:
    com_ptr<ID3D11Device> device;com_ptr<ID3D11DeviceContext> context;
    com_ptr<ID3D11VertexShader> vertex;com_ptr<ID3D11PixelShader> warp,blur,composite;
    com_ptr<ID3D11Buffer> buffer;com_ptr<ID3D11SamplerState> sampler;
    Gpu(){
        // Deterministic offscreen shader correctness; hardware timing is measured
        // separately with the application and its explicit 60 fps test cap.
        check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,0,nullptr,0,D3D11_SDK_VERSION,device.put(),nullptr,context.put()));
        wchar_t executable[32768];GetModuleFileNameW(nullptr,executable,32768);
        auto file=std::filesystem::path(executable).parent_path()/L"glass.hlsl";
        auto compile=[&](const char* name,const char* profile){com_ptr<ID3DBlob> code,errors;
            HRESULT result=D3DCompileFromFile(file.c_str(),nullptr,nullptr,name,profile,D3DCOMPILE_OPTIMIZATION_LEVEL3,0,code.put(),errors.put());
            if(FAILED(result))throw std::runtime_error(errors?static_cast<const char*>(errors->GetBufferPointer()):"Shader compile failed");return code;};
        auto code=compile("VS","vs_5_0");check_hresult(device->CreateVertexShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,vertex.put()));
        auto pixel=[&](const char* name,com_ptr<ID3D11PixelShader>& out){auto c=compile(name,"ps_5_0");check_hresult(device->CreatePixelShader(c->GetBufferPointer(),c->GetBufferSize(),nullptr,out.put()));};
        pixel("Warp",warp);pixel("Blur",blur);pixel("Composite",composite);
        D3D11_BUFFER_DESC b{};b.ByteWidth=sizeof(ShaderParameters);b.Usage=D3D11_USAGE_DEFAULT;b.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        check_hresult(device->CreateBuffer(&b,nullptr,buffer.put()));
        D3D11_SAMPLER_DESC s{};s.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;s.AddressU=s.AddressV=s.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;s.MaxLOD=D3D11_FLOAT32_MAX;
        check_hresult(device->CreateSamplerState(&s,sampler.put()));
    }
    Image image(UINT w,UINT h,std::span<const Pixel> data={}){
        Image result{{},{},{},w,h};D3D11_TEXTURE2D_DESC d{};d.Width=w;d.Height=h;d.MipLevels=d.ArraySize=1;d.SampleDesc.Count=1;
        d.Format=DXGI_FORMAT_R32G32B32A32_FLOAT;d.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA initial{data.data(),w*sizeof(Pixel),0};
        check_hresult(device->CreateTexture2D(&d,data.empty()?nullptr:&initial,result.texture.put()));
        check_hresult(device->CreateRenderTargetView(result.texture.get(),nullptr,result.target.put()));check_hresult(device->CreateShaderResourceView(result.texture.get(),nullptr,result.view.put()));return result;
    }
    void draw(ID3D11PixelShader* shader,Image& output,const ShaderParameters& p,std::array<ID3D11ShaderResourceView*,8> inputs){
        auto target=output.target.get();context->OMSetRenderTargets(1,&target,nullptr);
        D3D11_VIEWPORT viewport{0,0,float(output.width),float(output.height),0,1};context->RSSetViewports(1,&viewport);
        context->UpdateSubresource(buffer.get(),0,nullptr,&p,0,0);auto cb=buffer.get();auto ss=sampler.get();
        context->PSSetConstantBuffers(0,1,&cb);context->PSSetSamplers(0,1,&ss);context->VSSetShader(vertex.get(),nullptr,0);context->PSSetShader(shader,nullptr,0);
        context->PSSetShaderResources(0,8,inputs.data());context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);context->Draw(3,0);
        inputs.fill(nullptr);context->PSSetShaderResources(0,8,inputs.data());context->OMSetRenderTargets(0,nullptr,nullptr);
    }
    std::vector<Pixel> read(const Image& image){
        D3D11_TEXTURE2D_DESC desc{};image.texture->GetDesc(&desc);desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        com_ptr<ID3D11Texture2D> staging;check_hresult(device->CreateTexture2D(&desc,nullptr,staging.put()));context->CopyResource(staging.get(),image.texture.get());
        D3D11_MAPPED_SUBRESOURCE mapped{};check_hresult(context->Map(staging.get(),0,D3D11_MAP_READ,0,&mapped));std::vector<Pixel> pixels(image.width*image.height);
        for(UINT y=0;y<image.height;++y)memcpy(pixels.data()+y*image.width,static_cast<const char*>(mapped.pData)+y*mapped.RowPitch,image.width*sizeof(Pixel));
        context->Unmap(staging.get(),0);return pixels;
    }
};
ShaderParameters parameters(const Settings& s,double angle,UINT w,UINT h){
    ShaderParameters p;auto map=projection(s,angle);
    for(int row=0;row<3;++row)for(int col=0;col<3;++col)p.rows[row][col]=float(map.h[row*3+col]);
    p.sizes[0]=p.sizes[2]=float(w);p.sizes[1]=p.sizes[3]=float(h);
    p.effect[0]=float(glassSeparationAtTop(s,angle));p.effect[1]=float(s.blurPixels);p.effect[3]=1;
    p.frosting[0]=float(s.frostDistanceMm);p.frosting[1]=float(s.frostResponse);std::copy(frostRadii.begin(),frostRadii.end(),p.blurRadii);return p;
}
// Ray intersection and closest rectangle point, independent of the homography
// and sine shortcut supplied to the shader by the production renderer.
double expectedAmount(const Settings& s,double angle,double u,double v){
    if(angle>=s.referenceAngle||s.blurPixels==0)return 0;
    double rad=std::numbers::pi/180;
    double tilt=(s.referenceAngle-angle)*rad;
    Vec3 src{0,std::cos(tilt),std::sin(tilt)},dst{0,1,0},eye{0,s.screenHeight/2,-s.eyeY};
    Vec3 point=Vec3{(u-.5)*s.screenWidth,0,0}+dst*((1-v)*s.screenHeight),normal{0,-src.z,src.y};
    Vec3 ray=point-eye;double denominator=dot(normal,ray),t=std::abs(denominator)>1e-10?-dot(normal,eye)/denominator:-1;
    Vec3 q=eye+ray*t;double sourceHeight=dot(q,src);
    bool front=dot(normal,eye)<-1e-7;
    bool visible=front&&t>0&&sourceHeight>=0&&sourceHeight<=s.screenHeight&&std::abs(q.x)<=s.screenWidth/2;
    Vec3 nearest;
    if(visible)nearest=Vec3{q.x,0,0}+dst*std::clamp(dot(q,dst),0.,s.screenHeight);
    else {q=point;nearest=Vec3{point.x,0,0}+src*std::clamp(dot(point,src),0.,s.screenHeight);}
    Vec3 gap=q-nearest;double distance=std::sqrt(dot(gap,gap));
    return (1-std::exp(-s.frostResponse*distance/s.frostDistanceMm))*std::min(1.,s.blurPixels);
}
double contrast(const std::vector<Pixel>& pixels,UINT width,UINT row){
    double sum=0,squared=0;int count=0;
    for(UINT x=width/4;x<width*3/4;++x){double v=pixels[row*width+x].r;sum+=v;squared+=v*v;++count;}
    return std::sqrt(std::max(0.,squared/count-(sum/count)*(sum/count)));
}
}
int main(){try{
    Gpu gpu;constexpr UINT w=320,h=200;
    std::vector<Pixel> stripes(w*h);
    for(UINT y=0;y<h;++y)for(UINT x=0;x<w;++x){float c=.5f+.4f*float(std::sin(2*std::numbers::pi*(x+.5)/16));stripes[y*w+x]={c,c,c,1};}
    auto input=gpu.image(w,h,stripes),projected=gpu.image(w,h),output=gpu.image(w,h),scratch=gpu.image(w/4,h/4);
    std::array<Pixel,1> light{{{.03f,.04f,.05f,1}}};auto ambient=gpu.image(1,1,light);
    std::array<Image,4> levels{gpu.image(w/4,h/4),gpu.image(w/4,h/4),gpu.image(w/4,h/4),gpu.image(w/4,h/4)};
    Settings s;
    for(double distance:{100.,550.,3000.})for(double ref:{1.,90.,110.,179.})for(double angle:{0.,40.,85.,110.,180.}){
        s.eyeY=distance;s.referenceAngle=ref;
        auto p=parameters(s,angle,w,h);gpu.draw(gpu.warp.get(),projected,p,{input.view.get(),nullptr,nullptr,nullptr,ambient.view.get()});
        auto pixels=gpu.read(projected);
        for(UINT y:{0U,40U,100U,190U,199U})for(UINT x:{0U,80U,160U,240U,319U}){
            double expected=expectedAmount(s,angle,(x+.5)/w,(y+.5)/h);auto pixel=pixels[y*w+x];
            check(std::isfinite(pixel.r)&&std::isfinite(pixel.a)&&std::abs(pixel.a-expected)<2e-5,"GPU distance differs from independent 3D control");
        }
    }
    s=Settings{};
    for(double angle:{110.,85.,0.})for(double maxBlur:{0.,64.}){
        s.blurPixels=maxBlur;auto p=parameters(s,angle,w,h);
        gpu.draw(gpu.warp.get(),projected,p,{input.view.get(),nullptr,nullptr,nullptr,ambient.view.get()});auto clear=gpu.read(projected);
        for(size_t i=0;i<levels.size();++i){
            float radius=float(maxBlur*frostRadii[i]/4);
            p.direction[0]=1.f/scratch.width;p.direction[1]=0;p.direction[2]=std::ceil(radius);p.direction[3]=radius/3;
            gpu.draw(gpu.blur.get(),scratch,p,{projected.view.get()});
            p.direction[0]=0;p.direction[1]=1.f/scratch.height;
            gpu.draw(gpu.blur.get(),levels[i],p,{scratch.view.get()});
        }
        gpu.draw(gpu.composite.get(),output,p,{projected.view.get(),levels[0].view.get(),nullptr,nullptr,nullptr,levels[1].view.get(),levels[2].view.get(),levels[3].view.get()});
        auto pixels=gpu.read(output);
        for(size_t i=0;i<pixels.size();++i){check(std::isfinite(pixels[i].r)&&pixels[i].a==1,"Frost pipeline generated invalid output");
            if(maxBlur==0||angle==110)check(std::abs(pixels[i].r-clear[i].r)<1e-6,"Zero blur or reference angle changed clear image");}
        if(angle==85&&maxBlur==64){
            double top=contrast(pixels,w,50)/contrast(clear,w,50),bottom=contrast(pixels,w,199)/contrast(clear,w,199);
            check(top<.15&&bottom>.9&&bottom>top*6,"GPU frosting must remove top detail while preserving the hinge region");
            std::cout<<"85-degree stripe contrast retained: upper="<<top<<", hinge="<<bottom<<'\n';
        }
    }
    std::cout<<assertions<<" shader checks passed (WARP, actual HLSL, independent distance and spatial blur)\n";return 0;
}catch(const std::exception& e){std::cerr<<"FAIL after "<<assertions<<": "<<e.what()<<'\n';return 1;}}
