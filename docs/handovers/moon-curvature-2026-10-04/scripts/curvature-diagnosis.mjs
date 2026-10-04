import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { takeBrowserLock } from '../../../../tools/browserLock.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repoRoot=fileURLToPath(new URL('../../../../',import.meta.url));
const out=process.env.MOON_CURVATURE_OUT || path.join(repoRoot,'planning/moon-curvature-new/isolation');
const baseUrl=process.env.MOON_CURVATURE_URL || 'http://localhost:5757';
const angle=process.env.MOON_CURVATURE_ANGLE || (process.platform==='darwin'?'metal':'swiftshader');
await mkdir(out,{recursive:true});
const unlock=await takeBrowserLock('curvature-isolation');
const browser=await chromium.launch({headless:true,executablePath:process.env.PW_CHROMIUM || undefined,args:['--use-gl=angle',`--use-angle=${angle}`,'--enable-gpu','--ignore-gpu-blocklist',...(angle==='swiftshader'?['--enable-unsafe-swiftshader']:[])]});
const errors=[],warnings=[],failedRequests=[],records=[];
try {
 const page=await browser.newPage({viewport:{width:1440,height:902},deviceScaleFactor:1});
 await page.addInitScript(()=>{localStorage.clear();sessionStorage.clear();indexedDB.deleteDatabase('orbital-sim-storage');localStorage.setItem('planetarium-help-seen','1');});
 page.on('pageerror',e=>{errors.push(String(e));console.log('PAGE ERROR',String(e));});
 page.on('console',m=>{if(['error','warning'].includes(m.type()))warnings.push(m.text());});
 page.on('requestfailed',r=>failedRequests.push({url:r.url(),reason:r.failure()}));
 await page.goto(`${baseUrl.replace(/\/$/,'')}/?auto=planetarium&quality=high`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__moon?.ready(),{timeout:180000});
 await page.waitForFunction(()=>document.getElementById('loading-screen')?.classList.contains('hidden'),{timeout:180000});
 const draw=(n=3)=>page.evaluate(n=>Promise.race([window.__moon.waitForDraw(n),new Promise((_,rej)=>setTimeout(()=>rej(Error('No rendered frame in 15 seconds')),15000))]),n);
 await page.evaluate(async()=>{
  const m=window.__moon;
  m.setTimeMs(Date.parse('2026-10-04T08:00:00Z'));m.setTimeRate(0);m.setChrome(false);m.setBeltVisible(false);m.setAutoExposure(false);m.pinCapture({exposure:1,pixelRatio:1,near:1e-9});
  m.setNightSides('real');m.setLensRamp(false);m.frame('Moon',1,80,1.1603,0,0,90);m.setFov(60);
  window.diagThree=await import('/node_modules/three/build/three.module.js');
  window.diagShade=await import('/src/planetarium/world/surfaceShading.ts');
 });
 await draw(5);
 await page.evaluate(()=>{
  window.diagMoon=window.__moon.scene().getObjectByName('Moon');
  window.diagCam=window.__moon.composerPasses().find(p=>p.camera?.isPerspectiveCamera)?.camera;
  if(!window.diagCam)throw Error('No render camera found');
  window.diagMode='normal';
  window.diagFlat=new window.diagThree.MeshBasicMaterial({color:0xffffff});
  const m=window.diagMoon;
  window.diagOriginalGeometry=m.geometry;
  const p=m.geometry.parameters;
  window.diagFineGeometry=new window.diagThree.SphereGeometry(p.radius,1024,512);
  window.diagMaskScene=new window.diagThree.Scene();
  window.diagMaskMesh=new window.diagThree.Mesh(m.geometry,window.diagFlat);
  window.diagMaskMesh.matrixAutoUpdate=false;
  window.diagMaskScene.add(window.diagMaskMesh);
 });
 async function pose(h=278.5,phase=70,roll=270){
  await page.evaluate(({h,phase,roll})=>{
   const m=window.__moon,T=window.diagThree;
   m.setLens(1);m.frame('Moon',1,phase,1+h/1737.4,0,0,roll);m.setFov(60);m.setShipVisible(false);
   const c=window.diagCam;c.updateMatrixWorld(true);
   const p=m.probe('Moon');const sun=new T.Vector3(-p.bodyAbs.x,-p.bodyAbs.y,-p.bodyAbs.z).normalize().transformDirection(c.matrixWorldInverse);
   c.rotateZ(Math.atan2(sun.y,sun.x)-Math.PI);
   c.rotateX(35.8689*Math.PI/180);c.rotateY(2.7*Math.PI/180);c.updateMatrixWorld(true);
  },{h,phase,roll});
  await draw(4);await page.waitForTimeout(5000);await draw(3);
  await page.evaluate(()=>{
   window.diagMoon.traverse(o=>{
    if(!o.isMesh||o.userData.diagInstalled)return;
    o.userData.diagInstalled=true;const original=o.material,fn=o.onBeforeRender;o.userData.diagOriginalMaterial=original;
    o.onBeforeRender=function(...args){
     fn.apply(this,args);
     if(window.diagMode==='no-synth')window.diagShade.setSurfaceSynthesis(original,0,'measured');
    };
   });
  });
 }
 async function capture(label,strength=1,mode='normal'){
  await page.evaluate(({strength,mode})=>{
   const m=window.__moon;window.diagMode=mode;m.setLens(strength);
   const rp=m.composerPasses().find(p=>p.camera?.isPerspectiveCamera);
   window.diagMaskMesh.matrix.copy(window.diagMoon.matrixWorld);
   rp.scene=mode==='mask'?window.diagMaskScene:m.scene();
   const mat=window.diagMoon.userData.diagOriginalMaterial;
   mat.normalScale.set(mode==='no-relief'?0:1,mode==='no-relief'?0:1);
  },{strength,mode});
  await draw(4);await page.waitForTimeout(250);await draw(2);
  const record=await page.evaluate(()=>{
   const m=window.__moon,mesh=window.diagMoon,c=window.diagCam,T=window.diagThree;
   const center=mesh.getWorldPosition(new T.Vector3());
   const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');
   const maps=[];mesh.traverse(o=>{if(o.isMesh)maps.push({name:o.name,geometry:o.geometry.parameters,scale:o.scale.toArray(),normalScale:o.material.normalScale?.toArray(),color:o.material.map?.image?.width,normal:o.material.normalMap?.image?.width});});
   return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,probe:m.probe('Moon'),camAltitudeKm:c.position.distanceTo(center)*149597870.7-1737.4,camera:{position:c.position.toArray(),quaternion:c.quaternion.toArray(),near:c.near,projection:c.projectionMatrix.toArray(),lens:c.userData.lens},moon:{position:center.toArray(),scale:mesh.scale.toArray(),matrixWorld:mesh.matrixWorld.toArray()},maps,density:m.surfaceDensity(),sectors:m.sectors(),ladder:m.ladder()};
  });
  await page.screenshot({path:`${out}/${label}.png`});
  records.push({label,strength,mode,...record});
  console.log(label,JSON.stringify({camAltitudeKm:record.camAltitudeKm,gpu:record.gpu,normal:record.maps[0]?.normal,color:record.maps[0]?.color,segments:record.maps[0]?.geometry?.widthSegments,scale:record.moon.scale}));
 }
 await pose();
 await capture('01-default');
 await capture('02-half-lens',0.48);
 await capture('03-perspective',0);
 await capture('04-no-relief',1,'no-relief');
 await capture('05-no-synthesis',1,'no-synth');
 await capture('06-default-repeat');
 await capture('07-mask-default',1,'mask');
 await capture('08-mask-perspective',0,'mask');
 await page.evaluate(()=>{window.diagMaskMesh.geometry=window.diagFineGeometry;});
 await capture('09-mask-fine',1,'mask');
 await page.evaluate(()=>{window.diagMaskMesh.geometry=window.diagOriginalGeometry;});
 for(const h of [68,1000]){
  await pose(h);
  await capture(`alt-${h}-default`);
  await capture(`alt-${h}-perspective`,0);
 }
 await page.setViewportSize({width:390,height:844});
 await pose();await capture('phone-default');await capture('phone-perspective',0);
 console.log('Finished',JSON.stringify({errors,warnings:warnings.slice(0,8),failedRequests:failedRequests.slice(0,8)}));
 await writeFile(`${out}/records.json`,JSON.stringify({url:page.url(),title:await page.title(),errors,warnings,failedRequests,records},null,2));
} finally {await browser.close();unlock();}
