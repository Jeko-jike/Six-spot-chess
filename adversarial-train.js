'use strict';

// Lightweight adversarial trainer: self-play, replay, challenger training and champion gating.
// No external packages are required. It writes a browser-compatible policy/value model.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const num = (name, fallback, min = 1) => Math.max(min, Number(arg(name, fallback)) || fallback);
const N = num('size', 19);
const WIN = num('win', N === 13 ? 5 : 6);
if (!((N === 13 && WIN === 5) || (N === 19 && WIN === 6))) throw new Error('Only 13x13 win5 and 19x19 win6 are supported.');

const ROUNDS = num('rounds', 4);
const SELF_GAMES = num('self-games', N === 19 ? 240 : 320);
const ARENA_GAMES = num('arena-games', 80, 10);
const REPLAY_LIMIT = num('replay', 250000, 1000);
const EPOCHS = num('epochs', 3);
const HIDDEN = num('hidden', 32, 8);
const CANDIDATES = num('candidates', N === 19 ? 18 : 22, 8);
const PROMOTE = Number(arg('promote', 0.53));
const LR = Number(arg('lr', 0.0025));
const root = __dirname;
const tag = `${N}x${N}-win${WIN}`;
const suffix = String(arg('suffix','')).replace(/[^a-zA-Z0-9_-]/g,'');
const fileTag = suffix ? `${tag}-${suffix}` : tag;
const stateFile = path.join(root, `adversarial-state-${fileTag}.json`);
const replayFile = path.join(root, `adversarial-replay-${fileTag}.json.gz`);
const outputFile = path.join(root, `trained-weights-${fileTag}.json`);
const DIRS = [[1,0],[0,1],[1,1],[1,-1]];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const clock = () => new Date().toLocaleTimeString('zh-CN',{hour12:false});
const duration = ms => {const sec=Math.max(0,Math.round(ms/1000)),h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;};
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -12, 12)));
const inb = (r,c) => r >= 0 && r < N && c >= 0 && c < N;
const randWeight = scale => (Math.random() * 2 - 1) * scale;
const clone = x => JSON.parse(JSON.stringify(x));

