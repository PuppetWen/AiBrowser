'use strict';

const fs = require('fs');
const path = require('path');

const targets = [
  {
    file: path.join(__dirname, '..', 'pet-runtime', 'mmd-pmx-vendor.js'),
    replacements: [
      [[
        'function _F(){return{mode:`phase`,assignments:{}}}',
        'function _F(){return{mode:`ordered-random`,assignments:{}}}',
      ], 'function _F(){return{mode:`by-state`,assignments:{}}}'],
      ['be=()=>{me=[...de];', 'be=e=>{me=[...e];'],
      [
        'xe=()=>{let e=fe.assignments[ae]??[];if(e.length>0){let t=new Set(e),n=de.filter(e=>t.has(e.id??re(e)));if(n.length>0)return n}return t.motionClips?.[ae]??[]}',
        'xe=()=>{if(fe.mode!==`by-state`)return de;let e=fe.assignments[ae]??[];if(e.length>0){let t=new Set(e),n=de.filter(e=>t.has(e.id??re(e)));if(n.length>0)return n}return t.motionClips?.[ae]??[]}',
      ],
      [
        [
          'Se=e=>{if(fe.mode===`random`){me.length===0&&be();let e=me.shift();return he=e===void 0?void 0:e.id??re(e),e}let t=xe();if(t.length===0)return;let n=ue.get(ae)??0,r=e?(n+1)%t.length:Math.min(n,t.length-1);return ue.set(ae,r),t[r]}',
          'Se=e=>{let t=xe();if(t.length===0)return;if(fe.mode===`random`)return t[Math.floor(Math.random()*t.length)];if(fe.mode===`shuffle`){me.length===0&&be(t);let e=me.shift();return he=e===void 0?void 0:e.id??re(e),e}let n=ue.get(ae);n===void 0&&(n=Math.floor(Math.random()*t.length));let r=e?(n+1)%t.length:Math.min(n,t.length-1);return ue.set(ae,r),t[r]}',
        ],
        'Se=e=>{let t=xe();if(t.length===0)return;if(fe.mode===`all-random-once`)return e?void 0:t[Math.floor(Math.random()*t.length)];if(fe.mode===`all-shuffle`){me.length===0&&be(t);let e=me.shift();return he=e===void 0?void 0:e.id??re(e),e}let n=ue.get(ae)??0,r=e?(n+1)%t.length:Math.min(n,t.length-1);return ue.set(ae,r),t[r]}',
      ],
      [
        [
          'setPhase(e){if(ae===e||(ae=e,fe.mode===`random`))return;let t=xe();t.length>1&&ue.set(ae,((ue.get(ae)??-1)+1)%t.length),Ce(!1)}',
          'setPhase(e){if(ae===e)return;ae=e,me=[],Ce(!1)}',
        ],
        'setPhase(e){if(ae===e&&fe.mode!==`all-random-once`)return;ae=e,me=[],ue.delete(ae),Ce(!1)}',
      ],
      [
        'c.ambientColor=t.modelKind===`humanoid`?new _i(.34,.37,.46):new _i(.62,.66,.78);',
        'c.ambientColor=t.modelKind===`humanoid`?new _i(.34,.37,.46):new _i(.62,.66,.78),c.imageProcessingConfiguration.toneMappingEnabled=!0,c.imageProcessingConfiguration.toneMappingType=1,c.imageProcessingConfiguration.exposure=.82,c.imageProcessingConfiguration.contrast=1.05;',
      ],
      ['u.intensity=t.modelKind===`humanoid`?.82:1.15', 'u.intensity=t.modelKind===`humanoid`?.72:.86'],
      ['d.intensity=t.modelKind===`humanoid`?.9:1.25', 'd.intensity=t.modelKind===`humanoid`?.82:.95'],
      [
        'a=t.modelKind===`humanoid`?1.46:1.27;',
        'a=(t.modelKind===`humanoid`?1.46:1.27)*(t.viewportOverscan??1);',
      ],
    ],
  },
  {
    file: path.join(__dirname, '..', 'pet-runtime', 'mmd-humanoid-vendor.js'),
    replacements: [
      [[
        'function QG(){return{mode:`phase`,assignments:{}}}',
        'function QG(){return{mode:`ordered-random`,assignments:{}}}',
      ], 'function QG(){return{mode:`by-state`,assignments:{}}}'],
      ['be=()=>{he=[...fe];', 'be=e=>{he=[...e];'],
      [
        'xe=()=>{let e=pe.assignments[oe]??[];if(e.length>0){let t=new Set(e),n=fe.filter(e=>t.has(e.id??re(e)));if(n.length>0)return n}return t.motionClips?.[oe]??[]}',
        'xe=()=>{if(pe.mode!==`by-state`)return fe;let e=pe.assignments[oe]??[];if(e.length>0){let t=new Set(e),n=fe.filter(e=>t.has(e.id??re(e)));if(n.length>0)return n}return t.motionClips?.[oe]??[]}',
      ],
      [
        [
          'F=e=>{if(pe.mode===`random`){he.length===0&&be();let e=he.shift();return ge=e===void 0?void 0:e.id??re(e),e}let t=xe();if(t.length===0)return;let n=de.get(oe)??0,r=e?(n+1)%t.length:Math.min(n,t.length-1);return de.set(oe,r),t[r]}',
          'F=e=>{let t=xe();if(t.length===0)return;if(pe.mode===`random`)return t[Math.floor(Math.random()*t.length)];if(pe.mode===`shuffle`){he.length===0&&be(t);let e=he.shift();return ge=e===void 0?void 0:e.id??re(e),e}let n=de.get(oe);n===void 0&&(n=Math.floor(Math.random()*t.length));let r=e?(n+1)%t.length:Math.min(n,t.length-1);return de.set(oe,r),t[r]}',
        ],
        'F=e=>{let t=xe();if(t.length===0)return;if(pe.mode===`all-random-once`)return e?void 0:t[Math.floor(Math.random()*t.length)];if(pe.mode===`all-shuffle`){he.length===0&&be(t);let e=he.shift();return ge=e===void 0?void 0:e.id??re(e),e}let n=de.get(oe)??0,r=e?(n+1)%t.length:Math.min(n,t.length-1);return de.set(oe,r),t[r]}',
      ],
      [
        [
          'setPhase(e){if(oe===e||(oe=e,pe.mode===`random`))return;let t=xe();t.length>1&&de.set(oe,((de.get(oe)??-1)+1)%t.length),Se(!1)}',
          'setPhase(e){if(oe===e)return;oe=e,he=[],Se(!1)}',
        ],
        'setPhase(e){if(oe===e&&pe.mode!==`all-random-once`)return;oe=e,he=[],de.delete(oe),Se(!1)}',
      ],
      [
        'c.ambientColor=t.modelKind===`humanoid`?new De(.34,.37,.46):new De(.62,.66,.78);',
        'c.ambientColor=t.modelKind===`humanoid`?new De(.34,.37,.46):new De(.62,.66,.78),c.imageProcessingConfiguration.toneMappingEnabled=!0,c.imageProcessingConfiguration.toneMappingType=1,c.imageProcessingConfiguration.exposure=.82,c.imageProcessingConfiguration.contrast=1.05;',
      ],
      ['u.intensity=t.modelKind===`humanoid`?.82:1.15', 'u.intensity=t.modelKind===`humanoid`?.72:.86'],
      ['d.intensity=t.modelKind===`humanoid`?.9:1.25', 'd.intensity=t.modelKind===`humanoid`?.82:.95'],
      [
        'a=t.modelKind===`humanoid`?1.46:1.27;',
        'a=(t.modelKind===`humanoid`?1.46:1.27)*(t.viewportOverscan??1);',
      ],
    ],
  },
];

