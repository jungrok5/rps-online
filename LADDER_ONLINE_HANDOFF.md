# 🪜 ladder-online 작업 핸드오프 (사다리타기 온라인)

> **새 세션 시작용 문서.** 이 세션에는 참고용 `rps-online`과 작업 대상 `ladder-online`
> 두 레포가 붙어 있습니다. **이 파일을 먼저 읽고**, `rps-online`의 코드를 골격으로
> 재사용해 `ladder-online`을 구현하세요. 작업/커밋/푸시는 **`ladder-online` 레포**에 합니다.

## 0. 한 줄 요약
RPS(가위바위보 서바이벌)와 **동일한 아키텍처**(무DB·인메모리·폴링·zero-dep Node 서버·정적
HTML)로 **사다리타기(Amidakuji) 온라인**을 만든다. 링크를 카톡/팀즈로 공유 → 각자 칸을
고르고 → 방장이 시작하면 랜덤 사다리가 생성되고 → 각자 경로를 타고 내려가 결과(꽝/당첨 등)에
도착하는 연출을 보여준다.

## 1. 시작 절차 (새 세션에서)
1. 작업 브랜치 생성: `ladder-online`에서 `claude/ladder-online-<slug>` (RPS 컨벤션과 동일).
2. `rps-online/`의 다음 파일을 **그대로 베껴 골격으로** 사용:
   - `server.js` — 순수 Node http 서버(라우팅·정적서빙·gzip·캐시·MIME·룸 저장소·정리 인터벌)
   - `public/index.html`, `public/room.html`, `public/style.css` — 생성 페이지 + 폴링 SPA 패턴
   - `render.yaml`, `package.json`, `.gitignore`, `README.md` 구조
3. 사다리 전용 로직(아래 3~5장)으로 게임 부분만 교체.
4. 진행 전 **사용자에게 결정사항(8장) 확인**.

## 2. RPS에서 그대로 재사용할 패턴 (파일 위치: `rps-online/`)
- **무DB 인메모리 룸 저장소** `const rooms = Object.create(null)` + 12시간 정리 인터벌(`.unref()`).
- **폴링 SPA**: 클라가 1.5초마다 `GET /api/rooms/:id` → 상태 서명(sig) 바뀔 때만 `render()`.
- **방장 토큰(hostToken)** 으로 시작/리셋 권한 제어. 생성 시 URL 해시(`#host=`)로 전달 →
  `localStorage` 저장. 참가자 식별은 `playerId`(localStorage).
- **정적 서빙**: `serveFile()` — MIME, `Cache-Control`(HTML `no-store` / `/vendor`·`/assets`는
  `immutable`), 텍스트 `gzip`, 디렉터리 트래버설 가드(`PUBLIC_DIR + path.sep` 경계 확인).
- **배포**: `render.yaml`(branch·`node server.js`·autoDeploy), 무료 Render. `process.env.PORT` 사용.
- **빌드 버전 표기**: `index.html` 푸터에 `build vN · 설명` — 배포 갱신 확인용(캐시 이슈 추적에 유용).

## 3. 게임 모델 / 룸 상태
```js
room = {
  id, hostToken, createdAt,
  title,                       // 예: "점심 사다리"
  status: 'lobby' | 'revealing' | 'finished',
  laneCount: N,                // 칸(세로줄) 수, 2..MAX_LANES
  results: [N strings],        // 바닥 결과(예: ["꽝","꽝","당첨","꽝"])
  resultsHidden: true,         // 시작 전(그리고 도착 전)까지 결과 숨김
  laneMode: 'pick' | 'random', // 칸 선택 방식
  players: [{ id, name, lane: int|null }], // lane = 위쪽 출발 칸(0..N-1)
  ladder: null | { rows: R, H: bool[R][N-1] }, // H[r][c]=col c와 c+1 사이 가로대
  mapping: null | int[N],      // 출발칸 -> 도착 인덱스 (사다리 확정 시 계산)
}
```
> 사다리타기는 **항상 전단사(bijection)** 이므로 `mapping`은 0..N-1의 순열이 된다.

## 4. 사다리 생성 알고리즘 (서버, `/start` 시)
```
rows R = clamp(round(N * 1.8) + 4, 8, 40)   // 가독성 있는 밀도
H = R x (N-1) false 초기화
각 행 r:
  c = 0..N-2 왼→오:
    if !H[r][c-1] (바로 왼쪽 칸에 가로대 없음) and random() < 0.45:
      H[r][c] = true   // 인접 가로대 금지(같은 세로줄 공유 방지)
```
**경로 추적** (출발칸 s → 바닥):
```
pos = s
for r in 0..R-1:
  if pos>0   and H[r][pos-1]: pos -= 1
  elif pos<N-1 and H[r][pos]: pos += 1
mapping[s] = pos
```
- 인접 가로대 금지 덕분에 한 행에서 좌/우 동시 이동은 없음.
- `mapping`이 순열인지 검증(테스트에서 assert).

## 5. API (RPS와 동일한 형태)
- `POST /api/rooms` `{ title, laneCount, results[], resultsHidden, laneMode }`
  → 검증(아래) 후 `{ roomId, hostToken }`
