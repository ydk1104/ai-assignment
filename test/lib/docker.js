// Docker Engine API(유닉스 소켓)를 호출하는 작은 클라이언트. docker CLI 없이 컨테이너 조회/로그/kill/start 를 한다.
// test 컨테이너가 /var/run/docker.sock 을 마운트했을 때만 쓸 수 있다 (docker-compose.test.yml 참고).
const http = require("http");
const fs = require("fs");
const os = require("os");

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const socketAvailable = () => fs.existsSync(SOCKET);

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, method, path, timeout: 15_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`docker API 시간 초과: ${method} ${path}`)),
    );
    req.on("error", reject);
    req.end();
  });
}

async function json(method, path) {
  const res = await request(method, path);
  if (res.status >= 300)
    throw new Error(
      `docker API ${method} ${path} -> ${res.status} ${res.body.toString().slice(0, 200)}`,
    );
  return JSON.parse(res.body.toString() || "null");
}

// 204(성공) / 304(이미 그 상태)는 성공으로 본다
async function action(method, path) {
  const res = await request(method, path);
  if (res.status >= 300 && res.status !== 304)
    throw new Error(
      `docker API ${method} ${path} -> ${res.status} ${res.body.toString().slice(0, 200)}`,
    );
}

// 컨테이너 로그는 [stream(1) 0 0 0 size(4바이트, big-endian)] 헤더가 붙은 프레임으로 온다
function demux(buf) {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out;
}
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// 이 test 컨테이너가 속한 compose 프로젝트 이름 (컨테이너 라벨에서 읽는다)
async function ownProject() {
  try {
    const info = await json("GET", `/containers/${os.hostname()}/json`);
    return info.Config?.Labels?.["com.docker.compose.project"];
  } catch {
    return undefined;
  }
}

// 실행 중인 워커 컨테이너 목록 [{ id, name }]
async function runningWorkers(project) {
  const filters = JSON.stringify({
    label: [
      `com.docker.compose.project=${project}`,
      "com.docker.compose.service=worker",
    ],
    status: ["running"],
  });
  const list = await json(
    "GET",
    `/containers/json?filters=${encodeURIComponent(filters)}`,
  );
  return list
    .map((c) => ({ id: c.Id, name: (c.Names?.[0] ?? c.Id).replace(/^\//, "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function logsOf(id, tail = 2000) {
  const res = await request(
    "GET",
    `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`,
  );
  if (res.status >= 300)
    throw new Error(`로그 조회 실패: ${id} -> ${res.status}`);
  return stripAnsi(demux(res.body));
}

const kill = (id) => action("POST", `/containers/${id}/kill`); // 기본 SIGKILL = 갑자기 죽는 상황
const start = (id) => action("POST", `/containers/${id}/start`);
async function isRunning(id) {
  return (await json("GET", `/containers/${id}/json`)).State?.Running === true;
}

module.exports = {
  socketAvailable,
  ownProject,
  runningWorkers,
  logsOf,
  kill,
  start,
  isRunning,
  demux,
  stripAnsi,
};
