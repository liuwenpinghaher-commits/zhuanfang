import { readFileSync } from "node:fs";
import WebSocket from "ws";
// F-07:key 前缀无验证价值却增加凭据识别面,日志只回答"配置了没有"
import { describeKeyStatus } from "./lib/redact.mjs";
function loadEnv(url){const e={};try{for(const l of readFileSync(url,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!l.trim().startsWith("#"))e[m[1]]=m[2];}}catch{}return e;}
const env=loadEnv(new URL("../.env.local",import.meta.url));const KEY=env.DASHSCOPE_API_KEY;
const URL_WS="wss://dashscope.aliyuncs.com/api-ws/v1/inference";
function synth({label,extra},i){return new Promise((resolve)=>{
  const ws=new WebSocket(URL_WS,{headers:{Authorization:`Bearer ${KEY}`}});
  const taskId=`pros-${i}-${Date.now()%100000}`;let bytes=0,done=false;
  const finish=(v,d)=>{if(done)return;done=true;try{ws.close();}catch{}resolve({label,verdict:v,detail:d,bytes});};
  const timer=setTimeout(()=>finish(bytes>0?"PARTIAL":"TIMEOUT",`${bytes}B`),20000);
  const params={text_type:"PlainText",voice:"longanyang",format:"pcm",sample_rate:24000,...extra};
  ws.on("open",()=>ws.send(JSON.stringify({header:{action:"run-task",task_id:taskId,streaming:"duplex"},payload:{task_group:"audio",task:"tts",function:"SpeechSynthesizer",model:"cosyvoice-v3-plus",parameters:params,input:{}}})));
  ws.on("message",(data,isBinary)=>{if(isBinary||(Buffer.isBuffer(data)&&data[0]!==0x7b)){bytes+=data.length;return;}let msg={};try{msg=JSON.parse(data.toString());}catch{bytes+=data.length;return;}const ev=msg.header?.event;
    if(ev==="task-started"){ws.send(JSON.stringify({header:{action:"continue-task",task_id:taskId,streaming:"duplex"},payload:{input:{text:"你认同这个顺序吗？能说说你的理由吗？"}}}));ws.send(JSON.stringify({header:{action:"finish-task",task_id:taskId,streaming:"duplex"},payload:{input:{}}}));}
    else if(ev==="task-finished"){clearTimeout(timer);finish(bytes>0?"OK":"DONE_NO_AUDIO",`${bytes}B`);}
    else if(ev==="task-failed"){clearTimeout(timer);finish("FAILED",`${msg.header?.error_code}: ${String(msg.header?.error_message).slice(0,120)}`);}});
  ws.on("unexpected-response",(_q,res)=>{clearTimeout(timer);finish("HTTP_ERR",`HTTP ${res.statusCode}`);});
  ws.on("error",(e)=>{clearTimeout(timer);finish("WS_ERR",String(e?.message||e).slice(0,120));});});}
const cases=[
  {label:"baseline",                 extra:{}},
  {label:"rate=0.6 (slow)",          extra:{rate:0.6}},
  {label:"rate=1.6 (fast)",          extra:{rate:1.6}},
  {label:"pitch=1.4",                extra:{pitch:1.4}},
  {label:"volume=20",                extra:{volume:20}},
  {label:"instruction(单) 温和缓慢", extra:{instruction:"语气温和亲切，语速偏慢"}},
];
console.log(`\n=== CosyVoice prosody params spike (key ${describeKeyStatus(KEY)}) ===\n`);
for(let i=0;i<cases.length;i++){const r=await synth(cases[i],i);const icon=r.verdict==="OK"?"✅":"❌";console.log(`${icon} ${r.label.padEnd(26)} → ${r.verdict} (${r.detail})`);}
console.log("\n(rate 改变时长→字节数应不同；pitch/volume 不改时长→字节数可能相同但音色已变)\n");
