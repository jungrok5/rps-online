// Playwright 헤드리스 스모크: 3D 무대 콘솔 에러 0 확인 + 스크린샷 캡처.
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/smoke.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync('docs', { recursive: true });

const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
await sleep(800);

const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 760 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  return page;
}
async function api(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

try {
  // 호스트: 생성 페이지에서 무제한 시간으로 방 만들기(테스트가 라운드 진행을 직접 제어)
  const host = await newPage('host');
  await host.goto(BASE + '/', { waitUntil: 'networkidle' });
  await host.fill('#title', '점심내기 가위바위보 ✊');
  await host.click('.time[data-secs="0"]'); // 무제한
  await Promise.all([host.waitForURL(/\/r\//), host.click('#create')]);
  const roomId = host.url().split('/r/')[1].split('#')[0];
  console.log('room:', roomId);

  // 참가자 4명 API 로 합류
  const players = [];
  for (const name of ['철수', '영희', '민수', '지현']) {
    const d = await api(`/api/rooms/${roomId}/join`, { name });
    players.push(d); // { playerId, name }
  }
  const id = (nm) => players.find((p) => p.name === nm).playerId;

  await sleep(2500); // 3D 로딩 + 캐릭터 spawn
  await host.screenshot({ path: 'docs/lobby.png' });

  // 시작
  await host.click('#startBtn');
  await sleep(800);

  // 라운드 1: 철수·영희 바위 / 민수·지현 가위 → 가위 탈락
  await api(`/api/rooms/${roomId}/play`, { playerId: id('철수'), choice: 'rock', round: 1 });
  await api(`/api/rooms/${roomId}/play`, { playerId: id('영희'), choice: 'rock', round: 1 });
  await api(`/api/rooms/${roomId}/play`, { playerId: id('민수'), choice: 'scissors', round: 1 });
  await api(`/api/rooms/${roomId}/play`, { playerId: id('지현'), choice: 'scissors', round: 1 });
  await sleep(4000); // 호스트 페이지가 폴링으로 감지 → 3D 연출
  await host.screenshot({ path: 'docs/reveal.png' });

  // 라운드 2: 철수 바위 / 영희 가위 → 철수 우승
  await api(`/api/rooms/${roomId}/play`, { playerId: id('철수'), choice: 'rock', round: 2 });
  await api(`/api/rooms/${roomId}/play`, { playerId: id('영희'), choice: 'scissors', round: 2 });
  await sleep(6000);
  await host.screenshot({ path: 'docs/reveal-final.png' });

  console.log('charCount:', await host.evaluate(() => window.RPS3D && window.RPS3D.charCount && window.RPS3D.charCount()));
  console.log('has3d:', await host.evaluate(() => document.body.classList.contains('has3d')));
} catch (e) {
  errors.push('스크립트 예외: ' + e.message);
  console.error(e);
} finally {
  await browser.close();
  srv.kill('SIGTERM');
}

if (errors.length) {
  console.error('\n❌ 콘솔/페이지 에러 발견:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log('\n✅ 스모크 통과: 콘솔 에러 0, 스크린샷 저장(docs/)');
process.exit(0);
