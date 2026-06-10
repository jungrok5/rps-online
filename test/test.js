'use strict';
/*
 * 의존성 없는 테스트 하니스 (Node 18+ 의 전역 fetch 사용).
 *   node test/test.js
 * 가위바위보 판정 로직 단위 테스트 + 실제 HTTP 통합 테스트를 함께 수행한다.
 */

const assert = require('assert');
const mod = require('../server.js');
const { server, createRoom, maybeResolveRound, randomName, uniqueRandomName } = mod;

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }
function section(t) { console.log('\n' + t); }

// 라운드 한 판을 만들고 판정한다. picks: { name: choice }
function playRound(mode, picks) {
  const room = createRoom('t', mode, 0); // roundSeconds=0(무제한) → 마감 인터벌 간섭 없음
  room.status = 'playing';
  room.round = 1;
  let i = 0;
  for (const [name, choice] of Object.entries(picks)) {
    const id = 'p' + (i++);
    room.players.push({ id, name, alive: true });
    room.choices[id] = choice;
  }
  maybeResolveRound(room);
  return room;
}
const aliveNames = (room) => room.players.filter((p) => p.alive).map((p) => p.name);
const lastEntry = (room) => room.history[room.history.length - 1];

// ---------------------------------------------------------------------------
// 1) 단위 테스트: 판정 로직
// ---------------------------------------------------------------------------
section('판정 로직 단위 테스트');

// 한 명이 이길 때까지(last-winner): 두 종류면 진 쪽 탈락
{
  const room = playRound('last-winner', { 가위맨: 'scissors', 바위맨: 'rock' });
  // 바위 > 가위 → 가위맨 탈락, 바위맨 1명 남아 우승
  assert.deepStrictEqual(lastEntry(room).eliminated, ['가위맨']);
  assert.strictEqual(room.status, 'finished');
  assert.strictEqual(room.winner, '바위맨');
}
ok('last-winner: 진 쪽 탈락 → 최후 1인 우승');

// 한 명이 질 때까지(last-loser): 이긴 쪽이 안전하게 통과(풀에서 제외), 진 쪽 잔류
{
  const room = playRound('last-loser', { 보맨: 'paper', 바위맨: 'rock', 바위맨2: 'rock' });
  // 보 > 바위 → 보맨이 이김(안전 통과/제외), 바위 둘은 잔류
  assert.deepStrictEqual(lastEntry(room).eliminated, ['보맨']);
  assert.deepStrictEqual(aliveNames(room).sort(), ['바위맨', '바위맨2']);
  assert.strictEqual(room.status, 'playing'); // 2명 남음 → 계속
}
ok('last-loser: 이긴 쪽 안전 통과, 진 쪽 잔류');

// 무승부: 모두 같은 선택
{
  const room = playRound('last-winner', { A: 'rock', B: 'rock' });
  assert.deepStrictEqual(lastEntry(room).eliminated, []);
  assert.match(lastEntry(room).note, /무승부/);
  assert.strictEqual(aliveNames(room).length, 2);
}
ok('무승부: 모두 같은 선택 → 탈락 없음, 재대결');

// 무승부: 세 종류 모두 등장
{
  const room = playRound('last-winner', { A: 'rock', B: 'paper', C: 'scissors' });
  assert.deepStrictEqual(lastEntry(room).eliminated, []);
  assert.match(lastEntry(room).note, /세 종류/);
}
ok('무승부: 세 종류 모두 등장 → 탈락 없음');

// 판정 전에는 1명 이하면 아무 일도 없어야 함
{
  const room = createRoom('t', 'last-winner', 0);
  room.status = 'playing';
  room.players.push({ id: 'solo', name: '혼자', alive: true });
  room.choices['solo'] = 'rock';
  maybeResolveRound(room);
  assert.strictEqual(room.history.length, 0, '2명 미만이면 판정하지 않음');
}
ok('판정 가드: 생존 2명 미만이면 판정 안 함');

