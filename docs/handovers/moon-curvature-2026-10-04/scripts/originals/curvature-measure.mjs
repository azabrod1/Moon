import fs from 'node:fs';
import sharp from 'sharp';
import { Vector3,Quaternion } from 'three';
const base='/tmp/moon-shots/curvature-investigation/isolation';
const report=JSON.parse(fs.readFileSync(`${base}/records.json`));
const images={};
for(const key of ['01-default','04-no-relief','05-no-synthesis','06-default-repeat','07-mask-default','08-mask-perspective','09-mask-fine']){
 images[key]=await sharp(`${base}/${key}.png`).removeAlpha().raw().toBuffer({resolveWithObject:true});
}
function edge(im,x){let n=0;for(let y=30;y<im.info.height;y++){const i=(y*im.info.width+x)*3;n=im.data[i]>128&&im.data[i+1]>128&&im.data[i+2]>128?n+1:0;if(n===12)return y-11;}return null;}
function analytic(rec,x,y,W,H){
 const s=rec.strength,D=(1-s)*Math.tan(Math.PI/6)+s*2*Math.tan(Math.PI/12);
 const px=(x+.5-W/2)/(H/2),py=(H/2-y-.5)/(H/2),rad=Math.hypot(px,py),goal=rad*D;
 let lo=0,hi=Math.PI/2-.0001;
 for(let i=0;i<50;i++){const t=(lo+hi)/2,v=(1-s)*Math.tan(t)+s*2*Math.tan(t/2);if(v<goal)lo=t;else hi=t;}
 const t=(lo+hi)/2,dir=new Vector3(rad?Math.sin(t)*px/rad:0,rad?Math.sin(t)*py/rad:0,-Math.cos(t)).applyQuaternion(new Quaternion(...rec.camera.quaternion));
 const c=new Vector3(...rec.moon.position).sub(new Vector3(...rec.camera.position));const d=c.length(),r=rec.probe.renderedRadiusAU;
 return dir.dot(c.normalize())-Math.sqrt(1-r*r/d/d);
}
const masks=[];
for(const key of ['07-mask-default','08-mask-perspective','09-mask-fine']){
 const rec=report.records.find(x=>x.label===key),im=images[key],W=im.info.width,H=im.info.height;
 const rows=[];
 for(let x=5;x<W-5;x+=5){const actual=edge(im,x);if(actual===null)continue;let lo=0,hi=H-1;if(analytic(rec,x,lo,W,H)>0||analytic(rec,x,hi,W,H)<0)continue;for(let i=0;i<35;i++){let mid=(lo+hi)/2;if(analytic(rec,x,mid,W,H)<0)lo=mid;else hi=mid;}rows.push({x,actual,predicted:(lo+hi)/2,error:actual-(lo+hi)/2});}
 const errors=rows.map(r=>Math.abs(r.error));
 masks.push({key,meanErrorPx:errors.reduce((a,b)=>a+b)/errors.length,maxErrorPx:Math.max(...errors),left:edge(im,5),center:edge(im,720),right:edge(im,1430),sag:((edge(im,5)+edge(im,1430))/2-edge(im,720)),rows});
}
const diffs=[];const ref=images['01-default'];
for(const key of ['04-no-relief','05-no-synthesis','06-default-repeat']){
 const im=images[key];let sum=0,n=0,over=0,max=0;
 for(let y=300;y<ref.info.height-20;y++)for(let x=30;x<ref.info.width-30;x++){
  const i=(y*ref.info.width+x)*3;let d=0;for(let c=0;c<3;c++){let v=Math.abs(im.data[i+c]-ref.data[i+c]);sum+=v;d=Math.max(d,v);max=Math.max(max,v);n++;}if(d>1)over++;
 }
 diffs.push({key,meanChannelDifference:sum/n,pctPixelsOver1:over/(n/3)*100,max});
}
const fine=images['09-mask-fine'],coarse=images['07-mask-default'];let changed=0;
for(let x=0;x<fine.info.width;x++)if(edge(fine,x)!==edge(coarse,x))changed++;
const summary={masks:masks.map(({rows,...x})=>x),diffs,columnsWhoseEdgeMovedWithFineMesh:changed};
console.log(JSON.stringify(summary,null,2));fs.writeFileSync(`${base}/measurements.json`,JSON.stringify({summary,masks},null,2));
