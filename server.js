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
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 5000;     // 메모리 보호: 동시 보관 방 수 상한
const MAX_PLAYERS = 50;     // 방당 인원 상한

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
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)]; // 예측 불가(암호학적)
  return out;
}

function token() {
  return randomId(16);
}

// 이름 없이 참여할 때 붙여줄 랜덤 닉네임 (형용사 + 동물)
const NAME_ADJ = ['날쌘', '용감한', '귀여운', '빛나는', '행복한', '멋진', '엉뚱한', '느긋한', '씩씩한', '잽싼', '든든한', '통큰', '명랑한', '슬기로운', '폭신한', '겁없는'];
const NAME_NOUN = ['호랑이', '토끼', '판다', '여우', '너구리', '다람쥐', '펭귄', '고양이', '강아지', '사자', '곰', '부엉이', '수달', '햄스터', '코알라', '문어'];
function randomName() {
  return `${NAME_ADJ[crypto.randomInt(NAME_ADJ.length)]} ${NAME_NOUN[crypto.randomInt(NAME_NOUN.length)]}`;
}
// 방에 아직 없는 랜덤 닉네임을 고른다(자동 부여용 → 숫자 접미사 없이 깔끔하게).
function uniqueRandomName(room) {
  for (let i = 0; i < 50; i++) {
    const n = randomName();
    if (!room.players.some((p) => p.name === n)) return n;
  }
  // 조합이 동난 극단적 경우에만 숫자 폴백
  const base = randomName();
  let n = 2, name = base;
  while (room.players.some((p) => p.name === name)) name = `${base}${n++}`;
  return name;
}

const MODES = ['last-winner', 'last-loser'];
const ALLOWED_SECONDS = [0, 5, 10, 15, 20, 30]; // 0 = 무제한
const REVEAL_GRACE_MS = 5200; // 결과 공개 연출(룰렛+확정)이 도는 동안 다음 라운드 시간을 깎지 않도록 여유

