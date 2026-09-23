#include "core.h"
#include "angle.h"
#include "settings.h"
#include <winrt/base.h>
#include <iostream>
#include <random>
#include <numbers>
#include <filesystem>
#include <limits>
#include <fstream>
using namespace hinge;
int assertions=0;
void check(bool value,const char* reason){++assertions;if(!value)throw std::runtime_error(reason);}
bool near(double a,double b,double tolerance=1e-8){return std::abs(a-b)<tolerance;}
// Independent control: geometric ray/plane intersection, without the production homography.
std::optional<std::array<double,2>> reference(const Settings& s,double angle,double u,double v){
    if(angle>=s.referenceAngle)return std::array<double,2>{u,v};
    const double tilt=(s.referenceAngle-angle)*std::numbers::pi/180;
    Vec3 E{0,s.screenHeight/2,-s.eyeY},U{0,std::cos(tilt),std::sin(tilt)},N{0,-std::sin(tilt),std::cos(tilt)};
    if(dot(N,E)>=-1e-7)return {};
    Vec3 P{(u-.5)*s.screenWidth,(1-v)*s.screenHeight,0};
    Vec3 D=P-E;double denominator=dot(N,D);if(std::abs(denominator)<1e-7)return {};
    double t=-dot(N,E)/denominator;if(t<=0)return {};Vec3 Q=E+D*t;
    return std::array<double,2>{Q.x/s.screenWidth+.5,1-dot(Q,U)/s.screenHeight};
}
// Independent forward control for the stationary test: rotate a source-space
// point rigidly, then project it onto z=0 from the centered pinhole camera.
std::array<double,2> rotatedPoint(const Settings& s,double angle,double u,double v){
    double tilt=std::max(0.,s.referenceAngle-angle)*std::numbers::pi/180;
    double x=(u-.5)*s.screenWidth,y=(1-v)*s.screenHeight;
    Vec3 point{x,y*std::cos(tilt),y*std::sin(tilt)},eye{0,s.screenHeight/2,-s.eyeY};
    double t=(0-eye.z)/(point.z-eye.z);Vec3 projected=eye+(point-eye)*t;
    return {projected.x/s.screenWidth+.5,1-projected.y/s.screenHeight};
}
void rotationTests(){
    Settings s;
    for(double ref:{1.,45.,90.,110.,120.,179.})for(double distance:{100.,550.,3000.}){
        s.referenceAngle=ref;s.eyeY=distance;
        for(double angle:{0.,.001,10.,20.,30.,40.,60.,85.,109.999,110.,120.,179.,180.}){
            double tilt=std::max(0.,ref-angle)*std::numbers::pi/180;
            bool front=distance*std::cos(tilt)+s.screenHeight/2*std::sin(tilt)>1e-7;
            auto inverse=projection(s,angle);
            for(int y=0;y<=10;++y)for(int x=0;x<=10;++x){double u=x/10.,v=y/10.;auto dest=rotatedPoint(s,angle,u,v);
                auto actual=inverse.map(dest[0],dest[1]);check(bool(actual)==front,"Rotation back-face visibility differs from geometric control");
                if(actual)check(near((*actual)[0],u,1e-6)&&near((*actual)[1],v,1e-6),"Rotated plane has incorrect scale or direction");
            }
            if(front)for(double u:{0.,.1,.25,.5,.75,.9,1.}){auto bottom=inverse.map(u,1);
                check(bottom&&near((*bottom)[0],u)&&near((*bottom)[1],1),"Rotating plane bottom edge moved");}
        }
    }
    s=Settings{};
    double previousTop=0;
    for(double angle=110;angle>=10;angle-=1){
        auto topLeft=rotatedPoint(s,angle,0,0),topRight=rotatedPoint(s,angle,1,0);
        check(topLeft[0]>=-1e-8&&topRight[0]<=1+1e-8,"Top edge grew wider during closing");
        check(topLeft[1]>=previousTop-1e-8,"Closing unexpectedly enlarged the desktop vertically");
        previousTop=topLeft[1];
    }
    // Prior failure: at 40 degrees physical compensation samples a very narrow
    // strip of the source. The rotating preview must show the complete rectangle.
    double sumV=0;for(double v:{0.,.25,.5,.75,1.}){
        auto dest=rotatedPoint(s,40,.5,v);check(dest[1]>=0&&dest[1]<=1,"Regression: content is stretched out of the preview");
        auto actual=projection(s,40).map(dest[0],dest[1]);check(actual&&near((*actual)[1],v),"Regression: only a source strip is visible");sumV+=(*actual)[1];
    }check(near(sumV,2.5),"Source does not span all rows");
    double edge=180-std::atan2(s.eyeY,s.screenHeight/2)*180/std::numbers::pi;
    check(!projection(s,s.referenceAngle-edge).map(.5,.5),"Exact edge-on projection should not stretch or flip");
    check(!projection(s,0).map(.5,.5),"Back of the plane rendered a flipped desktop");
    for(double angle:{110.,85.,60.,40.,0.,40.,60.,85.,110.}){
        auto h=projection(s,angle);auto again=projection(s,angle);check(h.h==again.h,"Reversal retained history instead of exact geometry");
    }
}
void distanceFrostTests(){
    Settings s;
    for(double ref:{1.,45.,90.,110.,120.,179.})for(double height:{50.,212.5,2000.}){
        s.referenceAngle=ref;s.screenHeight=height;
        double previous=0;
        for(int step=0;step<=100;++step){
            double angle=ref*(1-step/100.),top=glassSeparationAtTop(s,angle);
            check(top>=previous-1e-8&&top<=height,"Distance decreased during closure or exceeded finite panel bounds");previous=top;
            double r=ref*std::numbers::pi/180,a=angle*std::numbers::pi/180,tilt=r-a;
            Vec3 source{0,std::cos(tilt),std::sin(tilt)},glass{0,1,0};
            double previousAmount=0;
            for(double h:{0.,.001,.01,.1,.5,1.})for(double u:{0.,.5,1.}){
                // Independent closest-point control in 3D on the finite glass.
                Vec3 point=Vec3{(u-.5)*s.screenWidth,0,0}+source*(height*h);
                Vec3 nearest=Vec3{std::clamp(point.x,-s.screenWidth/2,s.screenWidth/2),0,0}+glass*std::clamp(dot(point,glass),0.,height);
                Vec3 delta=point-nearest;double expected=std::sqrt(dot(delta,delta));
                double actual=top*h;check(near(actual,expected,1e-7),"Frost distance differs from independent finite-rectangle control");
                double amount=frostAtDistance(actual,s.frostDistanceMm,s.frostResponse);
                check(std::isfinite(amount)&&amount>=previousAmount-1e-12&&amount<=1,"Frost must grow with point distance");previousAmount=amount;
                if(h==0)check(amount==0,"Hinge must stay clear at every angle");
            }
        }
        check(glassSeparationAtTop(s,ref)==0&&glassSeparationAtTop(s,180)==0,"Open screen must stay clear");
    }
    s=Settings{};double gap=glassSeparationAtTop(s,85);
    double top=frostAtDistance(gap,s.frostDistanceMm,s.frostResponse),bottom=frostAtDistance(gap*.01,s.frostDistanceMm,s.frostResponse);
    check(top>.8&&bottom<.02&&top>bottom*40,"Top should be much more frosted than the hinge region");
    check(frostAtDistance(100,300,3)<frostAtDistance(100,150,3),"Distance control has inverted response");
    check(frostAtDistance(100,150,6)>frostAtDistance(100,150,3),"Response control has inverted response");
    check(near(frostAtDistance(1,150,3),frostAtDistance(2,300,3)),"Equal distance ratios should frost equally");
    double prior=0;for(double angle:{110.,85.,40.,0.,40.,85.,110.}){
        double amount=frostAtDistance(glassSeparationAtTop(s,angle),150,3);
        if(angle==85&&prior==0)prior=amount;else if(angle==85)check(near(amount,prior),"Reopening must retrace frost without history");
    }
    for(double invalid:{0.,-1.,2001.,std::numeric_limits<double>::quiet_NaN()}){
        s.frostDistanceMm=invalid;bool rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Invalid frost distance scale accepted");
    }
}
int main(){try{
    winrt::init_apartment();Settings s;s.validate();
    rotationTests();distanceFrostTests();
    for(auto dimensions:{PixelSize{2560,1600},PixelSize{1920,1080},PixelSize{1080,1920},PixelSize{3440,1440},PixelSize{1600,1600}}){
        auto size=fitPreview(dimensions.width,dimensions.height);
        check(size.width<=960&&size.height<=600&&size.width>0&&size.height>0,"Preview exceeds bounds");
        check(std::abs(double(size.width)/size.height-double(dimensions.width)/dimensions.height)<.003,"Preview distorts the source aspect ratio");
    }
    for(double ref:{1.,45.,90.,110.,120.,179.})for(double distance:{100.,550.,3000.}){
        s.referenceAngle=ref;s.eyeY=distance;
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
    for(double height:{50.,212.5,2000.})for(double distance:{100.,550.,3000.})for(double a:{20.,40.,80.,109.99}){
        s.screenHeight=height;s.eyeY=distance;
        for(double u:{0.,.1,.25,.5,.75,.9,1.}){auto bottom=projection(s,a).map(u,1);
            check(bottom&&near((*bottom)[0],u)&&near((*bottom)[1],1),"Entire active bottom edge must remain fixed at every viewing distance");}
    }
    s=Settings{};
    check(closure(110,110)==0&&closure(0,110)==1&&closure(180,110)==0,"Closure boundaries");
    check(near(closure(80,110),closure(80,110)),"Reversal must be path independent");
    s.referenceAngle=0;bool rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Zero reference accepted");
    s=Settings{};s.eyeY=0;rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Zero viewing distance accepted");
    for(auto url:{"http://127.0.0.1:0","http://localhost:65536","http://127.0.0.1:1820@remote.test",
                  "http://localhost:1820/path","http://localhost:1820?q=x","https://localhost:1820","http://remote.test:1820"}){
        s=Settings{};s.fusionUrl=url;rejected=false;try{s.validate();}catch(...){rejected=true;}check(rejected,"Invalid Fusion origin accepted");
    }
    for(auto url:{"http://127.0.0.1:1820","http://localhost:1820/","http://localhost:1","http://localhost:65535"}){
        s=Settings{};s.fusionUrl=url;s.validate();
    }
    s=Settings{};
    SweepAngle sweep;sweep.start(1000,110,0,6);check(near(sweep.sample(1000).angle,110)&&near(sweep.sample(7000).angle,0),"Sweep endpoints");
    double mid=sweep.sample(3500).angle;sweep.start(3500,mid,110,6);check(near(sweep.sample(3500).angle,mid),"Reversal position jumped");
    AngleGate gate;gate.connection();AngleSample a{10,30,100,1000,true,true,"one","fusion"};check(gate.ingest(a),"Valid sample rejected");
    check(near(gate.sample(1010,500,17).angle,10.3),"Velocity prediction wrong");check(near(gate.sample(1200,500,17).angle,10.51),"Prediction exceeded one source interval");
    check(!gate.sample(1600,500,17).fresh&&near(gate.sample(1600,500,17).angle,10),"Stale geometry not retained");
    check(!gate.ingest(a),"Duplicate timestamp accepted");a.session="two";a.sourceMs=1;a.angle=20;check(gate.ingest(a),"New session clock rejected");
    a.session="one";a.sourceMs=101;check(!gate.ingest(a),"Retired session revived");gate.disconnect();check(!gate.sample(1001,500,17).fresh,"Disconnect reported fresh");
    gate.connection();check(!gate.ingest(a),"Reconnect revived a retired session");
    a.session="two";a.sourceMs=2;check(gate.ingest(a),"Reconnect failed to accept a newer current sample");
    gate.endSession();a.sourceMs=3;check(!gate.ingest(a),"Stopped session returned");
    a.session="three";a.sourceMs=1;check(gate.ingest(a),"Restarted camera clock rejected");
    a.sourceMs=2;a.valid=false;check(!gate.ingest(a),"Invalid reading accepted");a.valid=true;
    a.angle=std::numeric_limits<double>::quiet_NaN();check(!gate.ingest(a),"NaN accepted");
    auto parsed=parseFusion(R"({"sessionId":"live","timestampMs":1,"displayAngleDeg":10,"displayVelocityDegS":2,"controllerState":"TRACKING"})",5);
    check(parsed&&parsed->angle==10&&parsed->fresh,"Fusion sample changed small angle to closure");
    check(!parseFusion(R"({"sessionId":null,"displayAngleDeg":null})",1),"Stopped Fusion accepted");
    for(auto json:{R"({"sessionId":"x","timestampMs":1,"displayAngleDeg":0})",
                   R"({"sessionId":"x","timestampMs":1,"displayAngleDeg":121})",
                   R"({"sessionId":"x","timestampMs":-1,"displayAngleDeg":80})",
                   R"({"sessionId":"","timestampMs":1,"displayAngleDeg":80})",
                   R"({"sessionId":"x","timestampMs":1,"displayAngleDeg":80,"controllerState":"bad"})",
                   R"({"sessionId":"x","timestampMs":1,"displayAngleDeg":80,"displayVelocityDegS":"bad"})"})
        check(!parseFusion(json,5),"Invalid Fusion payload accepted");
    int events=0;EventParser parser;auto cb=[&](std::string event,std::string data){check(event=="angle"&&data=="{\"x\":1}","SSE parse mismatch");++events;};
    for(char c:std::string("event: angle\r\ndata: {\"x\":1}\r\n\r\n"))parser.append(std::string(1,c),cb);check(events==1,"Chunked SSE lost event");
    Lifecycle life;life.transition(State::Starting);life.transition(State::Active);life.transition(State::Recovering);life.transition(State::Starting);life.transition(State::Suspended);life.transition(State::Starting);life.transition(State::Faulted);life.transition(State::Disabled);
    check(!canTransition(State::Disabled,State::Active),"Invalid state transition allowed");
    auto path=std::filesystem::temp_directory_path()/L"hinge-glass-test-settings.json";s=Settings{};s.referenceAngle=97;s.eyeY=800;s.frostDistanceMm=240;saveSettings(s,path);
    auto roundtrip=loadSettings(path,false);check(roundtrip.referenceAngle==97&&roundtrip.eyeY==800&&roundtrip.frostDistanceMm==240,"Preferences roundtrip failed");
    {std::ofstream file(path);file<<R"({"version":1,"projectionMode":"physical","eyeX":99999,"eyeZ":0,"hingeOffset":200})";}
    auto legacy=loadSettings(path,false);check(projection(legacy,40).h==projection(Settings{},40).h,"Legacy physical preference changed the single rotation geometry");
    saveSettings(legacy,path);{std::ifstream file(path);std::string json((std::istreambuf_iterator<char>(file)),{});
        check(json.find("projectionMode")==std::string::npos&&json.find("hingeOffset")==std::string::npos,"Removed mode was persisted again");}
    std::filesystem::remove(path);
    std::cout<<assertions<<" checks passed (independent geometry, boundaries, sources, SSE, settings and lifecycle)\n";return 0;
}catch(const std::exception& e){std::cerr<<"FAIL after "<<assertions<<" checks: "<<e.what()<<"\n";return 1;}}
