// Spike: CosyVoice v3-plus + 系统音色(longanyang)到底支持哪些情绪/语气参数?
// memory 已知:instruction 任意自由文本 → 428。本 spike 验证 fixed-format instruction(单词/短指令/
// 标签)与 SSML(enable_ssml / text_type=SSML)是否被系统音色接受。OK=出音频,FAILED=报错码。
import { readFileSync } from "node:fs";
import WebSocket from "ws";
function loadEnv(url){const e={};try{for(const l of readFileSync(url,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith("#"))e[m[1]]=m[2];}}catch{}return e;}
const env=loadEnv(new URL("../.env.local",import.meta.url));const KEY=env.DASHSCOPE_API_KEY;
const URL_WS="wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_TEXT="你认同这个顺序吗？能说说你的理由吗？";
function synth({label,extra,text},i){return new Promise((resolve)=>{
  const ws=new WebSocket(URL_WS,{headers:{Authorization:`Bearer ${KEY}`}});
  const taskId=`inst-${i}-${Date.now()%100000}`;let bytes=0,done=false;
  const finish=(v,d)=>{if(done)return;done=true;try{ws.close();}catch{}resolve({label,verdict:v,detail:d,bytes});};
  const timer=setTimeout(()=>finish(bytes>0?"PARTIAL":"TIMEOUT",`${bytes}B`),20000);
  const params={text_type:"PlainText",voice:"longanyang",format:"pcm",sample_rate:24000,...extra};
  ws.on("open",()=>ws.send(JSON.stringify({header:{action:"run-task",task_id:taskId,streaming:"duplex"},payload:{task_group:"audio",task:"tts",function:"SpeechSynthesizer",model:"cosyvoice-v3-plus",parameters:params,input:{}}})));
  ws.on("message",(data,isBinary)=>{if(isBinary||(Buffer.isBuffer(data)&&data[0]!==0x7b)){bytes+=data.length;return;}let msg={};try{msg=JSON.parse(data.toString());}catch{bytes+=data.length;return;}const ev=msg.header?.event;
    if(ev==="task-started"){ws.send(JSON.stringify({header:{action:"continue-task",task_id:taskId,streaming:"duplex"},payload:{input:{text:text??DEFAULT_TEXT}}}));ws.send(JSON.stringify({header:{action:"finish-task",task_id:taskId,streaming:"duplex"},payload:{input:{}}}));}
    else if(ev==="task-finished"){clearTimeout(timer);finish(bytes>0?"OK":"DONE_NO_AUDIO",`${bytes}B`);}
    else if(ev==="task-failed"){clearTimeout(timer);finish("FAILED",`${msg.header?.error_code}: ${String(msg.header?.error_message).slice(0,110)}`);}});
  ws.on("unexpected-response",(_q,res)=>{clearTimeout(timer);finish("HTTP_ERR",`HTTP ${res.statusCode}`);});
  ws.on("error",(e)=>{clearTimeout(timer);finish("WS_ERR",String(e?.message||e).slice(0,110));});});}
const cases=[
  {label:"baseline",                                extra:{}},
  {label:"组合 enable_ssml(break)+rate/pitch/vol",  extra:{enable_ssml:true, rate:0.85, pitch:1.1, volume:55}, text:"<speak>你好。<break time=\"400ms\"/>这是情绪+停顿组合测试。</speak>"},
  {label:"纯 rate/pitch/volume(无 ssml)",           extra:{rate:0.85, pitch:1.1, volume:55}},
];
console.log(`\n=== CosyVoice instruct/SSML spike · longanyang (key ${String(KEY).slice(0,6)}…) ===\n`);
for(let i=0;i<cases.length;i++){const r=await synth(cases[i],i);const icon=r.verdict==="OK"?"✅":(r.verdict==="FAILED"?"❌":"⚠️ ");console.log(`${icon} ${r.label.padEnd(28)} → ${r.verdict} (${r.detail})`);}
console.log("\n(OK=系统音色接受该参数并出音频；FAILED+错误码=不支持。对比 baseline 字节数判断是否真生效)\n");
process.exit(0);
