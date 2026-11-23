#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),cp=require("node:child_process");
const {parseArgs}=require("node:util");
const {values:v}=parseArgs({options:{
  help:{type:"boolean"},root:{type:"string"},stage:{type:"string"},
  "old-launcher-pid":{type:"string"},"old-launcher-start":{type:"string"},
  "old-worker-pid":{type:"string"},"old-worker-start":{type:"string"},
  "expected-legacy-entry":{type:"string"},"expected-device-id":{type:"string"},
  "original-script-sha256":{type:"string"},"updated-script":{type:"string"},"updated-script-sha256":{type:"string"},
  bootstrap:{type:"string"},"bootstrap-sha256":{type:"string"},
  "target-version":{type:"string"},"target-sha256":{type:"string"},
  "relay-url":{type:"string",default:"https://relay.cyjin.dev"},
  "manifest-url":{type:"string"},"session":{type:"string",default:"relay"}
}});
if(v.help){console.log("Prepare a private, bounded Android relay cutover plan; this never stops or starts the active relay.\nRequired: --root --stage --old-launcher-pid --old-launcher-start --old-worker-pid --old-worker-start --expected-legacy-entry --expected-device-id --original-script-sha256 --updated-script --updated-script-sha256 --bootstrap --bootstrap-sha256 --target-version --target-sha256\nOptional: --relay-url --manifest-url --session");process.exit(0)}
const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function need(name){if(!v[name])throw Error("Missing --"+name);return v[name]}
function digestArg(name){const value=need(name).toLowerCase();if(!/^[a-f0-9]{64}$/.test(value))throw Error("Invalid digest: "+name);return value}
function proc(pid,start){
  if(!/^\d+$/.test(pid)||Number(pid)<2||!/^\d+$/.test(start))throw Error("PID/start ticks must be verified positive decimal values");
  const base="/proc/"+pid,stat=fs.readFileSync(base+"/stat","utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
  if(fields[19]!==start||fields[0]==="Z"||fs.statSync(base).uid!==process.getuid())throw Error("Expected live process identity/ownership changed");
  return{pid:Number(pid),state:fields[0],ppid:Number(fields[1]),start:fields[19],exe:fs.readlinkSync(base+"/exe"),args:fs.readFileSync(base+"/cmdline").toString().split("\0").filter(Boolean)}
}
function save(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600})}
function copy(source,target,digest,mode=0o600){
  if(hash(source)!==digest)throw Error("Source digest changed");
  if(fs.existsSync(target)){if(hash(target)!==digest)throw Error("Existing preserved artifact conflicts");return}
  fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,mode);
  if(hash(target)!==digest)throw Error("Copied artifact digest mismatch")
}
try{
  process.umask(0o077);
  const root=fs.realpathSync(need("root")),stage=path.resolve(need("stage"));
  const oldLauncher=proc(need("old-launcher-pid"),need("old-launcher-start"));
  const oldWorker=proc(need("old-worker-pid"),need("old-worker-start"));
  const liveScript=path.join(root,".mcp-relay/run-tablet.sh"),config=path.join(root,".mcp-relay/device.json");
  const legacyEntry=path.resolve(need("expected-legacy-entry"));
  if(oldWorker.ppid!==oldLauncher.pid||oldLauncher.args[1]!==liveScript
      ||oldWorker.args[1]!==legacyEntry||!oldWorker.args.includes("connect")
      ||oldWorker.args[oldWorker.args.indexOf("--config")+1]!==config
      ||oldWorker.args[oldWorker.args.indexOf("--root")+1]!==root
      ||fs.realpathSync(oldWorker.exe)!==fs.realpathSync(process.execPath))throw Error("The verified legacy process tree/entry/config differs");
  const environment={};
  for(const item of fs.readFileSync("/proc/"+oldWorker.pid+"/environ").toString().split("\0")){
    const i=item.indexOf("=");if(i>0)environment[item.slice(0,i)]=item.slice(i+1)
  }
  for(const key of ["PREFIX","HOME","ANDROID_DATA","ANDROID_ROOT","BOOTCLASSPATH"])if(!environment[key])throw Error("Original environment missing "+key);
  if(environment.MCP_RELAY_WORKER==="1"||environment.MCP_RELAY_SUPERVISOR==="1")throw Error("This process is already managed; use its update supervisor instead");
  if(fs.realpathSync(environment.PREFIX+"/bin/bash")!==fs.realpathSync(oldLauncher.exe))throw Error("Launcher executable is not the verified Termux bash");
  const cfg=JSON.parse(fs.readFileSync(config,"utf8"));
  const relayUrl=v["relay-url"].replace(/\/+$/,"");
  if(cfg.url?.replace(/\/+$/,"")!==relayUrl||cfg.deviceId!==need("expected-device-id"))throw Error("Saved relay URL/device identity differs");
  const manifestUrl=v["manifest-url"]||relayUrl+"/updates/device/stable.json";
  const relay=new URL(relayUrl),manifest=new URL(manifestUrl);
  if(relay.protocol!=="https:"||manifest.protocol!=="https:"||relay.origin!==manifest.origin
      ||relay.username||relay.password||manifest.username||manifest.password)throw Error("Unexpected release origin");
  const originalScriptSha256=digestArg("original-script-sha256"),updatedScriptSha256=digestArg("updated-script-sha256");
  const bootstrapSha256=digestArg("bootstrap-sha256"),expectedSha256=digestArg("target-sha256");
  const updatedScript=path.resolve(need("updated-script")),bootstrapSource=path.resolve(need("bootstrap"));
  if(hash(liveScript)!==originalScriptSha256||hash(updatedScript)!==updatedScriptSha256||hash(bootstrapSource)!==bootstrapSha256)throw Error("Staged artifact or original script digest differs");
  const expectedVersion=need("target-version");
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expectedVersion))throw Error("Invalid target version");
  const tmux=environment.PREFIX+"/bin/tmux";
  const panes=cp.execFileSync(tmux,["list-panes","-t",v.session,"-F","#{session_name}\t#{pane_pid}"],{env:environment,encoding:"utf8",timeout:5000}).trim().split("\n");
  if(panes.length!==1||panes[0]!==v.session+"\t"+oldLauncher.pid)throw Error("Expected tmux session is not the single verified launcher pane");
  fs.mkdirSync(stage,{recursive:true,mode:0o700});
  const originalBackup=path.join(stage,"run-tablet.before-"+originalScriptSha256.slice(0,12)+".sh");
  const scriptMode=fs.statSync(liveScript).mode&0o777;
  copy(liveScript,originalBackup,originalScriptSha256,scriptMode);
  const runId=new Date().toISOString().replace(/[:.]/g,"-")+"-"+crypto.randomUUID().slice(0,8),runDir=path.join(stage,"cutover-"+runId);
  fs.mkdirSync(runDir,{mode:0o700});
  const environmentFile=path.join(runDir,"preserved-environment.json");save(environmentFile,environment);
  const job=path.join(runDir,"cutover.cjs"),environmentRunner=path.join(runDir,"preserved-env-runner.cjs");
  copy(path.join(__dirname,"cutover.cjs"),job,hash(path.join(__dirname,"cutover.cjs")));
  copy(path.join(__dirname,"preserved-env-runner.cjs"),environmentRunner,hash(path.join(__dirname,"preserved-env-runner.cjs")));
  const plan={schemaVersion:1,runId,runDir,root,session:v.session,node:oldWorker.exe,bash:oldLauncher.exe,tmux,oldLauncher,oldWorker,
    liveScript,originalScriptSha256,originalBackup,scriptMode,updatedScript,updatedScriptSha256,bootstrapSource,bootstrapSha256,
    bootstrapDestination:path.join(root,".local/share/mcp-relay/launcher.cjs"),manifestUrl,expectedVersion,expectedSha256,
    config,configSha256:hash(config),deviceId:cfg.deviceId,legacyEntrySha256:hash(legacyEntry),environmentFile,environmentSha256:hash(environmentFile),
    environmentRunner,environmentRunnerSha256:hash(environmentRunner),job,jobSha256:hash(job),
    planFile:path.join(runDir,"plan.json"),receipt:path.join(runDir,"receipt.json"),scheduledReceipt:path.join(runDir,"scheduled.json"),notBefore:null};
  save(plan.planFile,plan);
  console.log(JSON.stringify({phase:"prepared-not-scheduled",planFile:plan.planFile,jobSha256:plan.jobSha256,
    configSha256:plan.configSha256,oldLauncherPid:oldLauncher.pid,oldWorkerPid:oldWorker.pid,environmentSha256:plan.environmentSha256},null,2));
}catch(error){console.error(String(error));process.exitCode=1}