function createRoom(title, mode, roundSeconds) {
  let id;
  do { id = randomId(6); } while (rooms[id]);
  // 숫자로 명시된 허용값만 인정. null/""/undefined 등은 기본 10초 (0='무제한'과 구분)
  const secs = (typeof roundSeconds === 'number' && ALLOWED_SECONDS.includes(roundSeconds)) ? roundSeconds : 10;
  const room = {
    id,
    title: String(title || '가위바위보 서바이벌').slice(0, 40),
    mode: MODES.includes(mode) ? mode : 'last-winner',
    roundSeconds: secs,
    roundDeadline: null,
    autoPicked: [],
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

/** 현재 라운드의 마감시간을 설정한다. grace=true 면 결과 공개 연출 시간만큼 여유를 더한다. */
function setRoundDeadline(room, grace) {
  room.roundDeadline = room.roundSeconds > 0
    ? Date.now() + room.roundSeconds * 1000 + (grace ? REVEAL_GRACE_MS : 0)
    : null;
}

/** 마감시간이 지났으면 미제출 생존자에게 랜덤 선택을 채워 넣고 라운드를 판정한다. */
function enforceDeadline(room) {
  if (room.status !== 'playing' || !room.roundDeadline) return;
  if (Date.now() < room.roundDeadline) return;
  for (const p of alivePlayers(room)) {
    if (!room.choices[p.id]) {
      room.choices[p.id] = CHOICES[Math.floor(Math.random() * 3)];
      room.autoPicked.push(p.name);
    }
  }
  maybeResolveRound(room);
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
    if (room.mode === 'last-loser') {
      // 한 명이 질 때까지: 이긴 쪽이 빠지고(안전), 진 쪽이 계속 남는다
      for (const p of alive) {
        if (room.choices[p.id] === winningType) {
          p.alive = false; // 안전하게 통과 → 풀에서 제외
          eliminated.push(p.name);
        }
      }
      note = `${labelKo(winningType)} 통과(안전) → ${labelKo(losingType)} 잔류`;
    } else {
      // 한 명이 이길 때까지: 진 쪽 탈락, 이긴 사람끼리 올라감
      for (const p of alive) {
        if (room.choices[p.id] === losingType) {
          p.alive = false;
          eliminated.push(p.name);
        }
      }
      note = `${labelKo(winningType)} 승 → ${labelKo(losingType)} 탈락`;
    }
  } else {
    // 한 종류뿐이거나 세 종류 모두 → 무승부, 같은 인원으로 재대결
    note = distinct.length === 1 ? '모두 같은 선택, 무승부 → 재대결' : '세 종류 모두 등장, 무승부 → 재대결';
  }

  const auto = [...new Set(room.autoPicked)];
  room.history.push({ round: room.round, picks, eliminated, note, auto });
  room.choices = Object.create(null);
  room.autoPicked = [];

  const remaining = alivePlayers(room);
  if (remaining.length === 1) {
    room.status = 'finished';
    room.winner = remaining[0].name;
    room.roundDeadline = null;
  } else {
    room.round += 1;
    setRoundDeadline(room, true); // 다음 라운드: 연출 시간만큼 여유 부여
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
    mode: room.mode,
    roundSeconds: room.roundSeconds,
    roundEndsIn: (room.status === 'playing' && room.roundDeadline)
      ? Math.max(0, room.roundDeadline - Date.now()) : null,
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
  if (res.writableEnded || res.destroyed) return; // 끊긴 연결엔 쓰지 않음(중복/에러 방지)
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { data = ''; req.destroy(); finish({}); } // 과대 페이로드 차단 + 대기 종료
    });
    req.on('end', () => { try { finish(data ? JSON.parse(data) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));   // 끊김/오류 시에도 핸들러가 멈추지 않도록
    req.on('close', () => finish({}));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const GZIP_TYPES = new Set(['.html', '.css', '.js', '.svg', '.json', '.gltf', '.txt']);

function serveFile(res, filePath, req) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    // 라이브러리/에셋(/vendor, /assets)은 불변 → 장기 캐시. 그 외(HTML/CSS)는 항상 최신.
    const immutable = /[\\/](vendor|assets)[\\/]/.test(filePath);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate',
    };
    const acceptsGzip = req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && GZIP_TYPES.has(ext)) {
      zlib.gzip(buf, (gzErr, gz) => {
        if (gzErr) { res.writeHead(200, headers); res.end(buf); return; }
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(gz);
      });
      return;
    }
    res.writeHead(200, headers);
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
        if (Object.keys(rooms).length >= MAX_ROOMS) {
          return sendJson(res, 503, { error: '지금 방이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
        }
        const room = createRoom(body.title, body.mode, body.roundSeconds);
        return sendJson(res, 200, { roomId: room.id, hostToken: room.hostToken });
      }

      const m = pathname.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/);
      if (m) {
        const room = rooms[m[1]];
        if (!room) return sendJson(res, 404, { error: '방을 찾을 수 없어요 (만료되었을 수 있어요).' });
        const action = m[2];

        if (!action && req.method === 'GET') {
          enforceDeadline(room);
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/join' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'lobby') return sendJson(res, 409, { error: '이미 게임이 시작되어 참가할 수 없어요. 관전만 가능합니다.' });
          if (room.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: '정원이 가득 찼어요.' });
          let name = String(body.name || '').trim().slice(0, 20);
          if (!name) {
            name = uniqueRandomName(room); // 미입력 → 겹치지 않는 랜덤 닉네임(숫자 없음)
          } else if (room.players.some((p) => p.name === name)) {
            // 직접 입력한 이름이 겹칠 때만 숫자 접미사 (라운드 기록 키 충돌 방지)
            let n = 2;
            while (room.players.some((p) => p.name === `${name}${n}`)) n++;
            name = `${name}${n}`;
          }
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
          room.autoPicked = [];
          room.history = [];
          room.winner = null;
          setRoundDeadline(room, false);
          return sendJson(res, 200, publicState(room));
        }

        if (action === '/play' && req.method === 'POST') {
          const body = await readBody(req);
          if (room.status !== 'playing') return sendJson(res, 409, { error: '지금은 선택할 수 없어요.' });
          const player = room.players.find((p) => p.id === body.playerId);
          if (!player) return sendJson(res, 403, { error: '참가자 정보를 찾을 수 없어요.' });
          if (!player.alive) return sendJson(res, 409, { error: '이미 탈락했어요. 관전 중입니다.' });
          if (!CHOICES.includes(body.choice)) return sendJson(res, 400, { error: '잘못된 선택이에요.' });
          // 라운드 경합 방지: 클라가 보고 있던 라운드와 현재 라운드가 다르면 거부
          // (마감 스윕이 라운드를 넘긴 직후 도착한 선택이 다음 라운드에 잘못 적용되는 것 차단)
          if (typeof body.round === 'number' && body.round !== room.round) {
            return sendJson(res, 409, { error: '이미 라운드가 종료됐어요. 다음 라운드를 기다려 주세요.' });
          }
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
          room.autoPicked = [];
          room.roundDeadline = null;
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
  if (pathname === '/' ) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req);
  if (pathname === '/privacy') return serveFile(res, path.join(PUBLIC_DIR, 'privacy.html'), req);
  if (/^\/r\/[a-z0-9]+$/.test(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'room.html'), req);

  // 정적 자산 (디렉터리 탈출 방지): 인코딩 해제 후 정규화하고, PUBLIC_DIR 하위인지 엄격 확인
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return serveFile(res, filePath, req); // 파일이 없으면 serveFile 이 404 처리
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
});

// 라운드 마감시간 강제 (1초마다) — 폴링하는 사람이 없어도 게임이 진행되도록
setInterval(() => {
  for (const id of Object.keys(rooms)) enforceDeadline(rooms[id]);
}, 1000).unref();

// 오래된 방 정리 (12시간 지난 방 제거) — 메모리 누수 방지
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const id of Object.keys(rooms)) {
    if (rooms[id].createdAt < cutoff) delete rooms[id];
  }
}, 60 * 60 * 1000).unref();

// 테스트에서 로직을 직접 부르기 위해 export (require 시), 직접 실행 시 서버 listen
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`✊✋✌️  가위바위보 서버 실행 중: http://localhost:${PORT}`);
  });
} else {
  module.exports = {
    server, createRoom, maybeResolveRound, alivePlayers,
    randomName, uniqueRandomName, BEATS, CHOICES, MODES, ALLOWED_SECONDS,
  };
}

