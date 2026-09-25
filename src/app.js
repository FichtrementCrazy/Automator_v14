const $ = s => document.querySelector(s);
const canvas = $('#canvas');

if (!window.blockflow) {
  window.blockflow = {
    runWorkflow: async () => { throw new Error('Prévisualisation navigateur : exécution Windows désactivée.'); },
    stopWorkflow: async () => true,
    saveWorkflow: async () => null,
    exportRunnable: async () => null,
    createDesktopShortcut: async () => null,
    openWorkflow: async () => null,
    browseProgram: async () => null,
    getCursorPosition: async () => ({x: 0, y: 0}),
    startMouseCapture: async () => true,
    stopMouseCapture: async () => true,
    onRunnerEvent: () => {},
  };
}

let zoom = 1;
let selected = null;
let running = false;
let dirty = false;
let history = [];
let future = [];
let editSnapshot = null;
let capturingPositionBlock = null;

let workflow = {version: 7, name: 'Mon workflow', blocks: []};

const palette = {
  input: [
    ['launch', 'Lancer un programme', 'Nom, fichier ou programme système'],
    ['set-variable', 'Définir une variable', 'Stocke une valeur'],
    ['change-variable', 'Modifier une variable', 'Ajoute ou retire une valeur'],
  ],
  mouse: [
    ['mouse-click', 'Clic souris', 'Gauche / droit / molette'],
    ['mouse-double', 'Double-clic', 'Double-clic gauche'],
    ['mouse-move', 'Déplacer la souris', 'Coordonnées ou capture Ctrl'],
    ['mouse-scroll', 'Faire défiler', 'Position + unités'],
  ],
  key: [
    ['keyboard-type', 'Taper au clavier', 'Texte ou variable'],
    ['keyboard-key', 'Appuyer sur une touche', 'Entrée, Échap, F…'],
    ['keyboard-hotkey', 'Raccourci clavier', 'Jusqu’à 3 touches Ctrl / Alt / Windows / Maj + 1 touche'],
  ],
  window: [
    ['window-activate', 'Activer une fenêtre / un programme', 'Cible : titre de fenêtre ou nom du programme'],
    ['window-close', 'Fermer une fenêtre / un programme', 'Cible : titre de fenêtre ou nom du programme'],
    ['wait-window', 'Attendre une fenêtre / un programme', 'Cible : titre de fenêtre ou nom du programme'],
    ['window-test', 'Tester une fenêtre / un programme', 'Écrit True ou False dans une variable'],
    ['active-title', 'Lire le titre actif', 'Fenêtre active ou programme à l’origine de la fenêtre'],
  ],
  control: [
    ['if', 'Si / Sinon', 'Condition + branches imbriquées'],
    ['repeat', 'Répéter', 'Nombre de fois'],
    ['while', 'Tant que', 'Condition + blocs imbriqués'],
    ['wait', 'Attendre', 'Millisecondes ou secondes'],
    ['stop', 'Arrêter', 'Stop immédiat'],
  ],
  data: [
    ['log', 'Journal', 'Écrire un message'],
  ],
};

const labels = {input:'Actions & données', mouse:'Souris', key:'Clavier', window:'Fenêtres', control:'Contrôle', data:'Données'};
const catClass = {input:'cat-input', mouse:'cat-mouse', key:'cat-key', window:'cat-window', control:'cat-control', data:'cat-data'};

const KEY_OPTIONS = [
  'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
  '0','1','2','3','4','5','6','7','8','9',
  'ENTER','TAB','ESC','SPACE','BACKSPACE','DELETE','INSERT','HOME','END','PGUP','PGDN',
  'UP','DOWN','LEFT','RIGHT','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
];

function id(){ return 'b' + Math.random().toString(36).slice(2,10); }
function deepClone(x){ return JSON.parse(JSON.stringify(x)); }
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function snapshot(){ return JSON.stringify(workflow); }
function countBlocks(list){ return (list || []).reduce((n,b)=>n+1+['children','then','else'].reduce((m,k)=>m+countBlocks(b[k] || []),0),0); }

const EXPR_OPERATORS = [
  {value:'+',label:'+'},{value:'-',label:'−'},{value:'*',label:'×'},{value:'/',label:'÷'},{value:'%',label:'mod'},{value:'^',label:'puissance'}
];
function literal(value){ return {kind:'literal', value}; }
function variable(name, literalValue=''){ return {kind:'var', name, literalValue}; }
function binary(op='+', left=literal(0), right=literal(0)){ return {kind:'binary', op, left:normalizeExpr(left), right:normalizeExpr(right)}; }
function normalizeExpr(v){
  if(v && typeof v==='object'){
    if(v.kind==='literal') return {kind:'literal',value:v.value??''};
    if(v.kind==='var') return {kind:'var',name:String(v.name||''),literalValue:v.literalValue??''};
    if(v.kind==='binary') return binary(EXPR_OPERATORS.some(o=>o.value===v.op)?v.op:'+',v.left,v.right);
  }
  return literal(v??'');
}
function exprValue(v,vars){
  const e=normalizeExpr(v);
  if(e.kind==='var') return vars[e.name]??'';
  if(e.kind==='literal') return e.value;
  const left=exprValue(e.left,vars),right=exprValue(e.right,vars),ln=Number(left),rn=Number(right);
  const numeric=Number.isFinite(ln)&&Number.isFinite(rn)&&left!==''&&right!=='';
  if(e.op==='+'&&!numeric)return String(left??'')+String(right??'');
  if(!numeric)throw new Error('Les opérandes de ce calcul doivent être numériques.');
  if(e.op==='/'&&rn===0)throw new Error('Division par zéro.');
  if(e.op==='%'&&rn===0)throw new Error('Modulo par zéro.');
  return e.op==='+'?ln+rn:e.op==='-'?ln-rn:e.op==='*'?ln*rn:e.op==='/'?ln/rn:e.op==='%'?ln%rn:Math.pow(ln,rn);
}
function numberValue(v,vars,fallback=0){const n=Number(exprValue(v,vars));return Number.isFinite(n)?n:fallback;}
function stringValue(v,vars,fallback=''){const x=exprValue(v,vars);return x==null?fallback:String(x);}

function defaultCondition(){
  return {kind:'compare', left:literal(''), op:'equals', right:literal('')};
}

