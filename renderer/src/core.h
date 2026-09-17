#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <optional>
#include <vector>

namespace hinge {
struct Settings {
    double manualAngle=110, referenceAngle=110, blurPixels=64, frostResponse=3, frostDistanceMm=150;
    double eyeY=550;
    double screenWidth=340, screenHeight=212.5;
    double maxFps=60, sweepSeconds=6, staleMs=500, predictionMs=17;
    double retryMs=1000, captureTimeoutMs=5000, blurScale=.25;
    std::string fusionUrl="http://127.0.0.1:1820", monitor, adapter="auto";
    void validate() const;
};
struct Vec3 { double x,y,z; };
Vec3 operator+(Vec3 a,Vec3 b);
Vec3 operator-(Vec3 a,Vec3 b);
Vec3 operator*(Vec3 a,double b);
double dot(Vec3 a,Vec3 b);
struct Mapping {
    // Three homogeneous rows mapping destination (u,v,1) to source (u,v,1).
    std::array<double,9> h{};
    bool identity=false;
    std::optional<std::array<double,2>> map(double u,double v) const;
};
Mapping projection(const Settings& s,double angle);
struct PixelSize {int width,height;};
PixelSize fitPreview(int sourceWidth,int sourceHeight,int maxWidth=960,int maxHeight=600);
double closure(double angle,double reference);
// Shortest distance from the top source point to the finite glass rectangle.
// Other source points scale this by their normalized height above the hinge.
double glassSeparationAtTop(const Settings& s,double angle);
double frostAtDistance(double distanceMm,double distanceScaleMm,double response);
double nowMs();
enum class State { Disabled, Starting, Active, Recovering, Suspended, Faulted };
const wchar_t* stateName(State state);
bool canTransition(State from,State to);
class Lifecycle {
public:
    State state=State::Disabled;
    void transition(State to);
};
struct AngleSample {
    double angle=110,velocity=0,sourceMs=0,receivedMs=0;
    bool valid=false,fresh=false;
    std::string session,source;
};
struct IAngleSource {
    virtual ~IAngleSource()=default;
    virtual AngleSample sample(double now)=0;
};
class ManualAngle final : public IAngleSource {
public:
    double angle=110;
    AngleSample sample(double now) override;
};
class SweepAngle final : public IAngleSource {
    double start_=0,from_=110,to_=0,duration_=6000;
public:
    void start(double now,double from,double to,double seconds);
    AngleSample sample(double now) override;
};
// Latest-only session gate; retired sessions cannot return until a new connection.
class AngleGate {
    AngleSample last_;
    std::vector<std::string> retired_;
    bool connected_=false;
public:
    void connection();
    void disconnect();
    bool ingest(const AngleSample& value);
    AngleSample sample(double now,double staleMs,double predictionMs) const;
};
}