function freshModel() {
  return {
    hiddenW:Array.from({length:HIDDEN},()=>Array.from({length:7},()=>randWeight(.16))),
    hiddenB:Array(HIDDEN).fill(0), valueW:Array.from({length:HIDDEN},()=>randWeight(.12)), valueB:0,
    policy:[1.18,.92,.42,.16,.24]
  };
}
function normalizeModel(source) {
  if (!source?.hiddenW?.length) return freshModel();
  const m = clone(source), old = m.hiddenW.length;
  while (m.hiddenW.length < HIDDEN) { m.hiddenW.push(Array.from({length:7},()=>randWeight(.04))); m.hiddenB.push(0); m.valueW.push(randWeight(.03)); }
  if (m.hiddenW.length > HIDDEN) { m.hiddenW.length=HIDDEN; m.hiddenB.length=HIDDEN; m.valueW.length=HIDDEN; }
  if (!Array.isArray(m.policy) || m.policy.length !== 5) m.policy=[1.18,.92,.42,.16,.24];
  if (old !== HIDDEN) console.log(`Expanded model: ${old} -> ${HIDDEN} hidden units.`);
  return m;
}
function perturb(model,scale=.012){for(const row of model.hiddenW)for(let i=0;i<row.length;i++)row[i]+=randWeight(scale);for(let i=0;i<model.hiddenB.length;i++)model.hiddenB[i]+=randWeight(scale*.35);for(let i=0;i<model.valueW.length;i++)model.valueW[i]+=randWeight(scale);model.valueB+=randWeight(scale*.35);for(let i=0;i<model.policy.length;i++)model.policy[i]+=randWeight(scale*.5);return model;}
function loadSeed() {
  if (fs.existsSync(stateFile)) return normalizeModel(JSON.parse(fs.readFileSync(stateFile,'utf8')).champion);
  if (fs.existsSync(outputFile)) return normalizeModel(JSON.parse(fs.readFileSync(outputFile,'utf8')).model);
  return freshModel();
}
function loadReplay() {
  if (!fs.existsSync(replayFile)) return [];
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(replayFile)).toString('utf8')); }
  catch { console.warn('Replay file could not be read; starting a new replay pool.'); return []; }
}
function saveReplay(data) { fs.writeFileSync(replayFile,zlib.gzipSync(JSON.stringify(data),{level:6})); }
function board() { return Array.from({length:N},()=>new Uint8Array(N)); }
function win(b,r,c,color) { for(const[dr,dc]of DIRS){let n=1;for(const s of[-1,1]){let x=r+dr*s,y=c+dc*s;while(inb(x,y)&&b[x][y]===color){n++;x+=dr*s;y+=dc*s}}if(n>=WIN)return true}return false; }
function line(b,r,c,color,dr,dc){let n=1,open=0;for(const s of[-1,1]){let x=r+dr*s,y=c+dc*s;while(inb(x,y)&&b[x][y]===color){n++;x+=dr*s;y+=dc*s}if(inb(x,y)&&!b[x][y])open++}return{n,open};}
function pattern(n,open){if(n>=WIN)return 1e7;if(n===WIN-1)return open===2?9e5:4.5e5;if(n===WIN-2)return open===2?1.1e5:2.6e4;if(n===WIN-3)return open===2?9500:1800;if(n===2)return open===2?900:190;return open===2?50:10;}
function pointScore(b,r,c,color){if(b[r][c])return-Infinity;b[r][c]=color;let total=0,strong=0;for(const[d,e]of DIRS){const q=line(b,r,c,color,d,e);total+=pattern(q.n,q.open);if(q.n===WIN-2&&q.open===2)strong++}b[r][c]=0;if(strong>=2)total+=WIN===5?110000:65000;return total;}
function candidatePool(b,color,limit=CANDIDATES){const set=new Set(),mid=(N-1)>>1;let stones=0;for(let r=0;r<N;r++)for(let c=0;c<N;c++)if(b[r][c]){stones++;for(let dr=-2;dr<=2;dr++)for(let dc=-2;dc<=2;dc++){const x=r+dr,y=c+dc;if(inb(x,y)&&!b[x][y])set.add(x*N+y)}}if(!stones)return[{r:mid,c:mid,attack:0,defend:0}];return[...set].map(v=>{const r=Math.floor(v/N),c=v%N;return{r,c,attack:pointScore(b,r,c,color),defend:pointScore(b,r,c,3-color)}}).sort((a,z)=>(z.attack+z.defend*1.3)-(a.attack+a.defend*1.3)).slice(0,limit);}
function stateFeatures(b,color,turn,stones){let own=0,opp=0,empty=0,center=0,ob=0,pb=0,mid=(N-1)/2;for(let r=0;r<N;r++)for(let c=0;c<N;c++){const v=b[r][c];if(!v)empty++;else if(v===color){own++;center+=1-(Math.abs(r-mid)+Math.abs(c-mid))/(N*1.25)}else opp++}for(const p of candidatePool(b,color,14)){ob=Math.max(ob,p.attack);pb=Math.max(pb,p.defend)}return[Math.tanh(Math.log10(ob+1)/5),Math.tanh(Math.log10(pb+1)/5),(own-opp)/(N*N),center/Math.max(1,own),empty/(N*N),turn===color?1:-1,stones/(WIN===6?2:1)];}
function moveFeatures(m){const mid=(N-1)/2,center=1-(Math.abs(m.r-mid)+Math.abs(m.c-mid))/(N*1.2);return[Math.tanh(Math.log10(Math.max(0,m.attack)+1)/5),Math.tanh(Math.log10(Math.max(0,m.defend)+1)/5),center,m.attack>=1e7?1:0,m.defend>=1e7?1:0];}
function value(model,f){const h=model.hiddenW.map((w,j)=>Math.tanh(w.reduce((s,x,i)=>s+x*f[i],model.hiddenB[j])));return Math.tanh(h.reduce((s,x,i)=>s+x*model.valueW[i],model.valueB));}
function policy(model,mf){return sigmoid(mf.reduce((s,x,i)=>s+x*model.policy[i],0));}
function choose(b,color,turn,stones,model,noise=0){const moves=candidatePool(b,color);let immediate=moves.find(m=>m.attack>=1e7);if(immediate)return{move:immediate,moves};immediate=moves.find(m=>m.defend>=1e7);if(immediate)return{move:immediate,moves};let best=moves[0],bestQ=-Infinity;for(const m of moves){b[m.r][m.c]=color;const nextStone=stones+1,quota=WIN===6?2:1,nextTurn=nextStone>=quota?3-turn:turn,nextStones=nextStone>=quota?0:nextStone;const f=stateFeatures(b,color,nextTurn,nextStones);let danger=0;for(const q of candidatePool(b,3-color,8))danger=Math.max(danger,q.attack);b[m.r][m.c]=0;const tactical=Math.tanh((Math.log10(Math.max(0,m.attack)+1)-Math.log10(danger+1))*.68);const q=tactical*.58+value(model,f)*.25+(policy(model,moveFeatures(m))-.5)*.24+randWeight(noise);if(q>bestQ){bestQ=q;best=m}}return{move:best,moves};}
function shouldSwap(b,model){const white=stateFeatures(b,2,1,0),black=stateFeatures(b,1,1,0);return value(model,white)-value(model,black)>.035;}
function play(blackModel,whiteModel,explore=.08,collect=true){const b=board(),samples=[];let turn=1,stones=0,winner=0,swapDone=false;for(let ply=0;ply<N*N;ply++){const model=turn===1?blackModel:whiteModel,{move,moves}=choose(b,turn,turn,stones,model,explore);if(!move)break;const sf=stateFeatures(b,turn,turn,stones),mf=moveFeatures(move),neg=moves.filter(x=>x!==move).slice(0,3).map(moveFeatures);if(collect)samples.push({f:sf,mf,neg,color:turn});b[move.r][move.c]=turn;if(win(b,move.r,move.c,turn)){winner=turn;break}stones++;const quota=WIN===6?2:1;if(stones>=quota){stones=0;if(!swapDone&&turn===1){swapDone=true;if(shouldSwap(b,whiteModel)){for(let r=0;r<N;r++)for(let c=0;c<N;c++)if(b[r][c]===1)b[r][c]=2;for(const s of samples)s.color=2;turn=1}else turn=2}else turn=3-turn}}return{winner,samples};}
function trainBatch(model,replay){for(let epoch=0;epoch<EPOCHS;epoch++){for(let n=0;n<replay.length;n++){const s=replay[Math.floor(Math.random()*replay.length)],target=s.winner===0?0:s.winner===s.color?1:-1,h=model.hiddenW.map((w,j)=>Math.tanh(w.reduce((z,x,i)=>z+x*s.f[i],model.hiddenB[j]))),pred=Math.tanh(h.reduce((z,x,i)=>z+x*model.valueW[i],model.valueB)),delta=(target-pred)*(1-pred*pred),old=model.valueW.slice();for(let j=0;j<model.hiddenW.length;j++){model.valueW[j]+=LR*delta*h[j];const dh=delta*old[j]*(1-h[j]*h[j]);model.hiddenB[j]+=LR*dh;for(let i=0;i<7;i++)model.hiddenW[j][i]+=LR*dh*s.f[i]}model.valueB+=LR*delta;const pt=target>0?.92:target<0?.12:.5,pp=policy(model,s.mf),pe=pt-pp;for(let i=0;i<5;i++)model.policy[i]+=LR*.35*pe*s.mf[i];for(const neg of s.neg||[]){const np=policy(model,neg),nt=target>0?.18:.5;for(let i=0;i<5;i++)model.policy[i]+=LR*.12*(nt-np)*neg[i]}}}}
function arena(challenger,champion){let points=0,wins=0,losses=0,draws=0;for(let g=0;g<ARENA_GAMES;g++){const challengerBlack=g%2===0,res=play(challengerBlack?challenger:champion,challengerBlack?champion:challenger,0,false),challengerColor=challengerBlack?1:2;if(!res.winner){points+=.5;draws++}else if(res.winner===challengerColor){points++;wins++}else losses++;if((g+1)%10===0)process.stdout.write(`\r  arena ${g+1}/${ARENA_GAMES}`)}process.stdout.write('\n');return{score:points/ARENA_GAMES,wins,losses,draws};}