function defaults(type){
  const b = {id:id(), type};
  switch(type){
    case 'mouse-click': Object.assign(b,{button:'left',x:literal(500),y:literal(400)}); break;
    case 'mouse-double': case 'mouse-move': Object.assign(b,{x:literal(500),y:literal(400),captureMode:'coords'}); break;
    case 'mouse-scroll': Object.assign(b,{x:literal(500),y:literal(400),amount:literal(1),captureMode:'coords'}); break;
    case 'keyboard-type': b.text=literal('Bonjour !'); break;
    case 'keyboard-key': b.key='ENTER'; break;
    case 'keyboard-hotkey': b.modifiers=['CTRL','','']; b.key='L'; break;
    case 'launch': Object.assign(b,{launchMode:'name',exe:literal('notepad.exe'),filePath:literal(''),system:'explorer'}); break;
    case 'set-variable': b.name='maVariable'; b.value=literal('bonjour'); break;
    case 'change-variable': b.name='maVariable'; b.amount=literal(1); break;
    case 'window-activate': case 'window-close': case 'wait-window': case 'window-test':
      b.targetMode='title'; b.title=literal('Bloc-notes'); b.processName=literal('notepad');
      if(type==='wait-window'){b.timeout=literal(15);b.timeoutUnit='s';b.interval=literal(250);}
      if(type==='window-test') b.saveAs='fenetreExiste';
      break;
    case 'active-title': b.targetMode='title'; b.processName=literal('notepad'); b.saveAs='activeTitle'; break;
    case 'if': b.condition=defaultCondition(); b.then=[]; b.else=[]; break;
    case 'repeat': b.count=literal(3); b.children=[]; break;
    case 'while': b.condition=defaultCondition(); b.children=[]; break;
    case 'wait': b.duration=literal(500); b.unit='ms'; break;
    case 'log': b.message=literal('Bonjour depuis BlockFlow'); break;
  }
  return b;
}

function migrateCondition(c){
  if(!c) return defaultCondition();
  if(c.kind==='window-exists') return {kind:'window',title:normalizeExpr(c.title), mode:'exists'};
  if(c.kind==='process-running') return {kind:'process',processName:normalizeExpr(c.processName)};
  if(c.kind==='variable-equals') return {kind:'compare',left:variable(c.name||''),op:'equals',right:normalizeExpr(c.value)};
  if(c.kind==='variable-contains') return {kind:'compare',left:variable(c.name||''),op:'contains',right:normalizeExpr(c.value)};
  if(c.kind==='always') return {kind:'always'};
  if(c.kind==='keyboard') return {kind:'keyboard',mode:c.mode==='test'?'test':'wait',modifiers:Array.isArray(c.modifiers)?c.modifiers.slice(0,3).map(v=>['CTRL','ALT','WIN','SHIFT'].includes(v)?v:''):['','',''],key:String(c.key||'A')};
  if(c.kind==='not') return {kind:'not',item:migrateCondition(c.inner||c.item)};
  if(c.kind==='and'||c.kind==='or') return {kind:'logic',op:c.kind,items:[migrateCondition(c.left),migrateCondition(c.right)]};
  if(c.kind==='compare') return {kind:'compare',left:normalizeExpr(c.left),op:c.op||'equals',right:normalizeExpr(c.right)};
  if(c.kind==='window') return {...c,title:normalizeExpr(c.title)};
  if(c.kind==='process') return {...c,processName:normalizeExpr(c.processName)};
  if(c.kind==='logic') return {kind:'logic',op:c.op||'and',items:(c.items||[]).map(migrateCondition)};
  return defaultCondition();
}

function migrateBlock(b){
  const x=deepClone(b);
  if(['mouse-click','mouse-double','mouse-move','mouse-scroll'].includes(x.type)){ x.x=normalizeExpr(x.x); x.y=normalizeExpr(x.y); x.captureMode=x.captureMode||'coords'; if(x.amount!=null)x.amount=normalizeExpr(x.amount); }
  if(['keyboard-type','launch','window-activate','window-close','wait-window','window-exists'].includes(x.type)) x[x.type==='keyboard-type'?'text':x.type==='launch'?'exe':'title']=normalizeExpr(x[x.type==='keyboard-type'?'text':x.type==='launch'?'exe':'title']);
  if(x.type==='launch'){ x.launchMode=x.launchMode||'name'; x.filePath=normalizeExpr(x.filePath||''); x.system=x.system||'explorer'; }
  if(['process-activate','process-close','wait-process','process-running'].includes(x.type)) x.processName=normalizeExpr(x.processName);
  // Unification des anciens blocs fenêtre/programme.
  if(x.type==='process-activate'){x.type='window-activate';x.targetMode='process';x.processName=normalizeExpr(x.processName||'notepad');}
  if(x.type==='process-close'){x.type='window-close';x.targetMode='process';x.processName=normalizeExpr(x.processName||'notepad');}
  if(x.type==='wait-process'){x.type='wait-window';x.targetMode='process';x.processName=normalizeExpr(x.processName||'notepad');}
  if(x.type==='process-running'){x.type='window-test';x.targetMode='process';x.processName=normalizeExpr(x.processName||'notepad');x.saveAs=x.saveAs||'programmeExiste';}
  if(['window-activate','window-close','wait-window'].includes(x.type)){x.targetMode=x.targetMode||'title';x.title=normalizeExpr(x.title||'');x.processName=normalizeExpr(x.processName||'');}
  if(x.type==='window-exists'){x.type='window-test';x.targetMode='title';x.title=normalizeExpr(x.title||'');x.processName=normalizeExpr(x.processName||'');x.saveAs=x.saveAs||'fenetreExiste';}
  if(x.type==='window-test'){x.targetMode=x.targetMode||'title';x.title=normalizeExpr(x.title||'');x.processName=normalizeExpr(x.processName||'');x.saveAs=x.saveAs||'resultat';}
  if(x.type==='active-title'){x.targetMode=x.targetMode||'title';x.processName=normalizeExpr(x.processName||'');x.saveAs=x.saveAs||'activeTitle';}
  if(x.type==='set-variable'){x.value=normalizeExpr(x.value);}
  if(x.type==='change-variable'){x.amount=normalizeExpr(x.amount??1);}
  if(x.type==='keyboard-hotkey'){
    if(Array.isArray(x.modifiers)){
      x.modifiers=x.modifiers.slice(0,3).map(v=>['CTRL','ALT','WIN','SHIFT'].includes(v)?v:'');
      while(x.modifiers.length<3)x.modifiers.push('');
      x.key=String(x.key||'L');
    }else{
      const old=Array.isArray(x.keys)?x.keys:[];
      const mods=old.filter(k=>['CTRL','ALT','WIN','SHIFT'].includes(String(k).toUpperCase())).slice(0,3).map(k=>String(k).toUpperCase());
      x.modifiers=[...mods,'',''].slice(0,3);
      x.key=old.find(k=>!['CTRL','ALT','WIN','SHIFT'].includes(String(k).toUpperCase())) || 'L';
    }
    delete x.keys;
  }
  // Ne jamais écraser les paramètres déjà présents : les anciens formats peuvent
  // être convertis, mais un workflow moderne doit rester identique après JSON round-trip.
  if(x.type==='wait'){
    if(x.duration!==undefined){x.duration=normalizeExpr(x.duration);x.unit=x.unit==='s'?'s':'ms';}
    else{x.duration=normalizeExpr(x.ms??500);x.unit='ms';}
    delete x.ms;
  }
  if(x.type==='wait-window'){
    if(x.timeout!==undefined){x.timeout=normalizeExpr(x.timeout);x.timeoutUnit=x.timeoutUnit==='ms'?'ms':'s';}
    else{x.timeout=normalizeExpr(15);x.timeoutUnit='s';}
    x.interval=normalizeExpr(x.interval??250);
  }
  if(x.type==='wait-process'){x.timeout=normalizeExpr(x.timeout??15);x.timeoutUnit=x.timeoutUnit||'s';x.interval=normalizeExpr(x.interval??250);}
  if(x.type==='if'){x.condition=migrateCondition(x.condition);}
  if(x.type==='repeat'){x.count=normalizeExpr(x.count);}
  if(x.type==='while-window'){x.type='while';x.condition={kind:'window',title:normalizeExpr(x.title),mode:'exists'};x.children=x.children||[];delete x.title;}
  if(x.type==='log')x.message=normalizeExpr(x.message);
  for(const k of ['children','then','else']) if(Array.isArray(x[k])) x[k]=x[k].map(migrateBlock);
  return x;
}