const visualMarker = 'for(let e of u)e.alwaysSelectAsActiveMesh=!0;let d=u[0];';
const visualPatch = 'let _petVisualGuards=u.map(e=>{let t=e.material?.subMaterials??[e.material];return{mesh:e,materials:t.filter(Boolean).map(e=>({material:e,alpha:e.alpha,diffuseColor:e.diffuseColor?.clone?.(),albedoColor:e.albedoColor?.clone?.(),ambientColor:e.ambientColor?.clone?.(),emissiveColor:e.emissiveColor?.clone?.(),specularColor:e.specularColor?.clone?.(),diffuseTexture:e.diffuseTexture,albedoTexture:e.albedoTexture,transparencyMode:e.transparencyMode,useAlphaFromDiffuseTexture:e.useAlphaFromDiffuseTexture,forceDepthWrite:e.forceDepthWrite,diffuseHasAlpha:e.diffuseTexture?.hasAlpha}))}}),_stabilizePetVisuals=()=>{for(let e of _petVisualGuards){e.mesh.alwaysSelectAsActiveMesh=!0,e.mesh.isVisible=!0,e.mesh.visibility=1,e.mesh.overrideMaterialSideOrientation=2;for(let t of e.materials){let n=t.material;n.alpha=t.alpha,n.backFaceCulling=!1,n.twoSidedLighting=!0,n.separateCullingPass=!0,n.needDepthPrePass=!0,n.transparencyMode=t.transparencyMode,n.useAlphaFromDiffuseTexture=t.useAlphaFromDiffuseTexture,n.forceDepthWrite=t.forceDepthWrite,t.diffuseColor&&n.diffuseColor?.copyFrom?.(t.diffuseColor),t.albedoColor&&n.albedoColor?.copyFrom?.(t.albedoColor),t.ambientColor&&n.ambientColor?.copyFrom?.(t.ambientColor),t.emissiveColor&&n.emissiveColor?.copyFrom?.(t.emissiveColor),t.specularColor&&n.specularColor?.copyFrom?.(t.specularColor),`diffuseTexture`in n&&(n.diffuseTexture=t.diffuseTexture),`albedoTexture`in n&&(n.albedoTexture=t.albedoTexture),t.diffuseTexture&&t.diffuseHasAlpha!==void 0&&(t.diffuseTexture.hasAlpha=t.diffuseHasAlpha)}}};_stabilizePetVisuals();let d=u[0];';

