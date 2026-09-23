// Feature order and extraction settings travel with datasets and model artifacts.
export const FEATURE_VERSION = 1;
export function featureNames(config) {
  const names = ['mean','p10','p50','p90','contrast','saturation','red','green','blue','dark','clipped','red_ratio','green_ratio','blue_ratio'];
  for (let i = 0; i < config.columns * config.rows; i++)
    for (const channel of ['luma','relative','red','green','blue','saturation','red_ratio','green_ratio','blue_ratio']) names.push(`cell${i}_${channel}`);
  names.push('bright_count','bright_area','bright_intensity','bright_x','bright_y');
  for (let i = 0; i < config.columns * config.rows; i++) names.push(`bright_cell${i}`);
  return names;
}

export function extractFeatures(image, config) {
  const { width, height, data } = image, n = width * height;
  if (!n || data.length !== n * 4 || width < config.columns || height < config.rows) throw new Error('Invalid feature frame.');
  const cells = Array.from({ length: config.columns * config.rows }, () => ({ n:0, sum:0, sq:0, r:0, g:0, b:0, sat:0 }));
  const histogram = new Uint32Array(256), luma = new Float32Array(n), cellIndex = new Uint16Array(n);
  let sum = 0, sq = 0, saturation = 0, red = 0, green = 0, blue = 0, dark = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i*4]/255, g = data[i*4+1]/255, b = data[i*4+2]/255;
    const y = 0.299*r+0.587*g+0.114*b, max = Math.max(r,g,b), min = Math.min(r,g,b);
    const sat = max ? (max-min)/max : 0;
    const cell = Math.floor(Math.floor(i/width)*config.rows/height)*config.columns + Math.floor((i%width)*config.columns/width);
    cellIndex[i] = cell; luma[i] = y; histogram[Math.round(y*255)]++;
    const c = cells[cell]; c.n++; c.sum+=y; c.sq+=y*y; c.r+=r; c.g+=g; c.b+=b; c.sat+=sat;
    sum+=y; sq+=y*y; red+=r; green+=g; blue+=b; saturation+=sat;
    dark += y <= config.darkThreshold; clipped += max >= config.clipThreshold;
  }
  const mean = sum/n, contrast = Math.sqrt(Math.max(0,sq/n-mean*mean));
  const percentile = fraction => {
    let count=0; for (let i=0;i<256;i++) { count+=histogram[i]; if (count >= n*fraction) return i/255; } return 1;
  };
  const features = [mean,percentile(.1),percentile(.5),percentile(.9),contrast,saturation/n,red/n,green/n,blue/n,dark/n,clipped/n,red/Math.max(red+green+blue,config.normalizationFloor*n),green/Math.max(red+green+blue,config.normalizationFloor*n),blue/Math.max(red+green+blue,config.normalizationFloor*n)];
  for (const c of cells) {
    const colorTotal=Math.max(c.r+c.g+c.b,config.normalizationFloor*c.n);
    features.push(c.sum/c.n,(c.sum/c.n-mean)/Math.max(contrast,config.normalizationFloor),c.r/c.n,c.g/c.n,c.b/c.n,c.sat/c.n,c.r/colorTotal,c.g/colorTotal,c.b/colorTotal);
  }
  const thresholds = cells.map(c => Math.min(config.brightCeiling, Math.max(config.brightFloor,c.sum/c.n+config.localSigma*Math.sqrt(Math.max(0,c.sq/c.n-(c.sum/c.n)**2)))));
  const mask = new Uint8Array(n);
  for (let i=0;i<n;i++) mask[i] = luma[i] > thresholds[cellIndex[i]] ? 1 : 0;
  const regions = [], distribution = new Array(cells.length).fill(0), queue = new Int32Array(n);
  let area=0, intensity=0, sx=0, sy=0;
  for (let start=0;start<n;start++) {
    if (!mask[start]) continue;
    let head=0, tail=1, rx=0, ry=0, ri=0; queue[0]=start; mask[start]=0;
    while (head<tail) {
      const i=queue[head++], x=i%width, y=Math.floor(i/width); rx+=x; ry+=y; ri+=luma[i];
      for (const j of [x>0?i-1:-1,x<width-1?i+1:-1,y>0?i-width:-1,y<height-1?i+width:-1])
        if (j>=0 && mask[j]) { mask[j]=0; queue[tail++]=j; }
    }
    if (tail < config.minRegionPixels) continue;
    area+=tail; intensity+=ri; sx+=rx; sy+=ry;
    regions.push({ point:[rx/tail,ry/tail], area:tail/n, intensity:ri/tail });
    for (let j=0;j<tail;j++) distribution[cellIndex[queue[j]]]++;
  }
  features.push(regions.length,area/n,area?intensity/area:0,area?sx/area/width:0,area?sy/area/height:0,...distribution.map((v,i)=>v/cells[i].n));
  return { features, regions, summary:{ mean,contrast,saturation:saturation/n,dark:dark/n,clipped:clipped/n } };
}