function normalizeWorkflow(data){
  const d=deepClone(data||{});
  workflow={version:7,name:d.name||'Mon workflow',blocks:(d.blocks||[]).map(migrateBlock)};
  dirty=false;
}

function workflowForSave(){
  return {version:7,name:($('#projectName')?.value.trim()||workflow.name||'Mon workflow'),blocks:(workflow.blocks||[]).map(migrateBlock)};
}

function find(targetId,list=workflow.blocks,parent=null,key='blocks'){
  for(let i=0;i<list.length;i++){
    if(list[i].id===targetId) return {b:list[i],arr:list,index:i,parent,key};
    for(const k of ['children','then','else']) if(Array.isArray(list[i][k])){ const r=find(targetId,list[i][k],list[i],k); if(r)return r; }
  }
  return null;
}
function containsId(root,idToFind){ if(root.id===idToFind)return true; return ['children','then','else'].some(k=>(root[k]||[]).some(x=>containsId(x,idToFind))); }

function pushHistory(before=snapshot()){
  history.push(before); if(history.length>60)history.shift(); future=[]; updateHistoryButtons();
}
function applyMutation(fn){ const before=snapshot(); fn(); pushHistory(before); setDirty(true); render(); }
function setDirty(v=true){ dirty=v; $('#dirtyState').textContent=v?'Modifications non enregistrées':'Enregistré'; $('#dirtyState').classList.toggle('dirty',v); }

function addBlock(type,parent=null,zone='blocks',index=null){
  applyMutation(()=>{
    const b=defaults(type);
    const arr=parent ? (parent[zone]||(parent[zone]=[])) : workflow.blocks;
    arr.splice(index==null?arr.length:index,0,b); selected=b.id;
  });
}
function remove(targetId){ const f=find(targetId); if(!f)return; applyMutation(()=>{f.arr.splice(f.index,1);if(selected===targetId)selected=null;}); }
function duplicate(targetId){ const f=find(targetId); if(!f)return; applyMutation(()=>{const c=deepClone(f.b); const regen=o=>{o.id=id();['children','then','else'].forEach(k=>(o[k]||[]).forEach(regen));};regen(c);f.arr.splice(f.index+1,0,c);selected=c.id;}); }
function moveBlock(sourceId,targetId,before=true){
  if(sourceId===targetId)return;
  const source=find(sourceId), target=find(targetId); if(!source||!target)return;
  if(containsId(source.b,targetId)){ setStatus('Impossible : un bloc ne peut pas être placé dans son propre contenu.'); return; }
  applyMutation(()=>{
    const node=source.b; source.arr.splice(source.index,1);
    const targetNow=find(targetId); if(!targetNow)return;
    let at=targetNow.index + (before?0:1);
    if(targetNow.arr===source.arr && source.index<targetNow.index && !before) at--;
    targetNow.arr.splice(at,0,node); selected=sourceId;
  });
}

function renderPalette(){
  const root=$('#paletteGroups'); root.innerHTML=''; const q=$('#search').value.trim().toLowerCase();
  for(const [cat,items] of Object.entries(palette)){
    const filt=items.filter(x=>(x[1]+' '+x[2]).toLowerCase().includes(q)); if(!filt.length)continue;
    const h=document.createElement('div');h.className='group-title';h.textContent=labels[cat];root.appendChild(h);
    for(const [type,name,sub] of filt){
      const el=document.createElement('div');el.className='palette-block '+catClass[cat];el.draggable=true;el.dataset.type=type;
      el.innerHTML=`<b>${esc(name)}</b><small>${esc(sub)}</small>`;
      el.addEventListener('click',()=>addBlock(type));
      el.addEventListener('dragstart',e=>{e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('block-type',type);});
      root.appendChild(el);
    }
  }
}

