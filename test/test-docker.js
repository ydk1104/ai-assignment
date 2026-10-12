// 사용법: npm run test:docker [main|failure]   (또는 node scripts/test-docker.js)
// 고정 seed로 테스트 전용 스택을 단계별로 띄워 test 컨테이너를 실행한다. 단계마다 스택/데이터를 새로 만들고 끝나면 정리한다.
//   main    : 성공하는 seed (test/seeds.json 의 main)    -> 단위 + API + 끊고 이어받기 + 취소 + DB 정합성
//   failure : 도중에 실패하는 seed (seeds.json 의 failure) -> token_create_fail 경로 + DB 정합성
const { spawnSync } = require("child_process");
const seeds = require("../test/seeds.json");

const phases = [
  { name: "main", seed: seeds.main },
  { name: "failure", seed: seeds.failure },
];
const only = process.argv[2];
const selected = only ? phases.filter((p) => p.name === only) : phases;
if (selected.length === 0) {
  console.error(`알 수 없는 단계: ${only} (main | failure)`);
  process.exit(1);
}

const compose = [
  "compose",
  "-p",
  "nest-app-test",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.test.yml",
];
const docker = (args, env) =>
  spawnSync("docker", [...compose, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

let exitCode = 0;
for (const phase of selected) {
  console.log(
    `\n########## 단계: ${phase.name} (RANDOM_SEED=${phase.seed}) ##########`,
  );
  const env = { TEST_SEED: String(phase.seed), TEST_PHASE: phase.name };

  const up = docker(["up", "--build", "--exit-code-from", "test"], env);
  if (up.error) console.error(`docker 실행 실패: ${up.error.message}`);
  const code = up.status ?? 1;

  if (code !== 0) {
    console.log("\n--- 실패: API/워커 로그 (마지막 60줄) ---");
    docker(["logs", "--tail=60", "api-1", "api-2", "worker"], env);
    exitCode = exitCode || code;
  }
  docker(["down", "-v", "--remove-orphans"], env); // 이 단계의 스택과 테스트 데이터 정리
}
process.exit(exitCode);