let saved=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{round:0,champion:loadSeed(),history:[]};
let champion=normalizeModel(saved.champion),replay=loadReplay();
const startRound=saved.round+1,endRound=saved.round+ROUNDS;
const runStarted=Date.now();
console.log(`\n============================================================`);
console.log(`[${clock()}] ${tag} adversarial training`);
console.log(`History completed : ${saved.round} rounds`);
console.log(`This run          : ${ROUNDS} rounds (total ${startRound} -> ${endRound})`);
console.log(`Replay / hidden   : ${replay.length} samples / ${HIDDEN} units`);
console.log(`============================================================`);
for(let round=startRound;round<=endRound;round++){
  const roundStarted=Date.now(),runRound=round-startRound+1;
  console.log(`\n------------------------------------------------------------`);
  console.log(`[${clock()}] ${tag} | run ${runRound}/${ROUNDS} | history round ${round}`);
  console.log(`Step 1/3: generating ${SELF_GAMES} adversarial games...`);
  const challenger=perturb(clone(champion)),newSamples=[];
  for(let g=0;g<SELF_GAMES;g++){const cb=g%2===0,res=play(cb?challenger:champion,cb?champion:challenger,.10,true);for(const s of res.samples)newSamples.push({...s,winner:res.winner});if((g+1)%10===0)process.stdout.write(`\r  self-play ${g+1}/${SELF_GAMES}, samples ${newSamples.length}`)}
  process.stdout.write('\n');replay.push(...newSamples);if(replay.length>REPLAY_LIMIT)replay=replay.slice(-REPLAY_LIMIT);console.log(`Step 2/3: training ${replay.length} replay samples x ${EPOCHS} epochs...`);trainBatch(challenger,replay);
  console.log(`Step 3/3: challenger vs champion, ${ARENA_GAMES} games...`);const result=arena(challenger,champion),promoted=result.score>=PROMOTE;if(promoted)champion=challenger;
  saved={version:1,size:N,win:WIN,round,champion,history:[...(saved.history||[]),{round,...result,promoted,date:new Date().toISOString()}]};fs.writeFileSync(stateFile,JSON.stringify(saved,null,2));saveReplay(replay);fs.writeFileSync(outputFile,JSON.stringify({version:3,training:'adversarial',games:round*SELF_GAMES,size:N,win:WIN,round,model:champion,arena:result},null,2));
  const elapsed=Date.now()-roundStarted,average=(Date.now()-runStarted)/runRound,eta=average*(ROUNDS-runRound);
  console.log(`Result: W${result.wins} L${result.losses} D${result.draws}, score ${(result.score*100).toFixed(1)}% -> ${promoted?'PROMOTED':'REJECTED'}`);
  console.log(`Saved history round ${round}. Round time ${duration(elapsed)}. Run progress ${runRound}/${ROUNDS}. ETA ${duration(eta)}.`);
}
// Always export the current champion, including when all requested rounds were already complete.
fs.writeFileSync(outputFile,JSON.stringify({version:3,training:'adversarial',games:saved.round*SELF_GAMES,size:N,win:WIN,round:saved.round,model:champion,arena:saved.history?.at(-1)||null},null,2));
console.log(`\n[${clock()}] Champion ready after ${saved.round} total rounds.`);
console.log(`This run used ${duration(Date.now()-runStarted)}. Output: ${outputFile}`);