function variableNames(){
  const names=[]; forEachBlock(workflow.blocks,b=>{
    if((b.type==='set-variable'||b.type==='change-variable')&&b.name&&!names.includes(b.name))names.push(b.name);
    if((b.type==='window-test'||b.type==='active-title')&&b.saveAs&&!names.includes(b.saveAs))names.push(b.saveAs);
  }); return names;
}
function forEachBlock(list,fn){(list||[]).forEach(b=>{fn(b);['children','then','else'].forEach(k=>forEachBlock(b[k],fn));});}
function refreshVariableMenus(){
  const vars=variableNames(); $('#variableCount').textContent=vars.length;
  const list=$('#variableList'); list.innerHTML=vars.length?vars.map(v=>`<div class="variable-chip">${esc(v)}</div>`).join(''):'<div class="variable-empty">Aucune variable définie.</div>';
  document.querySelectorAll('.expr-var-picker').forEach(sel=>{
    const current=sel.value; const html=['<option value="">Choisir une variable…</option>',...vars.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`)].join(''); sel.innerHTML=html; sel.value=current;
  });
}

function plainInputHtml(path,label,value='',type='text',extra=''){
  return `<div class="field expr-field"><label>${esc(label)}</label><input data-f="${esc(path)}" data-value-type="${esc(type)}" type="${type==='number'?'number':'text'}" value="${esc(value)}" ${extra}></div>`;
}
function exprLiteralPreview(e){ if(e.kind==='literal')return e.value; if(e.kind==='var')return e.literalValue??''; return 0; }
function expressionControl(path,value,type='text',depth=0){
  const e=normalizeExpr(value),vars=variableNames(),mode=e.kind==='literal'?'literal':e.kind==='var'?'var':'binary';
  if(depth>8)return `<div class="expr-node"><input data-f="${esc(path)}.value" data-value-type="${esc(type)}" type="${type==='number'?'number':'text'}" value="${esc(exprLiteralPreview(e))}"></div>`;
  const modes=`<option value="literal" ${mode==='literal'?'selected':''}>Valeur</option><option value="var" ${mode==='var'?'selected':''} ${vars.length?'':'disabled'}>Variable</option><option value="binary" ${mode==='binary'?'selected':''}>Calcul</option>`;
  let content='';
  if(mode==='literal')content=`<input class="expr-value" data-f="${esc(path)}.value" data-value-type="${esc(type)}" type="${type==='number'?'number':'text'}" value="${esc(e.value)}" autocomplete="off">`;
  else if(mode==='var')content=`<select class="expr-var-picker" data-expr-var="${esc(path)}"><option value="">Choisir une variable…</option>${vars.map(v=>`<option value="${esc(v)}" ${e.name===v?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
  else content=`<div class="expr-calc"><span class="calc-paren">(</span>${expressionControl(`${path}.left`,e.left,type,depth+1)}<select class="expr-op" data-expr-op="${esc(path)}">${EXPR_OPERATORS.map(o=>`<option value="${o.value}" ${e.op===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>${expressionControl(`${path}.right`,e.right,type,depth+1)}<span class="calc-paren">)</span></div>`;
  return `<div class="expr-node expr-${mode}"><select class="expr-mode" data-expr-mode="${esc(path)}">${modes}</select>${content}</div>`;
}
function inputHtml(path,label,value,type='text',extra=''){ return `<div class="field expr-field"><label>${esc(label)}</label>${expressionControl(path,value,type)}</div>`; }
function textareaHtml(path,label,value){
  const e=normalizeExpr(value),vars=variableNames();
  if(e.kind!=='literal')return inputHtml(path,label,e,'text');
  return `<div class="field expr-field wide"><label>${esc(label)}</label><textarea data-f="${esc(path)}.value" data-value-type="text">${esc(e.value)}</textarea><div class="textarea-help">Pour une variable ou un calcul, utilise le menu « Valeur » juste après la zone.</div><select class="expr-mode textarea-mode" data-expr-mode="${esc(path)}"><option value="literal" selected>Valeur</option><option value="var" ${vars.length?'':'disabled'}>Variable</option><option value="binary">Calcul</option></select></div>`;
}
function selectHtml(path,label,value,options){ return `<div class="field"><label>${esc(label)}</label><select data-f="${esc(path)}">${options.map(o=>`<option value="${esc(o.value)}" ${String(value)===String(o.value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>`; }

function durationHtml(value,unit,path='duration',unitPath='unit'){ return `${inputHtml(path,'Durée',value,'number','min="0"')} ${selectHtml(unitPath,'Unité',unit,[{value:'ms',label:'millisecondes'},{value:'s',label:'secondes'}])}`; }
function captureButton(b){ const armed=capturingPositionBlock===b.id; return `<div class="capture-tools"><button class="capture-btn ${armed?'armed':''}" data-action="capture-arm" data-id="${b.id}">${armed?'🎯 En attente de Ctrl…':'🎯 Capturer avec Ctrl'}</button><button class="ghost-btn" data-action="cursor-now" data-id="${b.id}">Position actuelle</button></div>`; }
const SYSTEM_PROGRAMS=[
  {value:'explorer',label:'Explorateur de fichiers',command:'explorer.exe'},
  {value:'notepad',label:'Bloc-notes',command:'notepad.exe'},
  {value:'calculator',label:'Calculatrice',command:'calc.exe'},
  {value:'paint',label:'Paint',command:'mspaint.exe'},
  {value:'taskmgr',label:'Gestionnaire des tâches',command:'taskmgr.exe'},
  {value:'cmd',label:'Invite de commandes',command:'cmd.exe'},
  {value:'powershell',label:'PowerShell',command:'powershell.exe'},
  {value:'settings',label:'Paramètres Windows',command:'ms-settings:'},
  {value:'control',label:'Panneau de configuration',command:'control.exe'},
  {value:'snippingtool',label:'Outil Capture d’écran',command:'snippingtool.exe'}
];
function launchHtml(b){
  const mode=b.launchMode||'name';
  let body='';
  if(mode==='file') body=plainInputHtml('filePath','Fichier',exprLiteralPreview(normalizeExpr(b.filePath||'')),'text','autocomplete=\"off\"')+`<button class=\"small-action browse-program\" data-action=\"browse-program\" data-id=\"${b.id}\">📁 Parcourir les fichiers</button>`;
  else if(mode==='system') body=selectHtml('system','Programme système',b.system,SYSTEM_PROGRAMS.map(x=>({value:x.value,label:x.label})));
  else body=inputHtml('exe','Nom du programme',b.exe,'text');
  return `${selectHtml('launchMode','Mode',mode,[{value:'name',label:'Nom / commande'},{value:'file',label:'Fichier à parcourir'},{value:'system',label:'Programme système'}])}${body}`;
}

function windowTargetHtml(b){
  const mode=b.targetMode||'title';
  return `${selectHtml('targetMode','Cible',mode,[{value:'title',label:'Titre de fenêtre'},{value:'process',label:'Nom du programme'}])}${mode==='process'?inputHtml('processName','Programme / processus',b.processName,'text'):inputHtml('title','Titre contient',b.title)}`;
}
function activeTitleHtml(b){
  const mode=b.targetMode||'title';
  return `${selectHtml('targetMode','Cible',mode,[{value:'title',label:'Fenêtre active'},{value:'process',label:'Programme'}])}${mode==='process'?inputHtml('processName','Programme / processus',b.processName,'text'):''}${plainInputHtml('saveAs','Enregistrer dans',b.saveAs,'text','autocomplete=\"off\"')}`;
}

function bodyHTML(b){
  switch(b.type){
    case 'mouse-click': return selectHtml('button','Bouton',b.button,[{value:'left',label:'Gauche'},{value:'right',label:'Droit'},{value:'middle',label:'Molette'}])+inputHtml('x','X',b.x,'number')+inputHtml('y','Y',b.y,'number')+captureButton(b);
    case 'mouse-double': case 'mouse-move': return inputHtml('x','X',b.x,'number')+inputHtml('y','Y',b.y,'number')+captureButton(b);
    case 'mouse-scroll': return inputHtml('x','X',b.x,'number')+inputHtml('y','Y',b.y,'number')+inputHtml('amount','Unités',b.amount,'number')+captureButton(b);
    case 'keyboard-type': return textareaHtml('text','Texte',b.text);
    case 'keyboard-key': return selectHtml('key','Touche',b.key,KEY_OPTIONS.map(k=>({value:k,label:k==='ESC'?'Échap':k})).map(x=>x));
    case 'keyboard-hotkey': return hotkeyHtml(b);
    case 'launch': return launchHtml(b);
    case 'set-variable': return plainInputHtml('name','Nom',b.name,'text','autocomplete="off"')+inputHtml('value','Valeur',b.value);
    case 'change-variable': return variableNameSelect('name','Variable',b.name)+inputHtml('amount','De',b.amount,'number');
    case 'window-activate': case 'window-close': return windowTargetHtml(b);
    case 'wait-window': return windowTargetHtml(b)+durationHtml(b.timeout,b.timeoutUnit,'timeout','timeoutUnit')+inputHtml('interval','Vérifier toutes les',b.interval,'number','min="10"')+`<span class="unit-note">ms</span>`;
    case 'window-test': return windowTargetHtml(b)+plainInputHtml('saveAs','Stocker True / False dans',b.saveAs,'text','autocomplete="off"');
    case 'active-title': return activeTitleHtml(b);
    case 'wait': return durationHtml(b.duration,b.unit);
    case 'repeat': return inputHtml('count','Nombre de fois',b.count,'number','min="0"')+nestedHTML(b,'children','Faire');
    case 'while': return conditionHTML(b,'condition')+nestedHTML(b,'children','Faire');
    case 'if': return conditionHTML(b,'condition')+nestedHTML(b,'then','Alors')+nestedHTML(b,'else','Sinon');
    case 'log': return textareaHtml('message','Message',b.message);
    case 'stop': return `<span class="badge stop-badge">Le workflow s'arrête ici</span>`;
    default:return '';
  }
}
function variableNameSelect(path,label,value){ const vars=variableNames(); return `<div class="field"><label>${esc(label)}</label><select data-f="${esc(path)}"><option value="">Choisir…</option>${vars.map(v=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(v)}</option>`).join('')}</select></div>`; }
function hotkeyHtml(b){
  const mods=(b.modifiers||['','','']).slice(0,3); while(mods.length<3)mods.push('');
  const options=[{value:'',label:'Aucune'},{value:'CTRL',label:'Ctrl'},{value:'ALT',label:'Alt'},{value:'WIN',label:'Windows'},{value:'SHIFT',label:'Maj'}];
  return `<div class="hotkey-box"><div class="hotkey-label">Touches de contrôle <span>1 à 3</span></div>${mods.map((m,i)=>`<select data-f="modifiers.${i}">${options.map(o=>`<option value="${o.value}" ${m===o.value?'selected':''}>${o.label}</option>`).join('')}</select>`).join('')}<span class="plus">+</span><select data-f="key">${KEY_OPTIONS.map(k=>`<option value="${k}" ${b.key===k?'selected':''}>${k}</option>`).join('')}</select></div>`;
}

function nestedHTML(b,key,label){
  const arr=b[key]||[];
  return `<div class="nested" data-zone="${key}" data-parent="${b.id}"><div class="nested-head"><span>${esc(label)}</span><small>${arr.length} bloc${arr.length>1?'s':''}</small></div>${arr.length?arr.map(renderBlock).join(''):`<div class="empty-slot">Dépose un bloc ici</div>`}<div class="nested-drop-slot" data-zone="${key}" data-parent="${b.id}">＋ Déposer à la fin</div></div>`;
}

function conditionHTML(b,path='condition'){
  const c=b.condition||defaultCondition(); return `<div class="condition-editor" data-condition-root="${b.id}"><div class="condition-title">Condition <span>Tu peux combiner plusieurs conditions avec Et / Ou / Non.</span></div>${conditionNode(c,`${path}`)}</div>`;
}
function conditionNode(c,path){
  c=c||defaultCondition();
  if(c.kind==='logic'){
    const items=c.items||[]; return `<div class="condition-node logic-node"><div class="condition-line"><select data-cond-path="${path}.op"><option value="and" ${c.op==='and'?'selected':''}>Et</option><option value="or" ${c.op==='or'?'selected':''}>Ou</option></select><button class="small-action" data-action="cond-add" data-path="${path}">+ condition</button>${items.length>1?`<button class="small-action danger-action" data-action="cond-remove" data-path="${path}">− condition</button>`:''}</div>${items.map((x,i)=>conditionNode(x,`${path}.items.${i}`)).join('')}</div>`;
  }
  if(c.kind==='not') return `<div class="condition-node not-node"><div class="condition-line"><b>Non</b><button class="small-action" data-action="cond-not" data-path="${path}">Changer</button></div>${conditionNode(c.item||defaultCondition(),`${path}.item`)}</div>`;
  const kind=c.kind||'compare';
  return `<div class="condition-node"><div class="condition-line"><select data-cond-path="${path}.kind"><option value="compare" ${kind==='compare'?'selected':''}>Comparer des valeurs</option><option value="window" ${kind==='window'?'selected':''}>Fenêtre existe</option><option value="process" ${kind==='process'?'selected':''}>Processus en cours</option><option value="keyboard" ${kind==='keyboard'?'selected':''}>Touche / raccourci détecté</option><option value="always" ${kind==='always'?'selected':''}>Toujours vrai</option><option value="logic" ${kind==='logic'?'selected':''}>Groupe Et / Ou</option><option value="not" ${kind==='not'?'selected':''}>Non</option></select></div>${kind==='compare'?compareConditionFields(c,path):''}${kind==='window'?inputHtml(`${path}.title`,'Titre contient',c.title):''}${kind==='process'?inputHtml(`${path}.processName`,'Processus',c.processName):''}${kind==='keyboard'?keyboardConditionFields(c,path):''}${kind==='logic'?conditionNode({kind:'logic',op:'and',items:[defaultCondition(),defaultCondition()]},path):''}${kind==='not'?conditionNode({kind:'not',item:defaultCondition()},path):''}</div>`;
}
function keyboardConditionFields(c,path){
  const mods=(Array.isArray(c.modifiers)?c.modifiers:[]).slice(0,3); while(mods.length<3)mods.push('');
  const opts=[{value:'',label:'Aucune'},{value:'CTRL',label:'Ctrl'},{value:'ALT',label:'Alt'},{value:'WIN',label:'Windows'},{value:'SHIFT',label:'Maj'}];
  return `<div class="compare-row keyboard-condition"><div class="field"><label>Réaction</label><select data-cond-path="${path}.mode"><option value="wait" ${c.mode!=='test'?'selected':''}>Attendre l'appui</option><option value="test" ${c.mode==='test'?'selected':''}>Tester maintenant</option></select></div><div class="field"><label>Raccourci</label><div class="hotkey-box">${mods.map((m,i)=>`<select data-cond-path="${path}.modifiers.${i}">${opts.map(o=>`<option value="${o.value}" ${m===o.value?'selected':''}>${o.label}</option>`).join('')}</select>`).join('')}<span class="plus">+</span><select data-cond-path="${path}.key">${KEY_OPTIONS.map(k=>`<option value="${k}" ${c.key===k?'selected':''}>${k}</option>`).join('')}</select></div></div><div class="unit-note">« Attendre l'appui » attend le déclenchement puis le relâchement ; pratique pour déclencher l'action du bloc Si.</div></div>`;
}

function compareConditionFields(c,path){
  const ops=[{value:'equals',label:'est égal à'},{value:'not-equals',label:'est différent de'},{value:'contains',label:'contient'},{value:'starts-with',label:'commence par'},{value:'ends-with',label:'se termine par'},{value:'gt',label:'>'},{value:'gte',label:'≥'},{value:'lt',label:'<'},{value:'lte',label:'≤'}];
  return `<div class="compare-row">${inputHtml(`${path}.left`,'Valeur A',c.left)}<div class="field"><label>&nbsp;</label><select data-cond-path="${esc(path+'.op')}">${ops.map(o=>`<option value="${esc(o.value)}" ${c.op===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div>${inputHtml(`${path}.right`,'Valeur B',c.right)}</div>`;
}

function renderBlock(b){
  const sel=b.id===selected?' selected':''; const cat=findCat(b.type);
  return `<div class="wf-block cat-edge-${cat}${sel}" data-id="${b.id}"><div class="wf-header"><span class="grip" draggable="true" data-drag-id="${b.id}" title="Glisser ce bloc">⠿</span><div class="wf-title">${esc(blockName(b.type))}</div><span class="badge">${esc(blockHint(b.type))}</span><div class="block-actions"><button class="iconbtn dup" data-action="duplicate" data-id="${b.id}" title="Dupliquer">⧉</button><button class="iconbtn del" data-action="delete" data-id="${b.id}" title="Supprimer">×</button></div></div><div class="wf-body">${bodyHTML(b)}</div></div>`;
}
function render(){
  renderPalette();
  const stack=document.createElement('div'); stack.className='block-stack'; stack.style.zoom=zoom;
  stack.innerHTML=workflow.blocks.length?workflow.blocks.map(renderBlock).join(''):'<div class="hint"><div class="hint-icon">＋</div><b>Glisse des blocs ici</b><span>Les blocs s’exécutent de haut en bas. Les blocs de contrôle contiennent leurs propres blocs.</span></div>';
  canvas.innerHTML=''; canvas.appendChild(stack);
  $('#projectName').value=workflow.name||'Mon workflow';
  const n=countBlocks(workflow.blocks); $('#blockCount').textContent=`${n} bloc${n>1?'s':''}`;
  refreshVariableMenus(); inspector(); wireCanvas(); updateHistoryButtons();
}

function markSelected(){
  document.querySelectorAll('.wf-block.selected').forEach(e=>e.classList.remove('selected'));
  const el=document.querySelector(`.wf-block[data-id="${CSS.escape(selected||'')}"]`); if(el)el.classList.add('selected');
}
function updateCurrent(id){ selected=id; markSelected(); inspector(); }

function wireCanvas(){
  canvas.querySelectorAll('.wf-header').forEach(h=>h.addEventListener('click',e=>{if(e.target.closest('button,.grip'))return;selected=h.closest('.wf-block').dataset.id;markSelected();inspector();}));
  canvas.querySelectorAll('[data-drag-id]').forEach(g=>g.addEventListener('dragstart',e=>{e.stopPropagation();e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('move-id',g.dataset.dragId);}));
  canvas.querySelectorAll('.wf-block').forEach(el=>{
    el.addEventListener('dragover',e=>{
      const targetNested=e.target.closest('.nested');
      if(targetNested && targetNested.closest('.wf-block')===el) return;
      e.preventDefault(); e.stopPropagation();
      el.classList.toggle('drag-before',e.offsetY<el.offsetHeight/2);el.classList.toggle('drag-after',e.offsetY>=el.offsetHeight/2);
    });
    el.addEventListener('dragleave',()=>el.classList.remove('drag-before','drag-after'));
    el.addEventListener('drop',e=>{
      const targetNested=e.target.closest('.nested');
      if(targetNested && targetNested.closest('.wf-block')===el) return;
      e.preventDefault();e.stopPropagation();el.classList.remove('drag-before','drag-after');
      const t=e.dataTransfer.getData('block-type'),m=e.dataTransfer.getData('move-id');const before=e.offsetY<el.offsetHeight/2;
      if(t){const f=find(el.dataset.id);if(f)addBlock(t,f.parent,f.key,f.index+(before?0:1));}
      else if(m)moveBlock(m,el.dataset.id,before);
    });
  });
  canvas.querySelectorAll('.nested').forEach(z=>{
    z.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();const nested=z.closest('.nested');nested?.classList.add('dragover');});
    z.addEventListener('dragleave',e=>{e.stopPropagation();if(!z.contains(e.relatedTarget))z.closest('.nested')?.classList.remove('dragover');});
    z.addEventListener('drop',e=>{
      e.preventDefault();e.stopPropagation();const nested=z.closest('.nested');nested?.classList.remove('dragover');
      const parent=find(z.dataset.parent)?.b;if(!parent)return;const zone=z.dataset.zone;
      const t=e.dataTransfer.getData('block-type'),m=e.dataTransfer.getData('move-id');
      if(t){addBlock(t,parent,zone);return;}
      if(m){
        const from=find(m);
        if(!from||containsId(from.b,parent.id)){setStatus('Impossible : ce bloc ne peut pas être imbriqué ici.');return;}
        applyMutation(()=>{
          const node=from.b;from.arr.splice(from.index,1);(parent[zone]||(parent[zone]=[])).push(node);selected=m;
        });
      }
    });
  });
  canvas.querySelectorAll('[data-f]').forEach(inp=>{
    inp.addEventListener('focus',()=>{editSnapshot=snapshot();});
    inp.addEventListener('input',()=>updateFieldLive(inp));
    inp.addEventListener('change',()=>updateFieldCommit(inp));
    inp.addEventListener('blur',()=>{if(editSnapshot&&editSnapshot!==snapshot()){pushHistory(editSnapshot);setDirty(true);}editSnapshot=null;});
  });
  canvas.querySelectorAll('[data-expr-mode]').forEach(sel=>sel.addEventListener('change',()=>updateExpressionMode(sel)));
  canvas.querySelectorAll('[data-expr-var]').forEach(sel=>sel.addEventListener('change',()=>updateExpressionVariable(sel)));
  canvas.querySelectorAll('[data-expr-op]').forEach(sel=>sel.addEventListener('change',()=>updateExpressionOperator(sel)));
  canvas.querySelectorAll('[data-cond-path]').forEach(sel=>sel.addEventListener('change',()=>updateConditionPath(sel)));
  canvas.querySelectorAll('[data-action]').forEach(btn=>btn.addEventListener('click',handleAction));
}

function resolvePath(obj,path){return path.split('.').reduce((o,k)=>o==null?undefined:o[k],obj);}
function setPath(obj,path,val){const parts=path.split('.');let cur=obj;for(let i=0;i<parts.length-1;i++){const k=parts[i];if(cur[k]==null)cur[k]=/^\d+$/.test(parts[i+1])?[]:{};cur=cur[k];}cur[parts[parts.length-1]]=val;}
function fieldTarget(blockId,path){const f=find(blockId);if(!f)return null;return {block:f.b, path};}

function coerceFieldValue(path,value,type='text'){ return type==='number'?Number(value):value; }
function updateFieldLive(inp){
  const el=inp.closest('.wf-block');if(!el)return;const f=find(el.dataset.id);if(!f)return;
  const rawPath=inp.dataset.f||'',isExpr=rawPath.endsWith('.value'),path=isExpr?rawPath.slice(0,-6):rawPath,type=inp.dataset.valueType||'text';
  if(isExpr)setPath(f.b,path,literal(coerceFieldValue(path,inp.value,type))); else setPath(f.b,path,coerceFieldValue(path,inp.value,type));
  setDirty(true); if(path==='name'&&['set-variable','change-variable'].includes(f.b.type))refreshVariableMenus();
}
function updateFieldCommit(inp){
  const el=inp.closest('.wf-block');if(!el)return;const f=find(el.dataset.id);if(!f)return;const path=inp.dataset.f||'';
  if(path.startsWith('modifiers.')||['unit','button','key','timeoutUnit','launchMode','system','targetMode','name'].includes(path)){
    const value=path==='name'?inp.value.trim():inp.value;
    if(path==='name' && !value)value=f.b.type==='set-variable'||f.b.type==='change-variable'?'maVariable':'';
    setPath(f.b,path,value);
    if(path==='name'&&(f.b.type==='set-variable'||f.b.type==='change-variable'))refreshVariableMenus();
    setDirty(true);render();return;
  }
  if(path==='saveAs'&&(f.b.type==='window-test'||f.b.type==='active-title')){setPath(f.b,path,inp.value.trim()||'resultat');refreshVariableMenus();setDirty(true);}
}

function currentExpressionAt(block,path){return normalizeExpr(resolvePath(block,path));}
function updateExpressionMode(sel){
  const el=sel.closest('.wf-block');if(!el)return;const f=find(el.dataset.id);if(!f)return;const path=sel.dataset.exprMode,before=snapshot(),current=currentExpressionAt(f.b,path);let next;
  if(sel.value==='literal')next=literal(current.kind==='var'?current.literalValue:current.kind==='literal'?current.value:0);
  else if(sel.value==='var')next=variable(variableNames()[0]||'',current.kind==='literal'?current.value:exprLiteralPreview(current));
  else next=binary('+',literal(0),literal(0));
  setPath(f.b,path,next);pushHistory(before);setDirty(true);render();
}
function updateExpressionVariable(sel){
  const el=sel.closest('.wf-block');if(!el)return;const f=find(el.dataset.id);if(!f)return;const path=sel.dataset.exprVar,before=snapshot(),current=normalizeExpr(resolvePath(f.b,path));
  if(sel.value)setPath(f.b,path,variable(sel.value,current.kind==='var'?current.literalValue:exprLiteralPreview(current)));else setPath(f.b,path,literal(current.kind==='var'?current.literalValue:exprLiteralPreview(current)));
  pushHistory(before);setDirty(true);render();
}
function updateExpressionOperator(sel){
  const el=sel.closest('.wf-block');if(!el)return;const f=find(el.dataset.id);if(!f)return;const path=sel.dataset.exprOp,before=snapshot(),current=normalizeExpr(resolvePath(f.b,path));
  if(current.kind==='binary')current.op=sel.value;setPath(f.b,path,current);pushHistory(before);setDirty(true);
}
function updateConditionPath(sel){
  const el=sel.closest('.wf-block'); if(!el)return; const f=find(el.dataset.id);if(!f)return; const before=snapshot();
  const path=sel.dataset.condPath;
  let current=resolvePath(f.b,path);
  if(path.endsWith('.kind')){
    const kind=sel.value;
    const replacement=kind==='compare'?defaultCondition():kind==='window'?{kind:'window',title:literal('Bloc-notes'),mode:'exists'}:kind==='process'?{kind:'process',processName:literal('notepad')}:kind==='keyboard'?{kind:'keyboard',mode:'wait',modifiers:['CTRL','',''],key:'K'}:kind==='always'?{kind:'always'}:kind==='logic'?{kind:'logic',op:'and',items:[defaultCondition(),defaultCondition()]}:{kind:'not',item:defaultCondition()};
    setPath(f.b,path.replace(/\.kind$/,''),replacement);
  } else setPath(f.b,path,sel.value);
  pushHistory(before);setDirty(true);render();
}
function handleAction(e){
  const btn=e.currentTarget, action=btn.dataset.action, idd=btn.dataset.id;
  if(action==='delete')return remove(idd);
  if(action==='duplicate')return duplicate(idd);
  if(action==='capture-arm'){
    if(capturingPositionBlock===idd){capturingPositionBlock=null;window.blockflow.stopMouseCapture();render();setStatus('Capture annulée.');}
    else {capturingPositionBlock=idd;window.blockflow.startMouseCapture();render();setStatus('Place la souris où tu veux, puis appuie sur Ctrl.');}
  } else if(action==='cursor-now'){
    window.blockflow.getCursorPosition().then(p=>storeMousePosition(idd,p.x,p.y));
  } else if(action==='browse-program'){
    window.blockflow.browseProgram().then(p=>{
      if(!p)return; const f=find(idd); if(!f)return; const before=snapshot(); f.b.launchMode='file'; f.b.filePath=literal(p); pushHistory(before); setDirty(true); render(); setStatus('Programme sélectionné : '+p);
    });
  } else if(action==='cond-add'){
    const f=find(idd);if(!f)return;const before=snapshot();const group=resolvePath(f.b,btn.dataset.path);if(group&&group.kind==='logic'){(group.items||(group.items=[])).push(defaultCondition());pushHistory(before);setDirty(true);render();}
  } else if(action==='cond-remove'){
    const f=find(idd);if(!f)return;const before=snapshot();const group=resolvePath(f.b,btn.dataset.path);if(group&&group.kind==='logic'&&group.items.length>2){group.items.pop();pushHistory(before);setDirty(true);render();}
  } else if(action==='cond-not'){
    const f=find(idd);if(!f)return;const before=snapshot();const current=resolvePath(f.b,btn.dataset.path);setPath(f.b,btn.dataset.path,current?.kind==='not'?(current.item||defaultCondition()):{kind:'not',item:current||defaultCondition()});pushHistory(before);setDirty(true);render();
  }
}
function storeMousePosition(blockId,x,y){ const f=find(blockId);if(!f)return;const before=snapshot();f.b.x=literal(x);f.b.y=literal(y);f.b.captureMode='coords';capturingPositionBlock=null;window.blockflow.stopMouseCapture();pushHistory(before);setDirty(true);render();setStatus(`Position capturée : ${x}, ${y}`); }

function inspector(){
  const root=$('#inspectorContent'); const f=find(selected);
  if(!f){root.className='empty-inspector';root.textContent='Sélectionne un bloc pour voir sa description.';return;}
  root.className=''; root.innerHTML=`<div class="inspector-card"><h3>${esc(blockName(f.b.type))}</h3><div class="inspector-row"><label>Type</label><code>${esc(f.b.type)}</code></div><p>${esc(blockDescription(f.b.type))}</p><div class="inspector-actions"><button data-inspect="duplicate">Dupliquer</button><button data-inspect="delete">Supprimer</button></div></div>`;
  root.querySelector('[data-inspect="duplicate"]').onclick=()=>duplicate(f.b.id);root.querySelector('[data-inspect="delete"]').onclick=()=>remove(f.b.id);
}
function blockDescription(type){
  const d={
    'mouse-click':'Clique à la position indiquée. La position peut être saisie ou capturée en appuyant sur Ctrl.',
    'mouse-double':'Effectue un double-clic gauche à la position donnée.',
    'mouse-move':'Déplace le curseur sans cliquer.',
    'mouse-scroll':'Déplace la molette à la position donnée.',
    'keyboard-type':'Tape du texte. La valeur peut provenir d’une variable.',
    'keyboard-key':'Envoie une touche unique.',
    'keyboard-hotkey':'Compose un raccourci avec jusqu’à trois modificateurs et une touche finale.',
    'set-variable':'Crée/modifie une variable. Les autres champs peuvent réutiliser sa valeur.',
    'change-variable':'Ajoute une valeur numérique à une variable existante.',
    'if':'Exécute Alors ou Sinon selon une condition combinable, y compris un déclencheur touche/raccourci.',
    'repeat':'Répète tous les blocs déposés dans la zone Faire.',
    'while':'Répète les blocs tant que la condition reste vraie.',
    'wait':'Met le workflow en pause pendant la durée choisie.',
    'launch':'Lance un programme par nom/commande, fichier sélectionné ou programme système.',
    'wait-window':'Attend une fenêtre par son titre ou le démarrage d’un programme.',
    'window-activate':'Active une fenêtre par titre ou la fenêtre principale d’un programme.',
    'window-close':'Ferme une fenêtre par titre ou un programme.',
    'window-test':'Teste une fenêtre ou un programme et écrit True/False dans une variable.',
    'active-title':'Lit le titre de la fenêtre active, ou celui de la fenêtre principale d’un programme.',
  }; return d[type]||'Bloc d’automatisation Windows.';
}
function findCat(type){for(const[c,its]of Object.entries(palette))if(its.some(i=>i[0]===type))return c;return'data';}
function blockName(type){for(const its of Object.values(palette))for(const x of its)if(x[0]===type)return x[1];return type;}
function blockHint(type){const hints={'launch':'Action','set-variable':'Variable','change-variable':'Variable','mouse-click':'Souris','mouse-double':'Souris','mouse-move':'Souris','mouse-scroll':'Souris','keyboard-type':'Clavier','keyboard-key':'Clavier','keyboard-hotkey':'Clavier','window-activate':'Fenêtre / programme','window-close':'Fenêtre / programme','wait-window':'Fenêtre / programme','window-test':'Test','active-title':'Fenêtre / programme','if':'Contrôle','repeat':'Boucle','while':'Boucle','wait':'Contrôle','stop':'Contrôle','log':'Donnée'};return hints[type]||'Bloc';}

async function exportRunnable(){
  const data=workflowForSave(); workflow.name=data.name; workflow.version=7;
  try{
    const p=await window.blockflow.exportRunnable(data);
    if(p){setStatus('Tâche autonome exportée : '+p);
      if(confirm('La tâche autonome a été créée. Créer aussi un raccourci sur le Bureau ?')){
        try{const shortcut=await window.blockflow.createDesktopShortcut(p);setStatus('Tâche exportée + raccourci Bureau créé : '+shortcut);}catch(e){setStatus('Tâche exportée, raccourci impossible : '+e.message);}
      }
    }
  }catch(e){setStatus('Erreur export : '+e.message);log('ERREUR: '+e.message);}
}

async function saveWorkflow(){
  const data=workflowForSave(); workflow.name=data.name; workflow.version=7;
  const p=await window.blockflow.saveWorkflow(data); if(p){setDirty(false);setStatus('Enregistré : '+p);} }
async function openWorkflow(){ const d=await window.blockflow.openWorkflow(); if(d){normalizeWorkflow(d);selected=null;history=[];future=[];render();setStatus('Workflow ouvert');} }
function newWorkflow(){ if(dirty&&!confirm('Les modifications non enregistrées seront perdues. Continuer ?'))return; workflow={version:7,name:'Mon workflow',blocks:[]};selected=null;history=[];future=[];setDirty(false);render();setStatus('Nouveau workflow'); }
function undo(){if(!history.length)return;future.push(snapshot());const prev=history.pop();workflow=JSON.parse(prev);selected=null;setDirty(true);render();}
function redo(){if(!future.length)return;history.push(snapshot());const next=future.pop();workflow=JSON.parse(next);selected=null;setDirty(true);render();}
function updateHistoryButtons(){$('#undoBtn').disabled=!history.length;$('#redoBtn').disabled=!future.length;}
function setStatus(s){$('#status').textContent=s;}
function log(s){$('#log').textContent+=s+'\n';$('#log').scrollTop=$('#log').scrollHeight;}

$('#search').addEventListener('input',renderPalette);
$('#newBtn').addEventListener('click',newWorkflow); $('#openBtn').addEventListener('click',openWorkflow); $('#saveBtn').addEventListener('click',saveWorkflow); $('#exportBtn').addEventListener('click',exportRunnable);
$('#undoBtn').addEventListener('click',undo);$('#redoBtn').addEventListener('click',redo);$('#clearLog').addEventListener('click',()=>$('#log').textContent='');
$('#projectName').addEventListener('input',()=>{workflow.name=$('#projectName').value;setDirty(true);});
$('#projectName').addEventListener('blur',()=>{workflow.name=$('#projectName').value.trim()||'Mon workflow';$('#projectName').value=workflow.name;});
$('#zoomIn').addEventListener('click',()=>{zoom=Math.min(1.5,zoom+.1);$('#zoomValue').textContent=Math.round(zoom*100)+'%';render();});
$('#zoomOut').addEventListener('click',()=>{zoom=Math.max(.6,zoom-.1);$('#zoomValue').textContent=Math.round(zoom*100)+'%';render();});

$('#runBtn').addEventListener('click',async()=>{if(running)return;running=true;setStatus('Exécution en cours…');$('#log').textContent='';try{await window.blockflow.runWorkflow(workflow.blocks);setStatus('Exécution terminée');}catch(e){setStatus('Erreur : '+e.message);log('ERREUR: '+e.message);}finally{running=false;capturingPositionBlock=null;render();}});
$('#stopBtn').addEventListener('click',async()=>{if(running){await window.blockflow.stopWorkflow();setStatus('Arrêt demandé…');}});

document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='s'){e.preventDefault();exportRunnable();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveWorkflow();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();openWorkflow();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();}
  else if(e.key==='F6'){e.preventDefault();$('#runBtn').click();}
});

window.blockflow.onRunnerEvent(ev=>{
  if(ev.type==='current'){updateCurrent(ev.id);log('→ '+blockName(find(ev.id)?.b.type||ev.id));}
  else if(ev.type==='log')log(ev.message);
  else if(ev.type==='condition')log('condition = '+ev.value);
  else if(ev.type==='cursor-captured' && capturingPositionBlock){storeMousePosition(capturingPositionBlock,ev.x,ev.y);}
  else if(ev.type==='error'){log('ERREUR: '+ev.message);setStatus('Erreur');}
});

render();
