셋업시 있었던 질/답 로그입니다.  
"프롬프트 전문은 필요 없습니다. 핵심만 짧게 적어 주세요."  
라 하셨지만 있으면 참고하실까 싶기도 했고,  
저도 정리해두면 나중에 볼 일이 있을까 하여 간단하게만 옮겨둡니다.  
(\*간단하게 : 마크다운 깨지는거 고려안하고 preview확인없이 정리했다는 의미)

1. API 서버 두대와 생성 워커 2대 이상이 존재하고 nginx를 로드밸런서로 사용하는 nest.js 서버를 docker로 셋업하고 싶어. 도커파일 말아줘

응답) Dockerfile, Docker compose.yml, nginx.conf 생성,  
docker compose up -d --build 커맨드 제공.  
및 다음과 같은 확인요청:  
제가 가정한 부분 (맞게 수정해 주세요)

API 진입점은 dist/main.js, 워커 진입점은 dist/worker.js예요. 워커는 HTTP 없이 NestFactory.createApplicationContext로 띄우는 별도 엔트리를 상정했어요.
작업 분배용으로 Redis(BullMQ 등)를 넣었어요. 큐로 RabbitMQ, Kafka, DB 폴링 등을 쓰신다면 redis 서비스를 교체하면 돼요.
DB는 포함하지 않았어요. 필요하면 postgres 같은 서비스를 추가하고 환경변수만 연결하면 돼요.
앱은 PORT를 읽어서 3000에서 listen한다고 봤어요.

워커가 어떤 큐를 쓰는지, DB가 무엇인지 알려주시면 거기에 맞춰 compose를 더 다듬어 드릴게요.

2. 큐는 BullMQ, DB는 PostgreSQL & Redis(로컬) 쓸거야

응답) .yml 수정 및 .env.example 제공,  
cp .env.example .env # 비밀번호 수정  
docker compose up -d --build 커맨드 안내

3. project name must not be empty래

응답) 해결: 프로젝트 이름을 직접 지정하기

docker-compose.yml 맨 위에 name: nest-app을 추가했어요. 수정된 파일을 받아서 쓰시면 그냥 docker compose up -d --build로 돼요.

4. target api-2: failed to solve: process "/bin/sh -c npm ci --omit=dev && npm cache clean --force" did not complete successfully: exit code: 1  
   래

응답) npm ci --omit=dev 단계에서 실패했다는 것만으로는 원인을 특정하기 어려워요. 한 가지 짚어두면, 에러에 api-2가 나온 건 api-1, api-2, worker가 같은 이미지를 빌드하는데 그중 하나가 대표로 찍힌 것뿐이에요. NestJS 프로젝트에서 이 단계가 실패하는 흔한 원인은 아래 세 가지예요.

prepare 스크립트 실패 (가장 흔함): package.json에 "prepare": "husky install"이 있으면, devDependencies를 빼고 설치할 때 husky가 없어서 스크립트가 터져요. 해결은 Dockerfile의 deps 단계를 이렇게 바꾸는 거예요.
(후략)

5. 사실 아직 프로젝트를 안만들어서 당연한게 아닐까? 같은 폴더에 dist/main.js가 있어야 하는거지? 일단 간단하게 /status api만 만들고, 성공하면 200 OK를 돌려주도록 nest.js 서버 셋팅해줘

응답) 맞아요, 그게 원인일 가능성이 아주 높아요. package.json과 package-lock.json이 없으니 npm ci가 실패하는 게 당연해요. 그리고 dist/main.js는 직접 만드는 게 아니라, Dockerfile 빌드 단계에서 nest build가 src/main.ts를 컴파일해서 만들어요.

(중략)

실행 순서

프로젝트 폴더에서 한 번만 실행해서 package-lock.json을 만들어요. 이 파일이 있어야 Dockerfile의 npm ci가 통과해요. (저는 네트워크가 막혀 있어서 대신 생성하지 못했어요.)
npm install
(선택) 도커 없이 먼저 확인해 볼 수 있어요.
npm run build && node dist/main.js
curl -i localhost:3000/status
도커로 띄우고 nginx를 거쳐서 확인해요.
docker compose up -d --build
curl -i http://localhost/status
HTTP/1.1 200 OK와 {"status":"ok"}가 나오면 성공이에요.

