#pragma once
#include <array>

namespace hinge {
// Shared by the runtime and the offscreen shader regression tests. Keep this
// layout in sync with Parameters in glass.hlsl (each member is one float4).
struct alignas(16) ShaderParameters {
    float rows[3][4]{};
    float sizes[4]{},effect[4]{},direction[4]{},cursorRect[4]{},cursorInfo[4]{};
    float frosting[4]{}; // distance scale in mm, response, reserved
    float blurRadii[4]{}; // radii relative to the configured maximum
};
inline constexpr std::array<float,4> frostRadii{.125f,.25f,.5f,1.f};
static_assert(sizeof(ShaderParameters)==160);
}