for (const target of targets) {
  let source = fs.readFileSync(target.file, 'utf8');
  let changed = false;
  for (const movingOverride of [
    'setMoving(e){e?s.stopRenderLoop(Ee):(Te=0,s.runRenderLoop(Ee))},',
    'setMoving(e){e?s.stopRenderLoop(Te):(we=0,s.runRenderLoop(Te))},',
  ]) {
    if (source.includes(movingOverride)) {
      source = source.replace(movingOverride, '');
      changed = true;
    }
  }
  for (const [beforeValue, after] of target.replacements) {
    if (source.includes(after)) continue;
    const candidates = Array.isArray(beforeValue) ? beforeValue : [beforeValue];
    const before = candidates.find((candidate) => source.split(candidate).length - 1 === 1);
    if (!before) throw new Error(`${path.basename(target.file)}: expected one vendor patch target`);
    source = source.replace(before, after);
    changed = true;
  }
  if (!source.includes('_stabilizePetVisuals')) {
    const markerMatches = source.split(visualMarker).length - 1;
    if (markerMatches !== 1) throw new Error(`${path.basename(target.file)}: expected one visual guard target, found ${markerMatches}`);
    source = source.replace(visualMarker, visualPatch);
    const phaseIndex = source.indexOf('setPhase(e){', source.indexOf('_stabilizePetVisuals'));
    const renderIndex = source.lastIndexOf('c.render()}', phaseIndex);
    if (phaseIndex < 0 || renderIndex < 0) throw new Error(`${path.basename(target.file)}: render-loop target not found`);
    source = source.slice(0, renderIndex) + '_stabilizePetVisuals(),c.render()}' + source.slice(renderIndex + 'c.render()}'.length);
    changed = true;
  }
  if (source.includes('_stabilizePetVisuals') && !source.includes('n.separateCullingPass=!0,n.needDepthPrePass=!0')) {
    const upgrades = [
      [
        'diffuseTexture:e.diffuseTexture,albedoTexture:e.albedoTexture',
        'diffuseTexture:e.diffuseTexture,albedoTexture:e.albedoTexture,transparencyMode:e.transparencyMode,useAlphaFromDiffuseTexture:e.useAlphaFromDiffuseTexture,forceDepthWrite:e.forceDepthWrite,diffuseHasAlpha:e.diffuseTexture?.hasAlpha',
      ],
      [
        'n.alpha=t.alpha,n.backFaceCulling=!1,n.twoSidedLighting=!0,',
        'n.alpha=t.alpha,n.backFaceCulling=!1,n.twoSidedLighting=!0,n.separateCullingPass=!0,n.needDepthPrePass=!0,n.transparencyMode=t.transparencyMode,n.useAlphaFromDiffuseTexture=t.useAlphaFromDiffuseTexture,n.forceDepthWrite=t.forceDepthWrite,',
      ],
      [
        '`albedoTexture`in n&&(n.albedoTexture=t.albedoTexture)',
        '`albedoTexture`in n&&(n.albedoTexture=t.albedoTexture),t.diffuseTexture&&t.diffuseHasAlpha!==void 0&&(t.diffuseTexture.hasAlpha=t.diffuseHasAlpha)',
      ],
    ];
    for (const [before, after] of upgrades) {
      const matches = source.split(before).length - 1;
      if (matches !== 1) throw new Error(`${path.basename(target.file)}: expected one visual stability upgrade target, found ${matches}`);
      source = source.replace(before, after);
    }
    changed = true;
  }
  const hatMarker = ',isHat:/hat|草帽|帽子/i.test([e.name,e.diffuseTexture?.name,e.diffuseTexture?.url].join(`|`))';
  const hatOverride = ',t.isHat&&(n.alpha=1,n.transparencyMode=0,n.useAlphaFromDiffuseTexture=!1,n.forceDepthWrite=!0,n.disableLighting=!0,n.specularColor?.set?.(0,0,0),n.specularPower=1,n.zOffset=-1)';
  if (source.includes(hatMarker)) {
    source = source.replace(hatMarker, '');
    changed = true;
  }
  if (source.includes(hatOverride)) {
    source = source.replace(hatOverride, '');
    changed = true;
  }
  if (source.includes('_stabilizePetVisuals') && !source.includes('e.mesh.overrideMaterialSideOrientation=2')) {
    const before = 'e.mesh.alwaysSelectAsActiveMesh=!0,e.mesh.isVisible=!0,e.mesh.visibility=1;';
    const after = 'e.mesh.alwaysSelectAsActiveMesh=!0,e.mesh.isVisible=!0,e.mesh.visibility=1,e.mesh.overrideMaterialSideOrientation=2;';
    const matches = source.split(before).length - 1;
    if (matches !== 1) throw new Error(`${path.basename(target.file)}: expected one double-sided mesh target, found ${matches}`);
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) fs.writeFileSync(target.file, source, 'utf8');
  console.log(`[pet-vendor] ${path.basename(target.file)} ${changed ? 'patched' : 'already patched'}`);
}
