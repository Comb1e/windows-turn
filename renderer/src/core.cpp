#include "core.h"
#include <chrono>
#include <stdexcept>
#include <numbers>

namespace hinge {
Vec3 operator+(Vec3 a,Vec3 b){return {a.x+b.x,a.y+b.y,a.z+b.z};}
Vec3 operator-(Vec3 a,Vec3 b){return {a.x-b.x,a.y-b.y,a.z-b.z};}
Vec3 operator*(Vec3 a,double b){return {a.x*b,a.y*b,a.z*b};}
double dot(Vec3 a,Vec3 b){return a.x*b.x+a.y*b.y+a.z*b.z;}
void Settings::validate() const {
    auto range=[](double v,double lo,double hi,const char* name){
        if(!std::isfinite(v)||v<lo||v>hi)throw std::runtime_error(std::string("Invalid ")+name);
    };
    range(manualAngle,0,180,"manual angle (0–180)");range(referenceAngle,1,179,"reference angle (1–179)");
    range(blurPixels,0,100,"blur (0–100 pixels)");range(eyeX,-2000,2000,"eye lateral offset");
    range(eyeY,100,3000,"eye distance (100–3000 mm)");range(eyeZ,50,2000,"eye height (50–2000 mm)");
    range(screenWidth,50,2000,"screen width");range(screenHeight,50,2000,"screen height");
    range(hingeOffset,0,200,"hinge offset");range(maxFps,1,240,"frame cap (1–240)");
    range(sweepSeconds,.25,120,"sweep duration");range(staleMs,50,5000,"stale timeout");
    range(predictionMs,0,50,"prediction horizon");range(retryMs,100,30000,"retry interval");
    range(captureTimeoutMs,1000,30000,"capture timeout");range(blurScale,.125,.5,"blur scale");
    if(!fusionUrl.starts_with("http://127.0.0.1:")&&!fusionUrl.starts_with("http://localhost:"))
        throw std::runtime_error("Fusion URL must use loopback HTTP");
    const double r=referenceAngle*std::numbers::pi/180;
    if(std::abs(-std::sin(r)*eyeY+std::cos(r)*eyeZ)<1)
        throw std::runtime_error("Eye must not lie on the virtual screen plane");
}
double nowMs(){return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();}
Mapping projection(const Settings& s,double angle){
    if(!std::isfinite(angle)||angle<0||angle>180)throw std::runtime_error("Invalid physical angle");
    Mapping result;
    if(angle>=s.referenceAngle){result.h={1,0,0,0,1,0,0,0,1};result.identity=true;return result;}
    const double a=angle*std::numbers::pi/180,r=s.referenceAngle*std::numbers::pi/180;
    const Vec3 ref{0,std::cos(r),std::sin(r)}, n{0,-ref.z,ref.y};
    // The visual pivot is the ACTIVE bottom edge, not the mechanical hinge below it.
    // Move the calibration origin once, at the reference angle. Never rotate this offset.
    const Vec3 e=Vec3{s.eyeX,s.eyeY,s.eyeZ}-ref*s.hingeOffset;
    const Vec3 up{0,std::cos(a),std::sin(a)};
    const std::array<Vec3,3> p{Vec3{s.screenWidth,0,0},up*(-s.screenHeight),
        Vec3{-s.screenWidth/2,0,0}+up*s.screenHeight};
    const double ne=dot(n,e), re=dot(ref,e);
    // Q = (E * dot(n,P) - P * dot(n,E)) / dot(n,P-E).
    // Normalize the denominator sign for explicit behind-eye rejection in the shader.
    const double sign=ne>0?-1:1;
    for(int i=0;i<3;++i){
        const double d=dot(n,p[i])-(i==2?ne:0);
        const double x=e.x*dot(n,p[i])-p[i].x*ne;
        const double y=re*dot(n,p[i])-dot(ref,p[i])*ne;
        result.h[i]=sign*(x/s.screenWidth+.5*d);
        result.h[3+i]=sign*(d-y/s.screenHeight);
        result.h[6+i]=sign*d;
    }
    return result;
}
std::optional<std::array<double,2>> Mapping::map(double u,double v)const{
    const double d=h[6]*u+h[7]*v+h[8];
    if(!std::isfinite(d)||d<1e-7)return {};
    return std::array<double,2>{(h[0]*u+h[1]*v+h[2])/d,(h[3]*u+h[4]*v+h[5])/d};
}
double closure(double angle,double reference){double t=std::clamp((reference-angle)/reference,0.,1.);return t*t*(3-2*t);}
const wchar_t* stateName(State s){switch(s){case State::Disabled:return L"Disabled";case State::Starting:return L"Starting";
case State::Active:return L"Active";case State::Recovering:return L"Recovering";case State::Suspended:return L"Suspended";default:return L"Faulted";}}
bool canTransition(State a,State b){
    if(a==b||b==State::Disabled)return true;
    switch(a){
    case State::Disabled:return b==State::Starting;
    case State::Starting:return b==State::Active||b==State::Faulted||b==State::Suspended||b==State::Recovering;
    case State::Active:return b==State::Recovering||b==State::Suspended||b==State::Faulted;
    case State::Recovering:return b==State::Starting||b==State::Faulted||b==State::Suspended;
    case State::Suspended:return b==State::Starting||b==State::Faulted;
    case State::Faulted:return b==State::Starting;
    }return false;
}
void Lifecycle::transition(State to){if(!canTransition(state,to))throw std::logic_error("Invalid renderer state transition");state=to;}
AngleSample ManualAngle::sample(double now){return {angle,0,now,now,true,true,"manual","manual"};}
void SweepAngle::start(double now,double from,double to,double seconds){start_=now;from_=from;to_=to;duration_=seconds*1000;}
AngleSample SweepAngle::sample(double now){
    double t=std::clamp((now-start_)/duration_,0.,1.);
    double p=t*t*t*(10+t*(-15+6*t)),v=30*t*t*(1-t)*(1-t)*(to_-from_)*1000/duration_;
    return {from_+(to_-from_)*p,v,now,now,true,true,"sweep","sweep"};
}
void AngleGate::connection(){connected_=true;retired_.clear();last_.session.clear();last_.valid=false;last_.fresh=false;}
void AngleGate::disconnect(){connected_=false;last_.fresh=false;}
bool AngleGate::ingest(const AngleSample& v){
    if(v.session.empty()||!std::isfinite(v.angle)||v.angle<0||v.angle>180||!std::isfinite(v.velocity)
       ||!std::isfinite(v.sourceMs)||!std::isfinite(v.receivedMs))return false;
    if(std::find(retired_.begin(),retired_.end(),v.session)!=retired_.end())return false;
    if(v.session==last_.session&&v.sourceMs<=last_.sourceMs)return false;
    if(v.session!=last_.session&&!last_.session.empty())retired_.push_back(last_.session);
    // A retained display is usable but is never reported as a fresh measurement.
    last_=v;connected_=true;return true;
}
AngleSample AngleGate::sample(double now,double stale,double prediction)const{
    AngleSample result=last_;
    double age=now-last_.receivedMs;
    result.fresh=connected_&&last_.fresh&&age>=0&&age<=stale;
    if(result.valid&&result.fresh)result.angle=std::clamp(result.angle+result.velocity*std::min(age,prediction)/1000,0.,180.);
    return result;
}
}
