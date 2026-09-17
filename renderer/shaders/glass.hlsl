cbuffer Parameters : register(b0) {
    float4 row0, row1, row2;
    float4 sizes; // destination width,height; source width,height
    float4 effect; // closure, blur radius in destination pixels, SDR input, HDR output
    float4 direction; // blur texel direction x,y; pass; paper-white multiplier
    float4 cursorRect; // source-normalized top left and size
    float4 cursorInfo; // enabled, reserved
};
Texture2D scene : register(t0);
Texture2D frost : register(t1);
Texture2D cursorImage : register(t2);
Texture2D cursorMask : register(t3);
Texture2D lightField : register(t4);
SamplerState linearClamp : register(s0);
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex VS(uint id : SV_VertexID) {
    Vertex o;o.uv=float2((id<<1)&2,id&2);o.position=float4(o.uv*float2(2,-2)+float2(-1,1),0,1);return o;
}
float3 toLinear(float3 c) {return lerp(c/12.92,pow(max((c+.055)/1.055,0),2.4),step(.04045,c));}
float3 toSrgb(float3 c) {return lerp(c*12.92,1.055*pow(max(c,0),1/2.4)-.055,step(.0031308,c));}
float3 sourceAt(float2 uv) {
    float3 c=scene.SampleLevel(linearClamp,uv,0).rgb;
    if(effect.z>0.5)c=toLinear(c);
    float2 cu=(uv-cursorRect.xy)/max(cursorRect.zw,1e-8);
    if(cursorInfo.x>.5&&all(cu>=0)&&all(cu<=1)){
        float4 icon=cursorImage.SampleLevel(linearClamp,cu,0);
        float2 mask=cursorMask.SampleLevel(linearClamp,cu,0).rg;
        // Masked color and monochrome cursors: (background AND mask) XOR color.
        float3 base=toSrgb(max(c,0));
        float3 xorColor=abs(base*mask.r-icon.rgb);
        float3 result=lerp(lerp(base,icon.rgb,icon.a),xorColor,mask.g);
        c=toLinear(result);
    }
    return c;
}
float4 Light(Vertex input) : SV_Target {
    // Reduce once per frame, not nine full-resolution samples for every output pixel.
    float3 ambient=0;
    [unroll] for(int y=0;y<3;++y)[unroll]for(int x=0;x<3;++x){
        float3 c=scene.SampleLevel(linearClamp,(float2(x,y)+.5)/3,0).rgb;
        ambient+=effect.z>.5?toLinear(c):c;
    }
    ambient=ambient/9*.16+float3(.025,.032,.044);
    return float4(ambient,1);
}
float4 Warp(Vertex input) : SV_Target {
    float3 p=float3(input.uv,1);float d=dot(row2.xyz,p);
    float2 uv=float2(dot(row0.xyz,p),dot(row1.xyz,p))/max(d,1e-7);
    float3 ambient=lightField.Load(int3(0,0,0)).rgb;
    float3 c=(d>1e-7&&all(uv>=0)&&all(uv<=1))?sourceAt(uv):ambient;
    return float4(c,1);
}
float4 Blur(Vertex input) : SV_Target {
    float4 c=0;float sum=0;
    // Fixed tap count, variable spacing: stable work at every user-selected blur strength.
    [unroll]for(int i=-6;i<=6;++i){float w=exp(-.5*i*i/4.0);c+=scene.SampleLevel(linearClamp,input.uv+direction.xy*i,0)*w;sum+=w;}
    return c/sum;
}
float4 Composite(Vertex input) : SV_Target {
    float3 clear=scene.SampleLevel(linearClamp,input.uv,0).rgb;
    float3 blurred=frost.SampleLevel(linearClamp,input.uv,0).rgb;
    float strength=effect.x*saturate(effect.y);
    float3 c=lerp(clear,blurred,strength);
    c=lerp(c,c*.91+float3(.045,.052,.062),effect.x*.22);
    if(effect.w<.5)c=toSrgb(max(c,0));
    return float4(c,1);
}
float4 Pattern(Vertex input) : SV_Target {
    float2 uv=input.uv;
    float grid=fmod(floor(uv.x*16)+floor(uv.y*10),2);
    float band=1-smoothstep(.008,.015,abs(uv.x-frac(direction.w*.12)));
    float3 color=lerp(float3(.035,.07,.12),float3(.42,.65,.8),grid)*.65+band*float3(.6,.25,.05);
    // Asymmetric calibration marks expose flips and distinguish the fixed bottom from the top.
    if(uv.y>.98)color=float3(.08,.9,.2);
    if(uv.y<.02)color=float3(.9,.06,.04);
    if(uv.x<.012)color=float3(.07,.2,1);
    if(uv.x>.988)color=float3(1,.7,.04);
    return float4(color,1);
}
