'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const rooms = new Map();
const API_VERSION = 3;
const quota = type => type === 'gomoku' ? 1 : 2;
const winCount = type => type === 'gomoku' ? 5 : 6;
const sizeFor = type => type === 'gomoku' ? 13 : 19;
const emptyBoard = n => Array.from({length:n}, () => Array(n).fill(0));
const makeToken = () => crypto.randomBytes(18).toString('hex');
const makeCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  do { value = Array.from({length:6}, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (rooms.has(value));
  return value;
};

function publicRoom(room) {
  const clean = JSON.parse(JSON.stringify(room));
  const now=Date.now();
  if (clean.players.black) { clean.players.black.online=now-room.players.black.lastSeen<12000; delete clean.players.black.token; delete clean.players.black.lastSeen; }
  if (clean.players.white) { clean.players.white.online=now-room.players.white.lastSeen<12000; delete clean.players.white.token; delete clean.players.white.lastSeen; }
  delete clean.snapshots;
  return clean;
}
function colorOf(room, token) {
  if (!token) return 0;
  return room.players.black?.token === token ? 1 : room.players.white?.token === token ? 2 : 0;
}
function winnerAt(board, r, c, color, count) {
  for (const [dr, dc] of [[1,0],[0,1],[1,1],[1,-1]]) {
    let total = 1;
    for (const sign of [-1, 1]) {
      let x=r+dr*sign, y=c+dc*sign;
      while (x>=0 && y>=0 && x<board.length && y<board.length && board[x][y]===color) { total++; x+=dr*sign; y+=dc*sign; }
    }
    if (total >= count) return true;
  }
  return false;
}
function ok(extra={}) { return {ok:true, apiVersion:API_VERSION, ...extra}; }
function fail(message) { return {ok:false, apiVersion:API_VERSION, message}; }

function handleRoom(event) {
  const action = event.action;
  if (action === 'create') {
    const gameType = event.gameType === 'gomoku' ? 'gomoku' : 'connect6';
    const size = sizeFor(gameType), token = makeToken(), code = makeCode();
    const now=Date.now();
    const room = {code,gameType,size,winCount:winCount(gameType),board:emptyBoard(size),history:[],players:{black:{name:String(event.name||'房主').slice(0,12),token,lastSeen:now},white:null},current:1,stonesThisTurn:0,turnQuota:quota(gameType),turnId:0,hintTurns:{black:-1,white:-1},swapPending:false,swapUsed:false,status:'waiting',winner:null,request:null,snapshots:[],version:1,updatedAt:now};
    rooms.set(code, room);
    return ok({token,color:1,room:publicRoom(room)});
  }
  const code = String(event.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return fail('房间不存在或已过期');
  if (action === 'join') {
    let token=event.token, color=colorOf(room,token);
    if (!color) {
      if (room.players.white) return fail('房间已满');
      const now=Date.now();token=makeToken(); color=2; room.players.white={name:String(event.name||'玩家二').slice(0,12),token,lastSeen:now};room.players.black.lastSeen=now;room.status='playing'; room.version++; room.updatedAt=now;
    }
    room.players[color===1?'black':'white'].lastSeen=Date.now();
    return ok({token,color,room:publicRoom(room)});
  }
  if (action === 'state') { const color=colorOf(room,event.token); if(color) room.players[color===1?'black':'white'].lastSeen=Date.now(); return ok({room:publicRoom(room)}); }
  const color = colorOf(room,event.token);
  if (!color) return fail('你不是该房间的玩家');
  room.players[color===1?'black':'white'].lastSeen=Date.now();
  if (action === 'request') {
    if (!room.players.white) return fail('对手尚未加入');
    const opponent=room.players[color===1?'white':'black'];
    if(Date.now()-opponent.lastSeen>=12000)return fail('对手当前已掉线，无法发送申请');
    if (room.request?.status==='pending'&&Date.now()-room.request.createdAt<30000) return fail('已有申请正在等待处理');
    const type=['hint','undo','restart'].includes(event.type)?event.type:null;
    if(!type)return fail('申请类型无效');
    if(type==='undo'&&!room.history.length)return fail('当前没有可以撤回的棋步');
    if(type==='hint'&&room.hintTurns[color===1?'black':'white']===room.turnId)return fail('本回合已经使用过 AI 支招');
    room.request={id:crypto.randomBytes(8).toString('hex'),type,fromColor:color,status:'pending',createdAt:Date.now()}; room.version++;
    return ok({room:publicRoom(room)});
  }
  if (action === 'respond') {
    const request=room.request;
    if(!request||request.status!=='pending'||request.fromColor===color||Date.now()-request.createdAt>=30000)return fail('申请已经失效');
    request.status=event.accept?'accepted':'rejected'; request.respondedAt=Date.now();
    if(event.accept&&request.type==='restart') resetRoom(room);
    if(event.accept&&request.type==='undo') restoreSnapshot(room);
    if(event.accept&&request.type==='hint')room.hintTurns[request.fromColor===1?'black':'white']=room.turnId;
    room.version++; room.updatedAt=Date.now(); return ok({room:publicRoom(room)});
  }
  if (action === 'move') {
    if (room.status !== 'playing') return fail('正在等待另一位玩家');
    if (room.swapPending) return fail('请先完成换边选择');
    if (color !== room.current) return fail('还没轮到你');
    const r=Number(event.r), c=Number(event.c);
    if (!Number.isInteger(r)||!Number.isInteger(c)||r<0||c<0||r>=room.size||c>=room.size) return fail('落点无效');
    if (room.board[r][c]) return fail('该位置已有棋子');
    room.snapshots.push(snapshot(room)); if(room.snapshots.length>80)room.snapshots.shift();
    room.board[r][c]=color; room.history.push({r,c,color,turnEnd:false}); room.stonesThisTurn++;
    if (winnerAt(room.board,r,c,color,room.winCount)) { room.status='finished'; room.winner=color; room.history.at(-1).turnEnd=true; }
    else if (room.history.length===room.size*room.size) { room.status='finished'; room.winner=0; }
    else if (color===1&&!room.swapUsed&&room.stonesThisTurn===room.turnQuota) { room.swapPending=true; room.history.at(-1).turnEnd=true; }
    else if (room.stonesThisTurn===room.turnQuota) { room.history.at(-1).turnEnd=true; room.current=3-room.current; room.stonesThisTurn=0; room.turnQuota=quota(room.gameType); room.turnId++; }
    room.version++; room.updatedAt=Date.now(); return ok({room:publicRoom(room)});
  }
  if (action === 'swap') {
    if (!room.swapPending || color!==2) return fail('当前不能换边');
    room.snapshots.push(snapshot(room)); room.swapPending=false; room.swapUsed=true;
    if (event.doSwap) { room.history.forEach(m => {room.board[m.r][m.c]=2; m.color=2;}); room.current=1; } else room.current=2; room.turnId++;
    room.stonesThisTurn=0; room.turnQuota=quota(room.gameType); room.version++; room.updatedAt=Date.now(); return ok({room:publicRoom(room)});
  }
  return fail('未知操作');
}

function snapshot(room){return JSON.stringify({board:room.board,history:room.history,current:room.current,stonesThisTurn:room.stonesThisTurn,turnQuota:room.turnQuota,turnId:room.turnId,hintTurns:room.hintTurns,swapPending:room.swapPending,swapUsed:room.swapUsed,status:room.status,winner:room.winner});}
function restoreSnapshot(room){const raw=room.snapshots.pop();if(!raw)return;Object.assign(room,JSON.parse(raw));}
function resetRoom(room){room.board=emptyBoard(room.size);room.history=[];room.current=1;room.stonesThisTurn=0;room.turnQuota=quota(room.gameType);room.turnId=0;room.hintTurns={black:-1,white:-1};room.swapPending=false;room.swapUsed=false;room.status='playing';room.winner=null;room.snapshots=[];}

function send(res,status,body,type='application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body);
}
const server = http.createServer((req,res) => {
  if (req.method==='POST' && req.url==='/api/room') {
    let body=''; req.on('data', chunk => { body+=chunk; if(body.length>20000) req.destroy(); });
    req.on('end', () => { try { const result=handleRoom(JSON.parse(body||'{}')); send(res,result.ok?200:400,JSON.stringify(result)); } catch(e) { console.error(e); send(res,500,JSON.stringify(fail('服务器暂时不可用'))); } });
    return;
  }
  if (req.method!=='GET' && req.method!=='HEAD') return send(res,405,'Method Not Allowed','text/plain; charset=utf-8');
  const pathname = decodeURIComponent((req.url||'/').split('?')[0]);
  const requested = pathname==='/' ? 'six_go.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res,404,'Not Found','text/plain; charset=utf-8');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
  if(req.method==='HEAD') return res.end(); fs.createReadStream(file).pipe(res);
});

setInterval(() => { const expiry=Date.now()-24*60*60*1000; for(const [code,room] of rooms) if(room.updatedAt<expiry) rooms.delete(code); }, 60*60*1000).unref();
if (require.main === module) server.listen(PORT,HOST,() => console.log(`\n六子棋服务器已启动：http://localhost:${PORT}\n保持此窗口开启。局域网玩家也可使用本机局域网 IP:${PORT}\n`));
module.exports = {handleRoom, server};