6. npm run build해도 dist폴더가 안만들어져

npm run build가 에러를 하나도 안 찍고 조용히 끝났는지, 에러가 났는지에 따라 원인이 갈려요. 에러가 나면 dist가 안 생기는 게 정상이라서, 터미널에 찍힌 출력이 중요해요. 지금 상황에서 가능성이 높은 순서대로 정리할게요.

1. src 폴더 없이 파일이 한 폴더에 풀려 있는 경우 (가장 의심돼요)
   파일을 하나씩 내려받으면 src/ 구조가 사라지고 main.ts 등이 프로젝트 루트에 평평하게 놓이기 쉬워요. 그러면 tsconfig.build.json이 src/\**/*만 보기 때문에 컴파일할 파일이 없다는 에러(TS18003: No inputs were found)가 나요. 아래처럼 나와야 정상이에요.
   (후략)

2. 로컬동작 확인했고, 도커 빌드하려니까 이렇게 떠:
   Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "/run/desktop/mnt/host/c/Users/c/document/취업준비/과제/nginx/nginx.conf" to rootfs at "/etc/nginx/nginx.conf": mount src=/run/desktop/mnt/host/c/Users/c/document/취업준비/과제/nginx/nginx.conf, dst=/etc/nginx/nginx.conf, dstFd=/proc/thread-self/fd/14, flags=MS\*BIND|MS_REC: not a directory: Are you trying to mount a directory onto a file (or vice-versa)? Check if the specified host path exists and is the expected type
   <!-- 위에서도 그랬지만, 한글 넣으면 에러 잘뜰거같아서 일부러 넣고 수정 잘되나 구경해봤습니다 -->

응답) 이 에러는 nginx/nginx.conf가 파일이 아니라 폴더로 존재할 때 나요. 호스트에 그 경로의 파일이 없으면 Docker Desktop이 마운트하면서 같은 이름의 빈 폴더를 만들어 버리고, 그 폴더를 파일 자리(/etc/nginx/nginx.conf)에 붙이려다 실패해요. 예전 실행에서 이미 폴더가 만들어졌을 가능성이 높아요.
(후략)

7. 빌드됐어. 확인은 어떻게 할까?

응답)
브라우저나 터미널에서 아래 순서로 확인하면 돼요. (PowerShell, 프로젝트 폴더 기준)

1. 컨테이너 상태

docker compose ps

nginx, api-1, api-2, postgres, redis, 그리고 worker 2개가 모두 running이어야 해요. postgres와 redis는 (healthy)로 표시돼요. 하나라도 Restarting이나 Exited면 docker compose logs 서비스이름으로 원인을 볼 수 있어요.

2. /status 응답 (nginx를 거치는 경로)

curl.exe -i http://localhost/status

HTTP/1.1 200 OK와 {"status":"ok"}가 나오면 성공이에요. 브라우저에서 http://localhost/status를 열어도 돼요.

3. 워커 2대 확인

docker compose logs worker

worker started 로그가 워커별로 하나씩, 총 2번 보이면 돼요.

4. 로드밸런서 동작 확인 (장애 대응)
   nginx 기본 설정은 어느 서버가 응답했는지 보여주지 않아서, 한 대를 꺼서 확인하는 게 가장 확실해요.

docker compose stop api-1
curl.exe -i http://localhost/status # 여전히 200이면 api-2가 받아주는 것
docker compose start api-1
docker compose stop api-2
curl.exe -i http://localhost/status # 이번에도 200이어야 함
docker compose start api-2

stop 직후 첫 요청이 잠깐 느리거나 한 번 실패할 수 있는데, nginx가 죽은 서버를 감지하는 과정이라 정상이에요.

5. 요청이 번갈아 가는지 보고 싶다면 (선택)
   각 API 컨테이너에 로그가 없어서 지금은 구분이 안 돼요. 원하시면 /status 응답에 컨테이너 호스트명을 포함시키는 코드를 추가해 드릴게요. 그러면 여러 번 호출했을 때 api-1과 api-2가 번갈아 나오는지 눈으로 바로 확인할 수 있어요.
