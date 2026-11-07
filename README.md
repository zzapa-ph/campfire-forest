# 모닥불 숲: 클라우드플레어에 올리기

## 폴더 구성
- `public/index.html`: 게임 전체 (three.js, 3D 모델, 소리, 텍스처까지 이 파일 하나에 다 들어 있음)
- `public/cf-bridge.js`: 참고용 연결부 원본 (index.html 안에 이미 들어 있음)
- `public/admin.html`: 건의함 보기 (관리자 키가 있어야 열림)
- `src/worker.js`: 서버 (같은 숲에 모이기, 편지함, 건의함)
- `wrangler.jsonc`: 클라우드플레어 설정

## 가장 간단한 방법 (혼자 노는 숲)
- 클라우드플레어 대시보드 > Workers & Pages > 만들기 > Pages > 에셋 업로드에서 `index.html` 하나만 올리면 돼요
- 같은 숲에 모이기, 편지함, 건의함은 아래 명령어 방식으로 올려야 동작해요

## 처음 한 번
1. https://dash.cloudflare.com 에서 계정을 만들어요 (무료 플랜으로 시작 가능)
2. 컴퓨터에 Node.js(18 이상)를 설치해요
3. 이 폴더에서 터미널을 열고 아래를 차례로 실행해요

```
npm install
npx wrangler login
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

- `wrangler login`을 누르면 브라우저가 열리고, 클라우드플레어 로그인 후 허용을 누르면 돼요
- `secret put ADMIN_KEY`에서 건의함을 볼 때 쓸 비밀번호를 정해요 (남에게 알려 주지 마세요)
- `deploy`가 끝나면 `https://campfire-forest.<계정이름>.workers.dev` 주소가 나와요. 이 주소를 공유하면 돼요

## 고친 뒤 다시 올리기
```
npx wrangler deploy
```

## 건의함 보기
- `https://주소/admin.html` 에서 관리자 키를 넣으면 건의가 최신순으로 보여요

## 내 도메인 연결 (선택)
- 클라우드플레어 대시보드 > Workers & Pages > campfire-forest > Settings > Domains & Routes에서 추가해요

## 내 컴퓨터에서 먼저 돌려 보기 (선택)
```
echo 'ADMIN_KEY="test"' > .dev.vars
npx wrangler dev
```
- http://localhost:8787 에서 열려요

## 알아 두기
- 한 숲에 동시에 80명까지 들어올 수 있어요 (`src/worker.js`의 MAX_PEERS)
- 편지와 건의는 한 사람이 15초에 한 번만 보낼 수 있어요
- 욕설, 연락처, 링크가 들어간 편지는 서버에서 한 번 더 막아요
- 무료 플랜 한도와 요금은 바뀔 수 있으니 클라우드플레어 요금 안내를 확인해 주세요
