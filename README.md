# ✊✋✌️ 가위바위보 서바이벌

링크를 카톡·팀즈로 공유하면, 여러 명이 각자 가위바위보를 내고 **한 명이 남을 때까지** 대결하는 초간단 온라인 가위바위보입니다.

## 무료 배포 (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jungrok5/rps-online/tree/claude/rps-site-design-tdzeol)

위 버튼 → Render 로그인 → **Apply** 한 번이면 배포됩니다. `render.yaml`에
빌드/시작 명령이 정의돼 있어 추가 설정이 필요 없습니다. 배포 후
`https://rps-online-xxxx.onrender.com` 주소로 방을 만들어 링크를 공유하세요.

> 무료(Free) 인스턴스는 15분간 접속이 없으면 잠들고, 첫 접속 시 약 30초
> 콜드스타트가 있습니다. 게임 중에는 폴링으로 계속 깨어 있어 문제없습니다.

- **데이터베이스 없음** — 모든 상태는 서버 메모리에 저장됩니다(재시작 시 초기화).
- **의존성 없음** — Node 내장 모듈만 사용. `node server.js` 하나로 실행.
- **실시간 갱신** — WebSocket 없이 클라이언트 폴링(1.5초)으로 처리.

## 실행

```bash
node server.js
# http://localhost:3000
```

포트 변경: `PORT=8080 node server.js`

## 게임 방식 (서바이벌)

1. **새 게임 만들기** → 짧은 방 링크 생성 (`/r/xxxxxx`)
2. 링크를 카톡·팀즈에 공유 → 참가자들이 이름 입력 후 참가
3. 방장이 **게임 시작** (2명 이상)
4. 매 라운드 생존자 전원이 가위/바위/보 선택
   - **두 종류만 나오면** → 이긴 쪽이 올라가고 진 쪽 탈락 (이긴 사람끼리 다음 라운드)
   - **모두 같거나 세 종류 다 나오면** → 무승부, 같은 인원으로 재대결
5. **최후의 1인** 이 남으면 🏆 우승

## 구조

```
server.js          순수 Node HTTP 서버 (API + 정적 파일 + 게임 로직)
public/index.html  방 생성 페이지
public/room.html   로비·대결·결과 (폴링 SPA)
public/style.css   스타일
```

## 배포 메모

서버 메모리 저장 방식이라 **항상 켜져 있는 단일 인스턴스**에 배포해야 합니다
(Render / Railway / Fly.io 등). 서버리스(Vercel 등)에 올리려면 메모리 대신
관리형 KV(Upstash 등)로 저장소만 교체하면 됩니다.
