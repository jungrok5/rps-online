'use strict';

/*
 * 아주 심플한 온라인 가위바위보 (서바이벌 방식)
 *
 * - 데이터베이스 없음: 모든 방 상태는 서버 메모리(rooms 객체)에 저장됩니다.
 *   서버를 재시작하면 진행 중이던 게임 기록은 사라집니다(잠깐 즐기는 용도).
 * - 의존성 없음: Node 내장 http 모듈만 사용. `node server.js` 로 바로 실행됩니다.
 * - 실시간 갱신은 WebSocket 대신 클라이언트 폴링으로 처리합니다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/** @type {Record<string, Room>} 메모리 저장소 */
const rooms = Object.create(null);

// ---------------------------------------------------------------------------
// 게임 로직
// ---------------------------------------------------------------------------

const CHOICES = ['rock', 'paper', 'scissors'];
// beats[a] === b 이면 a 가 b 를 이긴다.
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

function randomId(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 헷갈리는 0,O,1,l 제외
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function token() {
  return randomId(16);
}

function createRoom(title) {
  let id;
  do { id = randomId(6); } while (rooms[id]);
  const room = {
    id,
    title: (title || '가위바위보 서바이벌').slice(0, 40),
    hostToken: token(),
    status: 'lobby', // 'lobby' | 'playing' | 'finished'
    createdAt: Date.now(),
    players: [], // { id, name, alive }
    round: 0,
    choices: Object.create(null), // 현재 라운드: playerId -> choice (판정 전까지 비공개)
    history: [], // { round, picks: {name->choice}, eliminated: [names], note }
    winner: null, // 우승자 이름
  };
  rooms[id] = room;
  return room;
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

/** 현재 라운드의 모든 생존자가 선택을 제출했으면 판정한다. */
function maybeResolveRound(room) {
  const alive = alivePlayers(room);
  if (alive.length < 2) return;
  const allSubmitted = alive.every((p) => room.choices[p.id]);
  if (!allSubmitted) return;

  const distinct = [...new Set(alive.map((p) => room.choices[p.id]))];
  const picks = {};
  for (const p of alive) picks[p.name] = room.choices[p.id];

  let eliminated = [];
  let note = '';

  if (distinct.length === 2) {
    const [a, b] = distinct;
    const winningType = BEATS[a] === b ? a : b; // a가 b를 이기면 a, 아니면 b
    const losingType = winningType === a ? b : a;
    for (const p of alive) {
      if (room.choices[p.id] === losingType) {
        p.alive = false;
        eliminated.push(p.name);
      }
    }
    note = `${labelKo(winningType)} 승 → ${labelKo(losingType)} 탈락`;
  } else {
    // 한 종류뿐이거나 세 종류 모두 → 무승부, 같은 인원으로 재대결
    note = distinct.length === 1 ? '모두 같은 선택, 무승부 → 재대결' : '세 종류 모두 등장, 무승부 → 재대결';
  }

  room.history.push({ round: room.round, picks, eliminated, note });
  room.choices = Object.create(null);

  const remaining = alivePlayers(room);
  if (remaining.length === 1) {
    room.status = 'finished';
    room.winner = remaining[0].name;
  } else {
    room.round += 1;
  }
}

function labelKo(choice) {
  return { rock: '바위', paper: '보', scissors: '가위' }[choice] || choice;
}

/** 클라이언트에 보낼 상태 (현재 라운드 선택 내용은 숨김) */
function publicState(room) {
  return {
    id: room.id,
    title: room.title,
    status: room.status,
    round: room.round,
    players: room.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive })),
    aliveCount: alivePlayers(room).length,
    submitted: Object.keys(room.choices), // 누가 제출했는지(아이디만), 무엇을 냈는지는 비공개
    history: room.history,
    winner: room.winner,
  };
}

// ---------------------------------------------------------------------------
// HTTP 유틸
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // --- API ---
  if (pathname.startsWith('/api/')) {
    try {
      // 방 생성
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readBody(req);
        const room = createRoom(body.title);
        return sendJson(res, 200, { roomId: room.id, hostToken: room.hostToken });
      }

      const m = pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/i);
      if (m) {
        const room = rooms[m[1]];
        if (!room) return sendJson(res, 404, { error: '방을 찾을 수 없어요 (만료되었을 수 있어요).' });
        const action = m[2];

        if (!action && req.method === 'GET') {
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/join' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'lobby') return sendJson(res, 409, { error: '이미 게임이 시작되어 참가할 수 없어요. 관전만 가능합니다.' });
          const name = (body.name || '').trim().slice(0, 20) || `참가자${room.players.length + 1}`;
          const player = { id: token(), name, alive: true };
          room.players.push(player);
          return sendJson(res, 200, { playerId: player.id, name: player.name });
        }

        if (action === '/start' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 시작할 수 있어요.' });
          if (room.players.length < 2) return sendJson(res, 400, { error: '최소 2명 이상이어야 시작할 수 있어요.' });
          room.players.forEach((p) => { p.alive = true; });
          room.status = 'playing';
          room.round = 1;
          room.choices = Object.create(null);
          room.history = [];
          room.winner = null;
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/play' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'playing') return sendJson(res, 409, { error: '지금은 선택할 수 없어요.' });
          const player = room.players.find((p) => p.id === body.playerId);
          if (!player) return sendJson(res, 403, { error: '참가자 정보를 찾을 수 없어요.' });
          if (!player.alive) return sendJson(res, 409, { error: '이미 탈락했어요. 관전 중입니다.' });
          if (!CHOICES.includes(body.choice)) return sendJson(res, 400, { error: '잘못된 선택이에요.' });
          room.choices[player.id] = body.choice;
          maybeResolveRound(room);
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/reset' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.hostToken !== room.hostToken) return sendJson(res, 403, { error: '방장만 다시 시작할 수 있어요.' });
          room.status = 'lobby';
          room.round = 0;
          room.choices = Object.create(null);
          room.history = [];
          room.winner = null;
          room.players.forEach((p) => { p.alive = true; });
          return sendJson(res, 200, publicState(room));
        }
      }

      return sendJson(res, 404, { error: 'Unknown API' });
    } catch (e) {
      return sendJson(res, 500, { error: '서버 오류' });
    }
  }

  // --- 정적 페이지 ---
  if (pathname === '/' ) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (pathname.match(/^\/r\/[a-z0-9]+$/i)) return serveFile(res, path.join(PUBLIC_DIR, 'room.html'));

  // 정적 자산 (디렉터리 탈출 방지)
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveFile(res, filePath);
  }

  res.writeHead(404); res.end('Not found');
});

// 오래된 방 정리 (12시간 지난 방 제거) — 메모리 누수 방지
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const id of Object.keys(rooms)) {
    if (rooms[id].createdAt < cutoff) delete rooms[id];
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`✊✋✌️  가위바위보 서버 실행 중: http://localhost:${PORT}`);
});
