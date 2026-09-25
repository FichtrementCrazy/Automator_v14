const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
let activeChild = null;
let captureChild = null;
let activeRunStopped = false;
let captureSender = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function psQuote(s) { return "'" + String(s).replace(/'/g,"''") + "'"; }
function expressionValue(v,state){
  if(v==null)return '';
  if(typeof v!=='object')return v;
  if(v.kind==='var') return state.vars[v.name]??'';
  if(v.kind==='literal') return v.value;
  if(v.kind==='binary'){
    const left=expressionValue(v.left,state);
    const right=expressionValue(v.right,state);
    const op=v.op||'+';
    const ln=Number(left), rn=Number(right);
    const numeric=Number.isFinite(ln)&&Number.isFinite(rn)&&left!==''&&right!=='';
    if(op==='+' && !numeric) return String(left??'')+String(right??'');
    if(!numeric) throw new Error('Les opérandes de ce calcul doivent être numériques.');
    switch(op){
      case '+': return ln+rn;
      case '-': return ln-rn;
      case '*': return ln*rn;
      case '/': if(rn===0) throw new Error('Division par zéro.'); return ln/rn;
      case '%': if(rn===0) throw new Error('Modulo par zéro.'); return ln%rn;
      case '^': return Math.pow(ln,rn);
      default: return ln+rn;
    }
  }
  return v;
}
function str(v,state,fallback=''){ const x=expressionValue(v,state); return x==null?fallback:String(x); }
function num(v,state,fallback=0){ const n=Number(expressionValue(v,state)); return Number.isFinite(n)?n:fallback; }
function durationMs(v,unit,state,fallback=0){ return Math.max(0,unit==='s'?num(v,state,fallback/1000)*1000:num(v,state,fallback)); }

const helper = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BFWin {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X,int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd,StringBuilder text,int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint processId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc,IntPtr lParam);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint MOUSEEVENTF_LEFTDOWN=0x0002,MOUSEEVENTF_LEFTUP=0x0004,MOUSEEVENTF_RIGHTDOWN=0x0008,MOUSEEVENTF_RIGHTUP=0x0010,MOUSEEVENTF_MIDDLEDOWN=0x0020,MOUSEEVENTF_MIDDLEUP=0x0040,MOUSEEVENTF_WHEEL=0x0800,KEYEVENTF_KEYUP=0x0002;
  public const long DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2=-4;
  public static void EnableDpi(){try{if(!SetProcessDpiAwarenessContext(new IntPtr(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)))SetProcessDPIAware();}catch{try{SetProcessDPIAware();}catch{}}}
  public static string Title(IntPtr h){var sb=new StringBuilder(1024);GetWindowText(h,sb,sb.Capacity);return sb.ToString();}
  private static bool Move(int x,int y){if(!SetCursorPos(x,y))return false;System.Threading.Thread.Sleep(40);POINT p;return GetCursorPos(out p)&&p.X==x&&p.Y==y;}
  public static bool Click(int x,int y,uint down,uint up){if(!Move(x,y))return false;mouse_event(down,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(35);mouse_event(up,0,0,0,UIntPtr.Zero);return true;}
  public static bool DoubleClick(int x,int y){if(!Move(x,y))return false;mouse_event(MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(75);mouse_event(MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);return true;}
  public static bool Scroll(int x,int y,int delta){if(!Move(x,y))return false;mouse_event(MOUSEEVENTF_WHEEL,0,0,unchecked((uint)delta),UIntPtr.Zero);return true;}
  public static POINT Cursor(){POINT p;GetCursorPos(out p);return p;}
  public static bool IsKeyDown(int vk){return (GetAsyncKeyState(vk) & 0x8000)!=0;}
}
'@
[BFWin]::EnableDpi()
`;


function vkForKey(key){
  const k=String(key||'').toUpperCase();
  const named={ENTER:0x0D,TAB:0x09,ESC:0x1B,SPACE:0x20,BACKSPACE:0x08,DELETE:0x2E,INSERT:0x2D,HOME:0x24,END:0x23,PGUP:0x21,PGDN:0x22,UP:0x26,DOWN:0x28,LEFT:0x25,RIGHT:0x27,
    F1:0x70,F2:0x71,F3:0x72,F4:0x73,F5:0x74,F6:0x75,F7:0x76,F8:0x77,F9:0x78,F10:0x79,F11:0x7A,F12:0x7B,
    CTRL:0x11,ALT:0x12,SHIFT:0x10,WIN:0x5B};
  if(named[k]!=null)return named[k];
  if(/^[A-Z]$/.test(k))return k.charCodeAt(0);
  if(/^[0-9]$/.test(k))return k.charCodeAt(0);
  return null;
}

function sendKeyScript(key){
  const vk=vkForKey(key); if(vk==null) throw new Error('Touche non prise en charge : '+key);
  return `${helper}[BFWin]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 15; [BFWin]::keybd_event(${vk},0,[BFWin]::KEYEVENTF_KEYUP,[UIntPtr]::Zero);`;
}
function sendHotkeyScript(modifiers,key){
  const mods=[...(modifiers||[])].filter(Boolean); const vks=mods.map(vkForKey); const keyVk=vkForKey(key);
  if(keyVk==null) throw new Error('Touche finale non prise en charge : '+key);
  if(vks.some(v=>v==null)) throw new Error('Modificateur non pris en charge.');
  let s=helper; vks.forEach(v=>{s+=`[BFWin]::keybd_event(${v},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 15;`;});
  s+=`[BFWin]::keybd_event(${keyVk},0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [BFWin]::keybd_event(${keyVk},0,[BFWin]::KEYEVENTF_KEYUP,[UIntPtr]::Zero);`;
  vks.reverse().forEach(v=>{s+=`Start-Sleep -Milliseconds 15; [BFWin]::keybd_event(${v},0,[BFWin]::KEYEVENTF_KEYUP,[UIntPtr]::Zero);`;});
  return s;
}

const SYSTEM_PROGRAMS={explorer:'explorer.exe',notepad:'notepad.exe',calculator:'calc.exe',paint:'mspaint.exe',taskmgr:'taskmgr.exe',cmd:'cmd.exe',powershell:'powershell.exe',settings:'ms-settings:',control:'control.exe',snippingtool:'snippingtool.exe'};
function launchTarget(block,state){
  const mode=block.launchMode||'name';
  if(mode==='file') return str(block.filePath,state);
  if(mode==='system') return SYSTEM_PROGRAMS[block.system]||SYSTEM_PROGRAMS.explorer;
  return str(block.exe,state);
}
function processNameValue(block,state){ return str(block.processName,state).replace(/\\$/,'').replace(/\.exe$/i,''); }

function psScriptFor(block,state){
  const x=Math.round(num(block.x,state,0)), y=Math.round(num(block.y,state,0));
  const button=['left','right','middle'].includes(block.button)?block.button:'left';
  const title=str(block.title,state), processName=processNameValue(block,state), exe=launchTarget(block,state);
  const mode=block.targetMode||'title';
  const titleMatch=psQuote('*'+title+'*');
  const processMatch=psQuote(processName);
  switch(block.type){
    case 'mouse-click': {
      const downs={left:'MOUSEEVENTF_LEFTDOWN',right:'MOUSEEVENTF_RIGHTDOWN',middle:'MOUSEEVENTF_MIDDLEDOWN'};
      const ups={left:'MOUSEEVENTF_LEFTUP',right:'MOUSEEVENTF_RIGHTUP',middle:'MOUSEEVENTF_MIDDLEUP'};
      return helper+`if(-not [BFWin]::Click(${x},${y},[BFWin]::${downs[button]},[BFWin]::${ups[button]})){throw "Echec de l envoi du clic souris par Windows."};`;
    }
    case 'mouse-double': return helper+`if(-not [BFWin]::DoubleClick(${x},${y})){throw "Echec de l envoi du double-clic souris par Windows."};`;
    case 'mouse-move': return helper+`if(-not [BFWin]::SetCursorPos(${x},${y})){throw 'Impossible de déplacer la souris.'};`;
    case 'mouse-scroll': return helper+`if(-not [BFWin]::Scroll(${x},${y},${Math.round(num(block.amount,state,1))*120})){throw "Echec de l envoi de la molette souris par Windows."};`;
    case 'keyboard-type': return `$w=New-Object -ComObject WScript.Shell; $w.SendKeys(${psQuote(str(block.text,state))});`;
    case 'keyboard-key': return sendKeyScript(block.key);
    case 'keyboard-hotkey': return sendHotkeyScript(block.modifiers,block.key);
    case 'launch': return `Start-Process -FilePath ${psQuote(exe)};`;
    case 'window-activate':
      if(mode==='process') return helper+`$n=${processMatch};$p=Get-Process -Name $n -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1;if($null -eq $p){throw "Programme introuvable : $n"};[BFWin]::ShowWindow($p.MainWindowHandle,9)|Out-Null;[BFWin]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;`;
      return helper+`$script:bfTarget=[IntPtr]::Zero;[BFWin]::EnumWindows({param($hw,$lp);$t=[BFWin]::Title($hw);if($t -like ${titleMatch}){$script:bfTarget=$hw;return $false};return $true},[IntPtr]::Zero)|Out-Null;if($script:bfTarget -eq [IntPtr]::Zero){throw "Fenêtre introuvable : ${title}"};[BFWin]::ShowWindow($script:bfTarget,9)|Out-Null;[BFWin]::SetForegroundWindow($script:bfTarget)|Out-Null;`;
    case 'window-close':
      if(mode==='process') return helper+`Get-Process -Name ${processMatch} -ErrorAction SilentlyContinue|ForEach-Object{if($_.MainWindowHandle -ne 0){$_.CloseMainWindow()|Out-Null}else{$_.Stop()}};`;
      return helper+`$script:bfTarget=[IntPtr]::Zero;[BFWin]::EnumWindows({param($hw,$lp);if([BFWin]::Title($hw) -like ${titleMatch}){$script:bfTarget=$hw;return $false};return $true},[IntPtr]::Zero)|Out-Null;if($script:bfTarget -ne [IntPtr]::Zero){$pid=0;[BFWin]::GetWindowThreadProcessId($script:bfTarget,[ref]$pid)|Out-Null;$p=Get-Process -Id $pid -ErrorAction SilentlyContinue;if($p){$p.CloseMainWindow()|Out-Null}};`;
    case 'wait-window': return psScriptFor({type:'window-test',targetMode:mode,title:block.title,processName:block.processName},state);
    case 'window-test':
      if(mode==='process') return `Write-Output ($(if(Get-Process -Name ${processMatch} -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}){'TRUE'}else{'FALSE'}));`;
      return helper+`$script:bfFound=$false;[BFWin]::EnumWindows({param($hw,$lp);$t=[BFWin]::Title($hw);if($t -like ${titleMatch}){$script:bfFound=$true;return $false};return $true},[IntPtr]::Zero)|Out-Null;Write-Output ($(if($script:bfFound){'TRUE'}else{'FALSE'}));`;
    case 'active-title':
      if(mode==='process') return helper+`$n=${processMatch};$p=Get-Process -Name $n -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1;if($null -eq $p){throw "Programme introuvable : $n"};Write-Output ([BFWin]::Title($p.MainWindowHandle));`;
      return helper+`$h=[BFWin]::GetForegroundWindow();Write-Output ([BFWin]::Title($h));`;
    case 'keyboard-condition': {
      const mods=(Array.isArray(block.modifiers)?block.modifiers:[]).filter(Boolean).slice(0,3);
      const modVks=mods.map(vkForKey);
      const finalVk=vkForKey(block.key);
      if(finalVk==null||modVks.some(v=>v==null)) throw new Error('Touche ou modificateur clavier non pris en charge.');
      const checks=[...modVks,finalVk].map(v=>`[BFWin]::IsKeyDown(${v})`).join(' -and ');
      if(block.mode==='test') return helper+`Write-Output ($(if(${checks}){'TRUE'}else{'FALSE'}));`;
      return helper+`while(${checks}){Start-Sleep -Milliseconds 20};while(-not (${checks})){Start-Sleep -Milliseconds 20};Write-Output 'TRUE';while(${checks}){Start-Sleep -Milliseconds 20};`;
    }
    case 'window-exists':
      return psScriptFor({type:'window-test',targetMode:'title',title:block.title},state);
    case 'process-running':
      return `Write-Output ($(if(Get-Process -Name ${processMatch} -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}){'TRUE'}else{'FALSE'}));`;
    default:return '';
  }
}

function runPS(script){
  if(!isWin)return Promise.reject(new Error('Le moteur d\'automatisation Windows ne peut s\'exécuter que sous Windows.'));
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true});
    let out='',err=''; activeChild=child;
    child.stdout.on('data',d=>out+=d.toString()); child.stderr.on('data',d=>err+=d.toString());
    child.on('error',e=>{if(activeChild===child)activeChild=null;reject(e);});
    child.on('close',code=>{if(activeChild===child)activeChild=null;code===0?resolve(out.trim()):reject(new Error(err||`PowerShell code ${code}`));});
  });
}
function sleep(ms,state){
  return new Promise(resolve=>{const end=Date.now()+Math.max(0,ms|0);const tick=()=>{if(state.stopped||activeRunStopped||Date.now()>=end)return resolve();setTimeout(tick,Math.min(50,end-Date.now()));};tick();});
}

function compare(a,b,op){
  const an=Number(a),bn=Number(b),numeric=Number.isFinite(an)&&Number.isFinite(bn)&&a!==''&&b!=='';
  const A=numeric?an:String(a),B=numeric?bn:String(b);
  switch(op){case'equals':return A===B;case'not-equals':return A!==B;case'contains':return String(A).includes(String(B));case'starts-with':return String(A).startsWith(String(B));case'ends-with':return String(A).endsWith(String(B));case'gt':return A>B;case'gte':return A>=B;case'lt':return A<B;case'lte':return A<=B;default:return false;}
}
async function evaluateCondition(c,state){
  if(!c)return false;
  switch(c.kind){
    case'always':return true;
    case'window':return (await runPS(psScriptFor({type:'window-test',targetMode:'title',title:c.title},state))).trim()==='TRUE';
    case'process':return (await runPS(psScriptFor({type:'window-test',targetMode:'process',processName:c.processName},state))).trim()==='TRUE';
    case'keyboard':return (await runPS(psScriptFor({type:'keyboard-condition',modifiers:c.modifiers,key:c.key,mode:c.mode||'wait'},state))).trim()==='TRUE';
    case'compare':return compare(expressionValue(c.left,state),expressionValue(c.right,state),c.op||'equals');
    case'logic':{const items=c.items||[];if(c.op==='or'){for(const item of items)if(await evaluateCondition(item,state))return true;return false;}for(const item of items)if(!(await evaluateCondition(item,state)))return false;return true;}
    case'not':return !(await evaluateCondition(c.item,state));
    default:return false;
  }
}

async function executeBlocks(blocks,emit,state={vars:{},stopped:false}){
  activeRunStopped=false;
  const runList=async list=>{
    for(const b of list||[]){
      if(state.stopped||activeRunStopped)return false;
      emit({type:'current',id:b.id});
      try{
        switch(b.type){
          case'mouse-click':case'mouse-double':case'mouse-move':case'mouse-scroll':case'keyboard-type':case'keyboard-key':case'keyboard-hotkey':case'launch':case'window-activate':case'window-close':{
            await runPS(psScriptFor(b,state)); break;
          }
          case'wait-window':{
            const timeout=durationMs(b.timeout,b.timeoutUnit,state,15000), interval=Math.max(25,num(b.interval,state,250)),started=Date.now();let ok=false;
            while(!state.stopped&&!activeRunStopped&&Date.now()-started<timeout){ok=(await runPS(psScriptFor({type:'window-test',targetMode:b.targetMode,title:b.title,processName:b.processName},state))).trim()==='TRUE';if(ok)break;await sleep(interval,state);}
            if(!ok)throw new Error(b.targetMode==='process'?'Délai dépassé : programme introuvable.':'Délai dépassé : fenêtre introuvable.'); break;
          }
          case'wait': await sleep(durationMs(b.duration,b.unit,state,500),state); break;
          case'set-variable': state.vars[String(b.name||'variable')]=expressionValue(b.value,state);break;
          case'change-variable': {const name=String(b.name||'');const old=Number(state.vars[name]||0),delta=num(b.amount,state,0);state.vars[name]=Number.isFinite(old)?old+delta:delta;break;}
          case'log': emit({type:'log',message:str(b.message,state)});break;
          case'active-title': state.vars[String(b.saveAs||'activeTitle')]=await runPS(psScriptFor(b,state));break;
          case'window-test': {const result=(await runPS(psScriptFor(b,state))).trim()==='TRUE';state.vars[String(b.saveAs||'resultat')]=result;state.vars.__lastCondition=result;emit({type:'condition',value:result,variable:String(b.saveAs||'resultat')});break;}
          case'if': {const cond=await evaluateCondition(b.condition,state);const ok=await runList(cond?(b.then||[]):(b.else||[]));if(!ok)return false;break;}
          case'repeat': {const n=Math.max(0,Math.min(10000,Math.floor(num(b.count,state,0))));for(let i=0;i<n;i++){if(!(await runList(b.children||[])))return false;}break;}
          case'while': {let guard=0;while(!state.stopped&&!activeRunStopped&&guard++<10000&&await evaluateCondition(b.condition,state)){if(!(await runList(b.children||[])))return false;}if(guard>=10000)emit({type:'log',message:'Boucle Tant que interrompue après 10 000 itérations.'});break;}
          case'stop': state.stopped=true;emit({type:'log',message:'Workflow arrêté par le bloc Arrêter.'});return false;
        }
      }catch(e){emit({type:'error',message:e.message,id:b.id});return false;}
    }
    return true;
  };
  await runList(blocks);return state.vars;
}

function stopCapture(){ if(captureChild){try{captureChild.kill();}catch{}captureChild=null;}captureSender=null; }
function startCapture(sender){
  if(!isWin) return Promise.reject(new Error('La capture Ctrl est disponible sous Windows uniquement.'));
  stopCapture(); captureSender=sender;
  const script=`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct BFPOINT { public int X; public int Y; }
public static class BFCapture { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); [DllImport("user32.dll")] public static extern bool GetCursorPos(out BFPOINT p); }
'@
$last=$false
while($true){
  $down=((([int][BFCapture]::GetAsyncKeyState(17)) -band 0x8000) -ne 0)
  if($down -and -not $last){$p=New-Object BFPOINT;if([BFCapture]::GetCursorPos([ref]$p)){Write-Output ("CAPTURE|"+$p.X+"|"+$p.Y);[Console]::Out.Flush()}}
  $last=$down
  Start-Sleep -Milliseconds 20
}`;
  captureChild=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true});
  let buffer='';
  captureChild.stdout.on('data',data=>{
    buffer+=data.toString();let lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';
    for(const line of lines){const p=line.trim().split('|');if(p[0]==='CAPTURE'&&p.length>=3&&captureSender){captureSender.send('runner-event',{type:'cursor-captured',x:Number(p[1]),y:Number(p[2])});}}
  });
  captureChild.on('close',()=>{captureChild=null;});
  return Promise.resolve(true);
}

ipcMain.handle('start-mouse-capture',(event)=>startCapture(event.sender));
ipcMain.handle('stop-mouse-capture',()=>{stopCapture();return true;});
ipcMain.handle('get-cursor-position',async()=>{ const out=await runPS(helper+`$p=[BFWin]::Cursor(); Write-Output ("$($p.X)|$($p.Y)");`); const [x,y]=(out||'0|0').split('|').map(Number); return {x:Number.isFinite(x)?x:0,y:Number.isFinite(y)?y:0}; });
ipcMain.handle('stop-workflow',async()=>{activeRunStopped=true;if(activeChild){try{activeChild.kill();}catch{}};return true;});
ipcMain.handle('run-workflow',async(event,_blocks)=>executeBlocks(Array.isArray(_blocks)?_blocks:[],m=>event.sender.send('runner-event',m)));

function standalonePowerShellScript(workflowData){
  const workflowJson=JSON.stringify(workflowData);
  const workflowB64=Buffer.from(workflowJson,'utf8').toString('base64');
  return `# BlockFlow Automator - tâche autonome
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BFWinRun {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X,int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd,StringBuilder text,int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint processId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc,IntPtr lParam);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags,uint dx,uint dy,uint dwData,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public delegate bool EnumWindowsProc(IntPtr hWnd,IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT{public int X;public int Y;}
  public const uint MOUSEEVENTF_LEFTDOWN=0x0002,MOUSEEVENTF_LEFTUP=0x0004,MOUSEEVENTF_RIGHTDOWN=0x0008,MOUSEEVENTF_RIGHTUP=0x0010,MOUSEEVENTF_MIDDLEDOWN=0x0020,MOUSEEVENTF_MIDDLEUP=0x0040,MOUSEEVENTF_WHEEL=0x0800,KEYEVENTF_KEYUP=0x0002;
  public const long DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2=-4;
  public static void EnableDpi(){try{if(!SetProcessDpiAwarenessContext(new IntPtr(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)))SetProcessDPIAware();}catch{try{SetProcessDPIAware();}catch{}}}
  public static string Title(IntPtr h){var sb=new StringBuilder(1024);GetWindowText(h,sb,sb.Capacity);return sb.ToString();}
  public static bool Move(int x,int y){if(!SetCursorPos(x,y))return false;System.Threading.Thread.Sleep(40);POINT p;return GetCursorPos(out p)&&p.X==x&&p.Y==y;}
  public static bool Click(int x,int y,uint down,uint up){if(!Move(x,y))return false;mouse_event(down,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(35);mouse_event(up,0,0,0,UIntPtr.Zero);return true;}
  public static bool DoubleClick(int x,int y){if(!Move(x,y))return false;mouse_event(MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(75);mouse_event(MOUSEEVENTF_LEFTDOWN,0,0,0,UIntPtr.Zero);mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,UIntPtr.Zero);return true;}
  public static bool Scroll(int x,int y,int delta){if(!Move(x,y))return false;mouse_event(MOUSEEVENTF_WHEEL,0,0,unchecked((uint)delta),UIntPtr.Zero);return true;}
  public static bool IsKeyDown(int vk){try{return (GetAsyncKeyState(vk)&0x8000)!=0;}catch{return false;}}
}
'@
[BFWinRun]::EnableDpi() | Out-Null
$workflowJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${workflowB64}'))
$workflow=$workflowJson | ConvertFrom-Json
$vars=@{}
$stopped=$false

function Val($v){
  if($null -eq $v){return ''}
  if($v.kind -eq 'var'){ $n=[string]$v.name; if($vars.ContainsKey($n)){return $vars[$n]}; return '' }
  if($v.kind -eq 'literal'){return $v.value}
  if($v.kind -eq 'binary'){
    $a=Val $v.left; $b=Val $v.right
    $an=0.0;$bn=0.0
    $numeric=[double]::TryParse([string]$a,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$an) -and [double]::TryParse([string]$b,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$bn) -and [string]$a -ne '' -and [string]$b -ne ''
    $op=[string]$v.op
    if($op -eq '+' -and -not $numeric){return ([string]$a)+([string]$b)}
    if(-not $numeric){throw 'Les opérandes du calcul doivent être numériques.'}
    switch($op){
      '+' {return $an+$bn}
      '-' {return $an-$bn}
      '*' {return $an*$bn}
      '/' {if($bn -eq 0){throw 'Division par zéro.'};return $an/$bn}
      '%' {if($bn -eq 0){throw 'Modulo par zéro.'};return $an%$bn}
      '^' {return [math]::Pow($an,$bn)}
      default {throw "Opérateur inconnu : $op"}
    }
  }
  return $v
}
function Num($v,$fallback=0){$n=0.0;if([double]::TryParse([string](Val $v),[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$n)){return $n};return $fallback}
function Dur($v,$unit,$fallback=0){$n=Num $v $fallback;if([string]$unit -eq 's'){return [math]::Max(0,$n*1000)};return [math]::Max(0,$n)}
function DoWait($ms){$remaining=[math]::Max(0,[int]$ms);while(-not $stopped -and $remaining -gt 0){$step=[math]::Min(50,$remaining);Start-Sleep -Milliseconds $step;$remaining-=$step}}
function Vk($key){
  $k=([string]$key).ToUpperInvariant()
  $m=@{ENTER=13;TAB=9;ESC=27;SPACE=32;BACKSPACE=8;DELETE=46;INSERT=45;HOME=36;END=35;PGUP=33;PGDN=34;UP=38;DOWN=40;LEFT=37;RIGHT=39;F1=112;F2=113;F3=114;F4=115;F5=116;F6=117;F7=118;F8=119;F9=120;F10=121;F11=122;F12=123;CTRL=17;ALT=18;SHIFT=16;WIN=91}
  if($m.ContainsKey($k)){return [int]$m[$k]}
  if($k -match '^[A-Z0-9]$'){return [int][char]$k}
  return $null
}
function KeyDown($vk){[BFWinRun]::keybd_event([byte][int]$vk,0,0,[UIntPtr]::Zero)}
function KeyUp($vk){[BFWinRun]::keybd_event([byte][int]$vk,0,[BFWinRun]::KEYEVENTF_KEYUP,[UIntPtr]::Zero)}
function SendKey($key){$vk=Vk $key;if($null -eq $vk){throw "Touche non prise en charge : $key"};KeyDown $vk;Start-Sleep -Milliseconds 15;KeyUp $vk}
function SendHotkey($mods,$key){$vks=@();foreach($m in @($mods)){if([string]::IsNullOrWhiteSpace([string]$m)){continue};$vk=Vk $m;if($null -eq $vk){throw "Modificateur non pris en charge : $m"};KeyDown $vk;$vks+=$vk;Start-Sleep -Milliseconds 15};SendKey $key;foreach($vk in ($vks|Select-Object -Reverse)){Start-Sleep -Milliseconds 15;KeyUp $vk}}
function FindWindow($title){$script:bfFound=[IntPtr]::Zero;[BFWinRun]::EnumWindows({param($hw,$lp);$t=[BFWinRun]::Title($hw);if($t -like ('*'+$title+'*')){$script:bfFound=$hw;return $false};return $true},[IntPtr]::Zero)|Out-Null;return $script:bfFound}
function WindowExists($title){return [bool]((FindWindow $title) -ne [IntPtr]::Zero)}
function ProcessName($name){return [IO.Path]::GetFileNameWithoutExtension([string](Val $name))}
function ProcessRunning($name){$n=ProcessName $name;return $null -ne (Get-Process -Name $n -ErrorAction SilentlyContinue)}
function ProcessMainWindow($name){$n=ProcessName $name;$p=Get-Process -Name $n -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1;if($null -eq $p){return [IntPtr]::Zero};return $p.MainWindowHandle}
function WindowHandle($b){if([string]$b.targetMode -eq 'process'){return ProcessMainWindow $b.processName};return FindWindow ([string](Val $b.title))}
function WindowExistsTarget($b){return [bool]((WindowHandle $b) -ne [IntPtr]::Zero)}
function CloseWindowHandle($h){if($h -eq [IntPtr]::Zero){return $false};$pid=0;[BFWinRun]::GetWindowThreadProcessId($h,[ref]$pid)|Out-Null;$p=Get-Process -Id $pid -ErrorAction SilentlyContinue;if($null -eq $p){return $false};$p.CloseMainWindow()|Out-Null;return $true}
function LaunchTarget($b){$mode=[string]$b.launchMode;if($mode -eq 'file'){return [string](Val $b.filePath)}if($mode -eq 'system'){switch([string]$b.system){'explorer'{return 'explorer.exe'}'notepad'{return 'notepad.exe'}'calculator'{return 'calc.exe'}'paint'{return 'mspaint.exe'}'taskmgr'{return 'taskmgr.exe'}'cmd'{return 'cmd.exe'}'powershell'{return 'powershell.exe'}'settings'{return 'ms-settings:'}'control'{return 'control.exe'}'snippingtool'{return 'snippingtool.exe'}default{return 'explorer.exe'}}}return [string](Val $b.exe)}
function Compare($a,$b,$op){$aa=[string]$a;$bb=[string]$b;$na=0.0;$nb=0.0;$numeric=[double]::TryParse($aa,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$na) -and [double]::TryParse($bb,[Globalization.NumberStyles]::Any,[Globalization.CultureInfo]::InvariantCulture,[ref]$nb);if($numeric){$A=$na;$B=$nb}else{$A=$aa;$B=$bb};switch($op){'equals'{return [bool]($A -eq $B)}'not-equals'{return [bool]($A -ne $B)}'contains'{return [bool]$aa.Contains($bb)}'starts-with'{return [bool]$aa.StartsWith($bb)}'ends-with'{return [bool]$aa.EndsWith($bb)}'gt'{return [bool]($A -gt $B)}'gte'{return [bool]($A -ge $B)}'lt'{return [bool]($A -lt $B)}'lte'{return [bool]($A -le $B)}default{return $false}}}
function IsHotkeyDown($c){
  try{
    $vks=@()
    foreach($m in @($c.modifiers)){
      $ms=[string]$m
      if([string]::IsNullOrWhiteSpace($ms)){continue}
      $vk=Vk $ms
      if($null -eq $vk){return $false}
      $vks += [int]$vk
    }
    $keyText=[string]$c.key
    if([string]::IsNullOrWhiteSpace($keyText)){return $false}
    $keyVk=Vk $keyText
    if($null -eq $keyVk){return $false}
    $vks += [int]$keyVk
    foreach($v in $vks){if(-not [BFWinRun]::IsKeyDown([int]$v)){return $false}}
    return $true
  }catch{return $false}
}
function WaitHotkey($c){
  while(-not $stopped){$down=[bool](IsHotkeyDown $c);if(-not $down){break};Start-Sleep -Milliseconds 20}
  while(-not $stopped){$down=[bool](IsHotkeyDown $c);if($down){break};Start-Sleep -Milliseconds 20}
  while(-not $stopped){$down=[bool](IsHotkeyDown $c);if(-not $down){break};Start-Sleep -Milliseconds 20}
  return (-not $stopped)
}
function Cond($c){
  if($null -eq $c){return $false}
  switch([string]$c.kind){
    'always'{return $true}
    'window'{return WindowExists ([string](Val $c.title))}
    'process'{return ProcessRunning $c.processName}
    'keyboard'{if([string]$c.mode -eq 'wait'){return WaitHotkey $c};return IsHotkeyDown $c}
    'compare'{return Compare (Val $c.left) (Val $c.right) ([string]$c.op)}
    'not'{return -not [bool](Cond $c.item)}
    'logic'{if([string]$c.op -eq 'or'){foreach($i in @($c.items)){if([bool](Cond $i)){return $true}};return $false}else{foreach($i in @($c.items)){if(-not [bool](Cond $i)){return $false}};return $true}}
    default{return $false}
  }
}
function RunList($list){
  foreach($b in @($list)){
    if($stopped){return $false}
    switch([string]$b.type){
      'mouse-click'{$x=[int](Num $b.x 0);$y=[int](Num $b.y 0);$button=[string]$b.button;$down=@{left=[BFWinRun]::MOUSEEVENTF_LEFTDOWN;right=[BFWinRun]::MOUSEEVENTF_RIGHTDOWN;middle=[BFWinRun]::MOUSEEVENTF_MIDDLEDOWN}[[string]$button];$up=@{left=[BFWinRun]::MOUSEEVENTF_LEFTUP;right=[BFWinRun]::MOUSEEVENTF_RIGHTUP;middle=[BFWinRun]::MOUSEEVENTF_MIDDLEUP}[[string]$button];if($null -eq $down -or $null -eq $up){throw "Bouton souris inconnu : $button"};if(-not [BFWinRun]::Click($x,$y,$down,$up)){throw 'Echec du clic souris.'}}
      'mouse-double'{if(-not [BFWinRun]::DoubleClick([int](Num $b.x 0),[int](Num $b.y 0))){throw 'Echec du double-clic souris.'}}
      'mouse-move'{if(-not [BFWinRun]::SetCursorPos([int](Num $b.x 0),[int](Num $b.y 0))){throw 'Impossible de déplacer la souris.'}}
      'mouse-scroll'{if(-not [BFWinRun]::Scroll([int](Num $b.x 0),[int](Num $b.y 0),[int]((Num $b.amount 1)*120))){throw 'Echec de la molette souris.'}}
      'keyboard-type'{$w=New-Object -ComObject WScript.Shell;$w.SendKeys(([string](Val $b.text)))}
      'keyboard-key'{SendKey $b.key}
      'keyboard-hotkey'{SendHotkey $b.modifiers $b.key}
      'launch'{$target=LaunchTarget $b;if([string]::IsNullOrWhiteSpace($target)){throw 'Programme à lancer vide.'};Start-Process -FilePath $target|Out-Null}
      'window-activate'{$h=WindowHandle $b;if($h -eq [IntPtr]::Zero){if([string]$b.targetMode -eq 'process'){throw "Programme introuvable : $(Val $b.processName)"}else{throw "Fenêtre introuvable : $(Val $b.title)"}};[BFWinRun]::ShowWindow($h,9)|Out-Null;[BFWinRun]::SetForegroundWindow($h)|Out-Null}
      'window-close'{$h=WindowHandle $b;if($h -ne [IntPtr]::Zero){if([string]$b.targetMode -eq 'process'){Get-Process -Name (ProcessName $b.processName) -ErrorAction SilentlyContinue|ForEach-Object{if($_.MainWindowHandle -ne 0){$_.CloseMainWindow()|Out-Null}else{$_.Kill()}}}else{CloseWindowHandle $h|Out-Null}}}
      'wait-window'{$deadline=[datetime]::UtcNow.AddMilliseconds((Dur $b.timeout $b.timeoutUnit 15000));$ok=$false;while(-not $stopped -and [datetime]::UtcNow -lt $deadline){if(WindowExistsTarget $b){$ok=$true;break};DoWait (Num $b.interval 250)};if(-not $ok){if([string]$b.targetMode -eq 'process'){throw 'Délai dépassé : programme introuvable.'}else{throw 'Délai dépassé : fenêtre introuvable.'}}}
      'window-test'{$ok=[bool](WindowExistsTarget $b);$name=[string]$b.saveAs;if([string]::IsNullOrWhiteSpace($name)){$name='resultat'};$vars[$name]=$ok}
      'wait'{DoWait (Dur $b.duration $b.unit 500)}
      'set-variable'{$vars[[string]$b.name]=Val $b.value}
      'change-variable'{$n=[string]$b.name;$old=Num @{kind='literal';value=$vars[$n]} 0;$vars[$n]=$old+(Num $b.amount 0)}
      'active-title'{$h=if([string]$b.targetMode -eq 'process'){ProcessMainWindow $b.processName}else{[BFWinRun]::GetForegroundWindow()};$name=[string]$b.saveAs;if([string]::IsNullOrWhiteSpace($name)){$name='activeTitle'};$vars[$name]=if($h -eq [IntPtr]::Zero){''}else{[BFWinRun]::Title($h)}}
      'log'{Write-Output ([string](Val $b.message))}
      'if'{if([bool](Cond $b.condition)){if(-not (RunList $b.then)){return $false}}else{if(-not (RunList $b.else)){return $false}}}
      'repeat'{$n=[math]::Max(0,[math]::Min(10000,[math]::Floor((Num $b.count 0))));for($i=0;$i -lt $n;$i++){if(-not (RunList $b.children)){return $false}}}
      'while'{$g=0;while(-not $stopped -and $g -lt 10000){$g++;$conditionResult=[bool](Cond $b.condition);if(-not $conditionResult){break};if(-not (RunList $b.children)){return $false}};if($g -ge 10000){throw 'Boucle Tant que arrêtée après 10 000 itérations.'}}
      'stop'{$stopped=$true;return $false}
    }
  }
  return $true
}

try {
  if($null -eq $workflow -or $null -eq $workflow.blocks){throw 'Workflow BlockFlow invalide.'}
  Write-Output ('BlockFlow : ' + [string]$workflow.name)
  RunList $workflow.blocks | Out-Null
} catch {
  Write-Error $_
  exit 1
}
`;
}

function standaloneCmdContent(workflowData){
  const ps=standalonePowerShellScript(workflowData);
  const b64=Buffer.from('\uFEFF'+ps,'utf16le').toString('base64');
  const chunks=b64.match(/.{1,120}/g)||[];
  const data=chunks.join('\r\n');
  const wrapper = [
    '$ErrorActionPreference="Stop"',
    '$self=$env:BF_SELF',
    'if([string]::IsNullOrWhiteSpace($self)){throw "BlockFlow: fichier de tâche introuvable."}',
    '$raw=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($self))',
    'if($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF){$raw=$raw.Substring(1)}',
    '$m="## BLOCKFLOW-PS ##"',
    '$e="## END-BLOCKFLOW-PS ##"',
    '$start=$raw.IndexOf($m,[StringComparison]::Ordinal)',
    'if($start -lt 0){throw "BlockFlow: moteur absent."}',
    '$start += $m.Length',
    '$finish=$raw.IndexOf($e,$start,[StringComparison]::Ordinal)',
    'if($finish -lt 0){throw "BlockFlow: fin du moteur absente."}',
    '$encoded=($raw.Substring($start,$finish-$start) -replace "\\s","")',
    '$bytes=[Convert]::FromBase64String($encoded)',
    '$tmp=Join-Path $env:TEMP ("BlockFlow-"+[guid]::NewGuid().ToString()+".ps1")',
    '[IO.File]::WriteAllBytes($tmp,$bytes)',
    'try { & $env:BF_PS -NoProfile -ExecutionPolicy Bypass -File $tmp *>&1 | Tee-Object -FilePath $env:BF_LOG -Append; $code=$LASTEXITCODE; if($null -eq $code){$code=0}; exit $code } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }'
  ].join('\r\n');
  const wrapperB64=Buffer.from(wrapper,'utf16le').toString('base64');
  return [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "BF_SELF=%~f0"',
    'set "BF_LOG=%~dp0%~n0.blockflow.log"',
    'set "BF_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    'if not exist "%BF_PS%" set "BF_PS=powershell.exe"',
    '"%BF_PS%" -NoProfile -ExecutionPolicy Bypass -EncodedCommand '+wrapperB64,
    'set "BF_EXIT=%ERRORLEVEL%"',
    'if not "%BF_EXIT%"=="0" echo BlockFlow a rencontre une erreur. Voir "%BF_LOG%"',
    'endlocal & exit /b %BF_EXIT%',
    '## BLOCKFLOW-PS ##',
    data,
    '## END-BLOCKFLOW-PS ##',
    ''
  ].join('\r\n');
}

ipcMain.handle('save-workflow',async(_event,data)=>{const res=await dialog.showSaveDialog({title:'Enregistrer le workflow',defaultPath:'mon-workflow.blockflow.json',filters:[{name:'BlockFlow',extensions:['json']} ]});if(res.canceled)return null;try{fs.writeFileSync(res.filePath,JSON.stringify(data,null,2),'utf8');return res.filePath;}catch(e){throw new Error('Impossible d’enregistrer : '+e.message);}});
ipcMain.handle('export-runnable',async(_event,data)=>{
  const res=await dialog.showSaveDialog({title:'Exporter une tâche autonome',defaultPath:(data?.name||'ma-tache')+'.blockflow.cmd',filters:[{name:'Tâche BlockFlow exécutable',extensions:['cmd']} ]});
  if(res.canceled||!res.filePath)return null;
  try{fs.writeFileSync(res.filePath,standaloneCmdContent(data),'utf8');return res.filePath;}catch(e){throw new Error('Impossible d’exporter la tâche : '+e.message);}
});
ipcMain.handle('create-desktop-shortcut',async(_event,targetPath)=>{
  if(!isWin) throw new Error('Les raccourcis Bureau sont disponibles sous Windows uniquement.');
  const desktop=app.getPath('desktop');
  const shortcut=path.join(desktop,path.basename(targetPath,'.cmd')+'.lnk');
  const cmdExe=process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const args=`/d /s /c ""${targetPath}""`;
  shell.writeShortcutLink(shortcut,{target:cmdExe,args,cwd:path.dirname(targetPath),description:'Tâche autonome BlockFlow Automator',icon:process.execPath,iconIndex:0});
  return shortcut;
});

ipcMain.handle('open-workflow',async()=>{const res=await dialog.showOpenDialog({title:'Ouvrir un workflow',filters:[{name:'BlockFlow',extensions:['json']}],properties:['openFile']});if(res.canceled||!res.filePaths[0])return null;try{return JSON.parse(fs.readFileSync(res.filePaths[0],'utf8'));}catch(e){throw new Error('Fichier BlockFlow invalide : '+e.message);}});
ipcMain.handle('platform',()=>process.platform);

app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('before-quit',()=>{stopCapture();if(activeChild){try{activeChild.kill();}catch{}}});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
