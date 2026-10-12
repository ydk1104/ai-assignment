// 테스트 실행기. docker test 컨테이너의 기본 명령이다.
//   node test/run.js          : 스택이 뜰 때까지 기다린 뒤 단위 테스트 + e2e + DB 정합성 검사
//   node test/run.js --unit   : 단위 테스트만 (스택/DB 불필요, dist 필요)
// 환경변수: BASE_URL(기본 http://127.0.0.1), SKIP_DB_CHECK=1 (DB 정합성 검사 생략)
//   RANDOM_SEED : 스택이 쓰는 고정 seed (테스트가 기대값을 계산하는 데 사용). 없으면 시간 기반 랜덤 모드
//   TEST_PHASE  : main(기본) = 성공하는 seed 용 전체 테스트, failure = 실패하는 seed 용 token_create_fail 테스트
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1").replace(
  /\/$/,
  "",
);
const unitOnly = process.argv.includes("--unit");
const PHASE = process.env.TEST_PHASE ?? "main";
// seed가 고정이면 결과가 항상 같으므로 "판단 불가"는 seed 설정이 잘못된 것 -> 재시도하지 않고 실패로 본다.
// seed가 없는(랜덤) 모드에서만, 10% 확률로 일부러 내는 에러 때문에 "판단 불가(종료 코드 2)"면 다시 실행한다.
const RANDOM_MODE = !process.env.RANDOM_SEED;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStack(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`스택 대기: ${BASE_URL}/status `);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/status`);
      if (res.ok) {
        console.log("OK\n");
        return;
      }
    } catch {
      /* 아직 안 떴음 */
    }
    process.stdout.write(".");
    await sleep(1000);
  }
  console.log("\n스택이 뜨지 않았어요");
  process.exit(1);
}

// 종료 코드 0=성공, 2=판단 불가(재시도), 그 외=실패
function runStep(name, args, { retryOnInconclusive = false } = {}) {
  console.log(`\n=== ${name} ===`);
  const attempts = retryOnInconclusive ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1)
      console.log(
        `--- 재시도 ${attempt}/${attempts} (일부러 내는 에러에 걸림) ---`,
      );
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status === 0) return { name, ok: true };
    if (result.status !== 2) return { name, ok: false };
  }
  return { name, ok: false, note: `${attempts}번 모두 판단 불가` };
}

(async () => {
  const results = [];
  console.log(
    `단계: ${PHASE}, RANDOM_SEED=${process.env.RANDOM_SEED || "(없음: 시간 기반 랜덤)"}`,
  );

  if (unitOnly || PHASE === "main") {
    const unitDir = path.join(root, "test", "unit");
    const unitFiles = fs
      .readdirSync(unitDir)
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => path.join("test", "unit", f));
    results.push(runStep("단위 테스트", ["--test", ...unitFiles]));
  }

  if (!unitOnly) {
    await waitForStack();
    if (PHASE === "failure") {
      results.push(
        runStep("실패 경로 (e2e-failure)", ["--test", "test/e2e-failure.js"]),
      );
    } else {
      results.push(
        runStep("API 기본 동작 (e2e)", ["--test", "test/e2e-basic.js"]),
      );
      results.push(
        runStep(
          "끊고 이어받기 (resume-test)",
          ["scripts/resume-test.js", `${BASE_URL}/create_document`],
          { retryOnInconclusive: RANDOM_MODE },
        ),
      );
      results.push(
        runStep(
          "취소 (cancel-test)",
          ["scripts/cancel-test.js", "50", BASE_URL],
          { retryOnInconclusive: RANDOM_MODE },
        ),
      );
    }
    if (process.env.SKIP_DB_CHECK === "1")
      console.log("\n(SKIP_DB_CHECK=1: DB 정합성 검사 생략)");
    else results.push(runStep("DB 정합성", ["test/db-consistency.js"]));
  }

  console.log("\n================ 결과 ================");
  for (const r of results)
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? ` (${r.note})` : ""}`,
    );
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? "\n모든 테스트 통과" : `\n${failed}개 단계 실패`);
  process.exit(failed === 0 ? 0 : 1);
})();
