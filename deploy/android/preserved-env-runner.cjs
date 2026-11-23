"use strict";
const fs=require("node:fs"),cp=require("node:child_process");
const plan=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const env=JSON.parse(fs.readFileSync(plan.environmentFile,"utf8"));
for(const key of ["TMUX","TMUX_PANE","TERM","TERMCAP","SSH_TTY"]){
  if(process.env[key]!==undefined)env[key]=process.env[key];else delete env[key];
}
for(const key of ["MCP_RELAY_WORKER","MCP_RELAY_SUPERVISOR","MCP_RELAY_LAUNCHED","MCP_RELAY_START_DRAINED"])env[key]="0";
const child=cp.spawn(plan.bash,[plan.liveScript],{cwd:plan.root,env,stdio:"inherit"});
for(const signal of ["SIGTERM","SIGINT","SIGHUP"])process.on(signal,()=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal)});
child.once("error",(error)=>{process.stderr.write(String(error)+"\n");process.exitCode=1});
child.once("exit",(code,signal)=>{process.exitCode=code===null?1:code});
