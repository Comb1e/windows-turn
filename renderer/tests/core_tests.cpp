#include "core.h"
#include "angle.h"
#include "settings.h"
#include <winrt/base.h>
#include <iostream>
#include <random>
#include <numbers>
#include <filesystem>
#include <limits>
using namespace hinge;
int assertions=0;
void check(bool value,const char* reason){++assertions;if(!value)throw std::runtime_error(reason);}
bool near(double a,double b,double tolerance=1e-8){return std::abs(a-b)<tolerance;}
// Independent control: geometric ray/plane intersection, without the production homography.
std::optional<std::array<double,2>> reference(const Settings& s,double angle,double u,double v){
    if(angle>=s.referenceAngle)return std::array<double,2>{u,v};
    const double rad=std::numbers::pi/180,physical=angle*rad,virt=s.referenceAngle*rad;
    Vec3 E{s.eyeX,s.eyeY,s.eyeZ},U{0,std::cos(virt),std::sin(virt)},N{0,-std::sin(virt),std::cos(virt)};
    Vec3 B=U*s.hingeOffset; // World-space stationary active bottom edge.
    double h=(1-v)*s.screenHeight;Vec3 P=B+Vec3{(u-.5)*s.screenWidth,h*std::cos(physical),h*std::sin(physical)};
    Vec3 D=P-E;double denominator=dot(N,D);if(std::abs(denominator)<1e-7)return {};
    double t=dot(N,B-E)/denominator;if(t<=0)return {};Vec3 Q=E+D*t;
    return std::array<double,2>{(Q.x-B.x)/s.screenWidth+.5,1-dot(Q-B,U)/s.screenHeight};
}
int main(){try{
    winrt::init_apartment();Settings s;s.validate();
    for(double ref:{1.,45.,90.,110.,120.,179.})for(double eyeX:{-150.,0.,125.}){
        s.referenceAngle=ref;s.eyeX=eyeX;
        for(double angle:{0.,.001,10.,45.,89.,109.999,110.,120.,179.,180.}){
            auto map=projection(s,angle);
            for(int y=0;y<=10;++y)for(int x=0;x<=10;++x){double u=x/10.,v=y/10.;auto actual=map.map(u,v),expected=reference(s,angle,u,v);
                check(bool(actual)==bool(expected),"Visibility differs from independent ray intersection");
                if(actual){check(near((*actual)[0],(*expected)[0],1e-6)&&near((*actual)[1],(*expected)[1],1e-6),"Projection differs from independent ray intersection");}
            }
            check(std::all_of(map.h.begin(),map.h.end(),[](double n){return std::isfinite(n);}),"Nonfinite homography");
        }
    }
    s=Settings{};auto identity=projection(s,110).map(.25,.75);check(identity&&near((*identity)[0],.25)&&near((*identity)[1],.75),"Reference must be identity");
    for(double offset:{0.,10.,50.,200.})for(double lateral:{-150.,0.,150.})for(double a:{0.,10.,40.,80.,109.99}){
        s.hingeOffset=offset;s.eyeX=lateral;
        for(double u:{0.,.1,.25,.5,.75,.9,1.}){auto bottom=projection(s,a).map(u,1);
            check(bottom&&near((*bottom)[0],u)&&near((*bottom)[1],1),"Entire active bottom edge must remain fixed, including nonzero hinge offset");}
    }
    s=Settings{};
    check(closure(110,110)==0&&closure(0,110)==1&&closure(180,110)==0,"Closure boundaries");
    check(near(closure(80,110),closure(80,110)),"Reversal must be path independent");
    s.referenceAngle=0;bool rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Zero reference accepted");
    s=Settings{};s.eyeY=450;s.eyeZ=450;s.referenceAngle=45;rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Eye on virtual plane accepted");
    SweepAngle sweep;sweep.start(1000,110,0,6);check(near(sweep.sample(1000).angle,110)&&near(sweep.sample(7000).angle,0),"Sweep endpoints");
    double mid=sweep.sample(3500).angle;sweep.start(3500,mid,110,6);check(near(sweep.sample(3500).angle,mid),"Reversal position jumped");
    AngleGate gate;gate.connection();AngleSample a{10,30,100,1000,true,true,"one","fusion"};check(gate.ingest(a),"Valid sample rejected");
    check(near(gate.sample(1010,500,17).angle,10.3),"Velocity prediction wrong");check(near(gate.sample(1200,500,17).angle,10.51),"Prediction exceeded one source interval");
    check(!gate.sample(1600,500,17).fresh&&near(gate.sample(1600,500,17).angle,10),"Stale geometry not retained");
    check(!gate.ingest(a),"Duplicate timestamp accepted");a.session="two";a.sourceMs=1;a.angle=20;check(gate.ingest(a),"New session clock rejected");
    a.session="one";a.sourceMs=101;check(!gate.ingest(a),"Retired session revived");gate.disconnect();check(!gate.sample(1001,500,17).fresh,"Disconnect reported fresh");
    gate.connection();check(gate.ingest(a),"Reconnect failed");a.sourceMs=102;a.angle=std::numeric_limits<double>::quiet_NaN();check(!gate.ingest(a),"NaN accepted");
    auto parsed=parseFusion(R"({"sessionId":"live","timestampMs":1,"displayAngleDeg":10,"displayVelocityDegS":2,"controllerState":"TRACKING"})",5);
    check(parsed&&parsed->angle==10&&parsed->fresh,"Fusion sample changed small angle to closure");
    check(!parseFusion(R"({"sessionId":null,"displayAngleDeg":null})",1),"Stopped Fusion accepted");
    int events=0;EventParser parser;auto cb=[&](std::string event,std::string data){check(event=="angle"&&data=="{\"x\":1}","SSE parse mismatch");++events;};
    for(char c:std::string("event: angle\r\ndata: {\"x\":1}\r\n\r\n"))parser.append(std::string(1,c),cb);check(events==1,"Chunked SSE lost event");
    Lifecycle life;life.transition(State::Starting);life.transition(State::Active);life.transition(State::Recovering);life.transition(State::Starting);life.transition(State::Suspended);life.transition(State::Starting);life.transition(State::Faulted);life.transition(State::Disabled);
    check(!canTransition(State::Disabled,State::Active),"Invalid state transition allowed");
    auto path=std::filesystem::temp_directory_path()/L"hinge-glass-test-settings.json";s=Settings{};s.referenceAngle=97;s.eyeX=-80;saveSettings(s,path);
    auto roundtrip=loadSettings(path,false);check(roundtrip.referenceAngle==97&&roundtrip.eyeX==-80,"Preferences roundtrip failed");std::filesystem::remove(path);
    std::cout<<assertions<<" checks passed (independent geometry, boundaries, sources, SSE, settings and lifecycle)\n";return 0;
}catch(const std::exception& e){std::cerr<<"FAIL after "<<assertions<<" checks: "<<e.what()<<"\n";return 1;}}