section('랜덤 닉네임 단위 테스트');
{
  const n = randomName();
  assert.ok(/\S+\s\S+/.test(n), '형용사 + 동물 형태');
  assert.ok(!/\d/.test(n), '숫자 없음');
  // uniqueRandomName: 방에 이미 있는 이름은 피한다
  const room = createRoom('t', 'last-winner', 0);
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const nm = uniqueRandomName(room);
    assert.ok(!seen.has(nm), '겹치지 않는 닉네임');
    assert.ok(!/\d$/.test(nm), '자동 닉네임엔 숫자 접미사 없음');
    seen.add(nm);
    room.players.push({ id: 'x' + i, name: nm, alive: true });
  }
}
ok('randomName/uniqueRandomName: 형식·고유성·숫자 미부착');

// ---------------------------------------------------------------------------
// 2) 통합 테스트 (실제 HTTP)
// ---------------------------------------------------------------------------
async function http(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function integration() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  section(`통합 테스트 (포트 ${port})`);

  // 방 생성
  let r = await http(base, 'POST', '/api/rooms', { title: '점심내기', mode: 'last-winner', roundSeconds: 0 });
  assert.strictEqual(r.status, 200); assert.ok(r.data.roomId && r.data.hostToken);
  const room = r.data.roomId, host = r.data.hostToken;
  ok('방 생성 → roomId/hostToken 반환');

  // 잘못된 mode/roundSeconds 는 기본값으로 보정
  let bad = await http(base, 'POST', '/api/rooms', { mode: 'haxx', roundSeconds: '999' });
  let bg = await http(base, 'GET', `/api/rooms/${bad.data.roomId}`);
  assert.strictEqual(bg.data.mode, 'last-winner', '알 수 없는 mode → 기본값');
  assert.strictEqual(bg.data.roundSeconds, 10, '허용 안 된 시간 → 기본 10초');
  ok('입력 검증: mode/roundSeconds 보정');

  // 선택 내용은 절대 노출 안 됨
  r = await http(base, 'GET', `/api/rooms/${room}`);
  assert.strictEqual(r.data.status, 'lobby');
  assert.strictEqual(r.data.choices, undefined, '현재 선택 내용(choices)은 상태에 없음');
  ok('비밀 유지: publicState 에 choices 미포함');

  // join + 이름 중복 방지
  let a = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수' });
  let b = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '철수' });
  assert.strictEqual(a.data.name, '철수');
  assert.strictEqual(b.data.name, '철수2', '중복 이름 → 접미사');
  ok('join: 이름 중복 시 접미사');

  // 이름 없이 join → 랜덤 닉네임(숫자 없음)
  let anon = await http(base, 'POST', `/api/rooms/${room}/join`, {});
  assert.ok(anon.data.name && !/^참가자/.test(anon.data.name) && !/\d$/.test(anon.data.name), '랜덤 닉네임 부여');
  ok('join: 이름 미입력 시 랜덤 닉네임');

  // 방장 아님 → start 거부
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: 'nope' });
  assert.strictEqual(r.status, 403);
  ok('start: 잘못된 토큰 거부(403)');

  // start
  r = await http(base, 'POST', `/api/rooms/${room}/start`, { hostToken: host });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, 'playing'); assert.strictEqual(r.data.round, 1);
  ok('start: playing 전이, 라운드 1');

  // 시작 후 join 거부(관전)
  r = await http(base, 'POST', `/api/rooms/${room}/join`, { name: '지각' });
  assert.strictEqual(r.status, 409);
  ok('start 후 join 거부(409)');

  // 잘못된 선택 → 400
  r = await http(base, 'POST', `/api/rooms/${room}/play`, { playerId: a.data.playerId, choice: 'banana', round: 1 });
  assert.strictEqual(r.status, 400);
  ok('play: 잘못된 선택 거부(400)');

  // 라운드 경합 가드 → 409
  r = await http(base, 'POST', `/api/rooms/${room}/play`, { playerId: a.data.playerId, choice: 'rock', round: 99 });
  assert.strictEqual(r.status, 409);
  ok('play: 라운드 불일치 거부(409)');

  // === 라운드 판정: 2명만 두고 깔끔히 결판 ===
  let r2 = await http(base, 'POST', '/api/rooms', { mode: 'last-winner', roundSeconds: 0 });
  const room2 = r2.data.roomId, host2 = r2.data.hostToken;
  let pa = await http(base, 'POST', `/api/rooms/${room2}/join`, { name: '바위맨' });
  let pb = await http(base, 'POST', `/api/rooms/${room2}/join`, { name: '가위맨' });
  await http(base, 'POST', `/api/rooms/${room2}/start`, { hostToken: host2 });
  await http(base, 'POST', `/api/rooms/${room2}/play`, { playerId: pa.data.playerId, choice: 'rock', round: 1 });
  r = await http(base, 'POST', `/api/rooms/${room2}/play`, { playerId: pb.data.playerId, choice: 'scissors', round: 1 });
  assert.strictEqual(r.data.status, 'finished');
  assert.strictEqual(r.data.winner, '바위맨', '바위 > 가위 → 바위맨 우승');
  assert.strictEqual(r.data.history.length, 1);
  ok('play: 전원 제출 시 판정 → 우승자 확정');

  // reset
  r = await http(base, 'POST', `/api/rooms/${room2}/reset`, { hostToken: host2 });
  assert.strictEqual(r.data.status, 'lobby');
  assert.ok(r.data.players.every((p) => p.alive), 'reset 시 전원 생존 복귀');
  ok('reset: lobby 복귀');

  // 최소 인원 미달 start
  let r3 = await http(base, 'POST', '/api/rooms', { roundSeconds: 0 });
  await http(base, 'POST', `/api/rooms/${r3.data.roomId}/join`, { name: 'solo' });
  r = await http(base, 'POST', `/api/rooms/${r3.data.roomId}/start`, { hostToken: r3.data.hostToken });
  assert.strictEqual(r.status, 400);
  ok('start: 2명 미만 거부(400)');

  // === 이상 입력 방어: 엉뚱한 타입/구조에도 500/크래시 없이 안전 처리 ===
  let w = await http(base, 'POST', '/api/rooms', { title: 12345, mode: { x: 1 }, roundSeconds: 'abc' });
  assert.strictEqual(w.status, 200, '비정상 타입 입력도 기본값으로 방 생성');
  let wg = await http(base, 'GET', `/api/rooms/${w.data.roomId}`);
  assert.strictEqual(typeof wg.data.title, 'string', 'title 은 항상 문자열');
  assert.strictEqual(wg.data.mode, 'last-winner', '잘못된 mode → 기본값');
  let wj = await http(base, 'POST', `/api/rooms/${w.data.roomId}/join`, { name: 99999 });
  assert.strictEqual(typeof wj.data.name, 'string', '이름은 항상 문자열로 강제');
  let wp = await http(base, 'POST', `/api/rooms/${w.data.roomId}/play`, { playerId: { a: 1 }, choice: ['rock'] });
  assert.ok([400, 403, 409].includes(wp.status), '비정상 play 거부(크래시 없음)');
  ok('이상 입력 방어: 비정상 타입에도 500/크래시 없음');

  // 디렉터리 트래버설 가드
  let t1 = await fetch(base + '/../server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(t1, 200);
  let t2 = await fetch(base + '/%2e%2e/server.js').then((x) => x.status).catch(() => 'err');
  assert.notStrictEqual(t2, 200);
  ok('정적 트래버설 가드 (../server.js 비노출)');

  // 없는 방
  r = await http(base, 'GET', '/api/rooms/zzzzzz');
  assert.strictEqual(r.status, 404);
  ok('없는 방 → 404');

  await new Promise((r) => server.close(r));
}

integration().then(() => {
  console.log(`\n✅ 모든 테스트 통과 (${passed}개)\n`);
  process.exit(0);
}).catch((e) => {
  console.error('\n❌ 테스트 실패:', e && e.message);
  console.error(e);
  process.exit(1);
});
