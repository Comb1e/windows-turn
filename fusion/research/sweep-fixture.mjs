import { readFileSync } from 'node:fs';
import { SweepCalibration } from '../src/calibration.js';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url))).calibration;
export function sweep({speed=10,closeSpeed=10,hiddenSpeed=10,motion=true,manual=false}={}){
  const cal=new SweepCalibration(config,{device:'test-laptop',location:'test-room',position:'desk',lighting:'lamp',display:'fixed'});
  let t=0,id=0,previous=null;const frames=[];
  const frame=(angle,moving=false)=>{
    const keyboard={frameId:++id,timestampMs:t,valid:angle<=44,angleDeg:angle<=44?angle:null};
    const lighting={frameId:id,timestampMs:t,motion:{fromTimestampMs:t-100,rotationVector:motion?[moving?.02:0,0,0]:null}};
    cal.push(keyboard,lighting);previous={keyboard,lighting,angle};frames.push({...previous,state:cal.state});t+=100;return cal.state;
  };
  for(let i=0;i<12;i++)frame(18);
  for(let angle=19;angle<=44;angle+=speed/10)frame(angle,true);
  for(let angle=44+hiddenSpeed/10;angle<120;angle+=hiddenSpeed/10)frame(angle,true);
  if(manual)cal.manual('upper');
  for(let i=0;i<15;i++)frame(120);
  if(manual&&cal.state==='UPPER_HOLD')cal.manual('closing');
  for(let angle=120-closeSpeed/10;angle>21;angle-=closeSpeed/10)frame(angle,true);
  for(let i=0;i<15;i++)frame(21);
  return {cal,frame,frames,get time(){return t;},previous};
}
