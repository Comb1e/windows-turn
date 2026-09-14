import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replay } from '../research/replay.mjs';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url)));
test('replay scores each prediction before its teacher label and excludes teachers from evaluation',async()=>{
  const calls=[];
  class Adapter{
    static restore(){return new Adapter();}
    constructor(){this.segment=1;this.state='OFFSET_ADAPTED';this.angle=100;}
    observe(raw,t){calls.push(['predict',t]);return this.angle;}
    add(p,angle){calls.push(['label',p.timestampMs]);this.angle=angle;}
    status(){return {version:1};}
  }
  const data={kind:'fusion-lighting-session',source:'synthetic',captureStartMs:0,sessionId:'test',adaptationConfig:{},fusion:{config,timeline:[]},records:[
    {frameId:1,tMs:0,rawAngleDeg:100,keyboardAngleDeg:25,usable:true,adaptation:{segment:1},label:{angle:25,source:'keyboard',motion:'stationary'}},
    {frameId:2,tMs:100,rawAngleDeg:100,usable:true,adaptation:{segment:1},label:{angle:30,source:'checkpoint',motion:'stationary'}}]};
  const report=await replay(data,Adapter);
  assert.deepEqual(calls,[['predict',0],['label',0],['predict',100]]);
  assert.equal(report.rows[0].adapted,100);assert.equal(report.rows[0].reference,null);
  assert.equal(report.rows[1].adapted,25);assert.equal(report.adaptedBrightness.meanAbsoluteError,5);assert.equal(report.adaptedBrightness.labeled,1);
  assert.equal(report.realDataAcceptancePassed,false);
});