- `POST /api/rooms/:id/join` `{ name, lane? }`
  - `laneMode==='pick'`: 빈 칸이면 배정, 점유면 409. `lane` 없으면 가장 작은 빈 칸.
  - `laneMode==='random'`: lane=null로 두고 `/start`에서 일괄 랜덤 배정.
  - lobby 아닐 때 join 거부(관전).
- `POST /api/rooms/:id/start` `{ hostToken }`
  - 참가자 ≥ 2 확인, random 모드면 빈 칸에 랜덤 배정, **사다리 생성 + mapping 계산**,
    `status='revealing'`.
- `GET /api/rooms/:id` → `publicState`. **시작 전에는 `ladder`/`mapping`/(숨김이면)`results`
  를 절대 노출하지 말 것** (RPS에서 현재 라운드 선택을 숨긴 것과 같은 원리).
- `POST /api/rooms/:id/reset` `{ hostToken }` → lobby로(사다리·매핑 초기화, 칸은 유지/초기화 택1).

## 6. 클라이언트 연출 (기본: 2D 클래식 사다리)
- **로비**: 칸 그리드/리스트, 빈 칸 클릭으로 선택(pick 모드), 공유 링크 복사(**제목+링크 함께**,
  RPS `room.html`의 copy 핸들러 참고), 방장 "시작" 버튼.
- **공개**: SVG/Canvas로 N개 세로줄 + 가로대(H) 그리기 → 각 플레이어 토큰(이름표)이 위에서
  아래로 내려가며 가로대에서 좌우로 꺾이는 애니메이션. 도착 시 결과 칸 공개(숨김이면 플립).
  - 동시 출발 or 한 명씩(쫄깃) — RPS의 `playReveal` 순차 공개·`failsafe`·`revealing` 가드 패턴 재사용.
- **확장(선택)**: RPS의 Kenney 3D 캐릭터가 사다리를 타고 내려가는 3D 버전(`rps-online/public/scene.js`
  의 Three.js 동봉·캐릭터 로딩 패턴 재사용). 우선 2D로 완성 후 논의.

## 7. RPS에서 얻은 교훈 (반드시 반영 — 실제로 터졌던 버그들)
- **클라이언트 전역 상수 정의 누락 금지**: RPS에서 `CHOICES` 미정의로 연출이 멈춤. 쓰는 상수는
  반드시 선언.
- **HTML은 `Cache-Control: no-store`**, 라이브러리/에셋은 `immutable` 장기 캐시. (배포 후 옛 화면
  고착 방지)
- **토큰/방ID는 `crypto.randomInt`** 기반(예측 불가).
- **자원 상한**: `MAX_ROOMS`(예 5000), `MAX_LANES`(가독성상 예 12~20, 하드캡 50), 이름 길이 슬라이스.
- **입력 검증**: `laneCount` 정수·범위, `results.length === laneCount`, 문자열 길이 제한, `laneMode`
  화이트리스트, 숫자 강제값(`null/""`이 0으로 새지 않게 — RPS roundSeconds 사례).
- **시작 전 비밀 누출 금지**: `publicState`에서 ladder/mapping/(숨김)results 제외.
- **연출 안정성**: 강제 종료 `failsafe` 타이머 + 중복 실행 가드(`done`), 폴링과의 경합 주의.
- **정적 트래버설 가드**, **인터벌 `.unref()`**, **12h 룸 정리**.

## 8. 사용자에게 확인할 결정사항 (착수 전 질문)
1. **결과 종류**: `꽝/당첨` · 자유 입력 · 등수(1~N) · 벌칙 텍스트 — 그리고 결과 개수=칸 수 규칙.
2. **칸 배정**: 직접 선택(pick) vs 랜덤(random).
3. **결과 공개 시점**: 시작 전 숨김(기본) vs 공개.
4. **연출**: 2D 클래식 사다리(기본) vs 3D 캐릭터(RPS 에셋 재사용 확장).
5. **최대 칸 수**(가독성).

## 9. 검증 방법 (RPS와 동일)
- **Node 테스트 하니스**(node 22 global fetch): 방 생성/입력검증, join 칸 충돌·범위, start 후
  **mapping이 순열인지**, 시작 전 ladder/results **미노출** 확인, reset, 자원 상한, 트래버설.
- 애니메이션은 **Playwright(헤드리스 Chromium)** 스모크로 콘솔 에러 0 + 스크린샷 확인
  (RPS에서 `--use-gl=swiftshader`로 성공). README용 스크린샷도 이걸로 캡처해 `docs/`에.
- 푸시 컨벤션: 네트워크 실패 시 지수 백오프 재시도, `git push -u origin <branch>`.

## 10. 참고 파일 (rps-online)
- `server.js` — 서버 골격 전체(이걸 복사 후 게임 로직만 교체)
- `public/room.html` — 폴링/렌더/연출(`playReveal`·`failsafe`·copy)·importmap 패턴
- `public/scene.js` — (3D 확장 시) Three.js 동봉·GLB 로딩·카메라 자동 프레이밍
- `render.yaml`, `README.md` — 배포/문서 패턴

---
**첫 행동 제안:** 위 8장 결정사항을 사용자에게 물어 확정 → `server.js` 골격 이식 →
사다리 생성/경로/검증 테스트 통과 → 2D 연출 → README·스크린샷 → Render 배포.
