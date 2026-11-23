#!/usr/bin/env node
"use strict";
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
if(process.argv.includes("--help")){console.log("Usage: node schedule.cjs <private-plan.json> [--execute]\nWithout --execute, print a plan. With it, write a scheduling receipt and start one detached finite transaction, delayed by 20 seconds.");process.exit(0)}
const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
try{
  const p=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  if(!process.argv.includes("--execute")){console.log(JSON.stringify({execute:false,planFile:p.planFile,targetVersion:p.expectedVersion,targetSha256:p.expectedSha256,delaySeconds:20},null,2));process.exit(0)}
  if(fs.existsSync(p.scheduledReceipt))throw Error("This transaction has already been scheduled; inspect its receipt before preparing another");
  for(const[file,expected]of[[p.job,p.jobSha256],[p.environmentRunner,p.environmentRunnerSha256],
    [p.environmentFile,p.environmentSha256],[p.liveScript,p.originalScriptSha256],[p.config,p.configSha256]])
    if(hash(file)!==expected)throw Error("Reviewed transaction input digest changed");
  p.notBefore=new Date(Date.now()+20000).toISOString();
  fs.writeFileSync(p.planFile,JSON.stringify(p,null,2)+"\n",{mode:0o600});
  const receipt={schemaVersion:1,phase:"scheduled",runId:p.runId,notBefore:p.notBefore,jobPid:null,receipt:p.receipt,
    planFile:p.planFile,expectedVersion:p.expectedVersion,expectedSha256:p.expectedSha256,originalConfigSha256:p.configSha256};
  fs.writeFileSync(p.scheduledReceipt,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
  const log=fs.openSync(p.runDir+"/transaction.log","a",0o600);
  const child=cp.spawn(p.node,[p.job,p.planFile],{cwd:p.root,env:JSON.parse(fs.readFileSync(p.environmentFile,"utf8")),
    detached:true,stdio:["ignore",log,log]});
  child.once("error",error=>{receipt.phase="spawn-failed";receipt.error=String(error);
    fs.writeFileSync(p.scheduledReceipt,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});process.exitCode=1});
  receipt.jobPid=child.pid;
  fs.writeFileSync(p.scheduledReceipt,JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
  child.unref();fs.closeSync(log);console.log(JSON.stringify(receipt,null,2));
}catch(error){console.error(String(error));process.exitCode=1}
