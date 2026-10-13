// 사용법: npm run test:docker [main|failure] [--verbose] [--keep-logs]
//
// 고정 seed로 테스트 전용 스택을 단계별로 띄워 test 컨테이너를 실행한다. 단계마다 스택/데이터를 새로 만들고 끝나면 정리한다.
//   main    : 성공하는 seed (test/seeds.json 의 main)    -> 단위 + API + 끊고 이어받기 + 취소 + DB 정합성
//   failure : 도중에 실패하는 seed (seeds.json 의 failure) -> token_create_fail 경로 + DB 정합성
//
// 콘솔에는 진행 상황(단계/PASS/FAIL)만 보여주고, 자세한 로그는 파일로 남긴다.
//   성공하면 로그를 지운다.
//   실패하면 test-logs/ 를 남기고 요약을 출력한다:
//     test-logs/error.log          실패 요약 (실패한 단계/테스트와 에러 메시지, 서비스의 에러/경고 로그)
//     test-logs/<단계>/test.log    test 컨테이너 전체 출력
//     test-logs/<단계>/up.log      이미지 빌드/스택 기동 출력 (docker compose up -d)
//     test-logs/<단계>/<서비스>.log api-1, api-2, worker, nginx, postgres, redis 각각의 로그
// 옵션: --verbose 테스트 컨테이너 출력을 전부 보여준다 / --keep-logs 성공해도 로그를 남긴다
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const seeds = require("../test/seeds.json");

const ROOT = path.join(__dirname, "..");
const LOG_ROOT = process.env.TEST_LOG_DIR ?? path.join(ROOT, "test-logs");
const SERVICES = ["api-1", "api-2", "worker", "nginx", "postgres", "redis"];

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const KEEP_LOGS = argv.includes("--keep-logs");
const only = argv.find((a) => !a.startsWith("--"));

const phases = [
  { name: "main", seed: seeds.main },
  { name: "failure", seed: seeds.failure },
];
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
const rel = (p) => path.relative(process.cwd(), p) || p;
const short = (text, max = 160) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// 기본(간단) 모드에서 콘솔에 보여줄 test 컨테이너 출력
const SHOW = [
  /^단계:/,
  /^스택 대기/,
  /^=== /,
  /^(PASS|FAIL|SKIP)  /,
  /^# (pass|fail) /,
  /^모든 테스트 통과/,
  /개 단계 실패/,
  /재시도/,
];

// ---------------------------------------------------------------- 실행

const endStream = (stream) => new Promise((resolve) => stream.end(resolve));

const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 20 * 60 * 1000); // test 컨테이너가 이 시간 안에 끝나야 한다

// docker compose 명령을 실행하고 출력을 줄 단위로 onLine 에 넘긴다. { child, done(종료 코드 Promise) }
function startCompose(args, env, onLine) {
  const child = spawn("docker", [...compose, ...args], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    child.on("error", (err) => {
      onLine(`docker 실행 실패: ${err.message}`);
      console.error(`docker 실행 실패: ${err.message}`);
      finish(1);
    });
    readline.createInterface({ input: child.stdout }).on("line", onLine);
    readline.createInterface({ input: child.stderr }).on("line", onLine);
    child.on("close", (code) => finish(code ?? 1));
  });
  return { child, done };
}

const dockerSync = (args, env) =>
  spawnSync("docker", args, { cwd: ROOT, env, encoding: "utf8" });
function containerId(service, env) {
  const r = dockerSync([...compose, "ps", "-aq", service], env);
  return (r.stdout ?? "").trim().split(/\s+/)[0] || null;
}
function inspectContainer(service, format, env) {
  const id = containerId(service, env);
  return id
    ? (dockerSync(["inspect", "-f", format, id], env).stdout ?? "").trim()
    : "";
}

// test 컨테이너의 로그를 따라가며 진행 상황만 콘솔에 보여준다. test 컨테이너가 끝나면 돌아온다 (시간 초과면 true)
async function followTestLogs(env, testLog) {
  const { child, done } = startCompose(
    ["logs", "--no-color", "-f", "test"],
    env,
    (line) => {
      const text = /^\S+\s+\|\s?(.*)$/.exec(line)?.[1] ?? line; // compose 가 붙인 "test-1  | " 접두어 제거
      testLog.write(`${text}\n`);
      if (VERBOSE || SHOW.some((re) => re.test(text))) console.log(`  ${text}`);
    },
  );

  // logs -f 가 컨테이너 종료 후에도 끝나지 않는 경우를 대비해, 상태를 직접 확인하다가 끝났으면 잠시 뒤 로그 따라가기를 멈춘다
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  let timedOut = false;
  const watcher = setInterval(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      clearInterval(watcher);
      child.kill();
    } else if (
      ["exited", "dead"].includes(
        inspectContainer("test", "{{.State.Status}}", env),
      )
    ) {
      clearInterval(watcher);
      setTimeout(() => child.kill(), 3000); // 남은 로그를 마저 받을 시간
    }
  }, 2000);
  await done;
  clearInterval(watcher);
  return timedOut;
}

// 이미지 빌드 -> 스택 기동 -> test 컨테이너 실행/완료 대기. test 컨테이너의 종료 코드를 돌려준다
//
// `up --exit-code-from test` 를 쓰지 않는 이유: 이 옵션은 "컨테이너가 하나라도 종료되면 전체를 중단"하는
// --abort-on-container-exit 를 함께 켠다. 장애 복구 테스트가 워커 컨테이너를 일부러 죽이면 스택 전체가 내려가 버린다.
async function runStack(dir, env) {
  const upLog = fs.createWriteStream(path.join(dir, "up.log"));
  const testLog = fs.createWriteStream(path.join(dir, "test.log"));
  try {
    // 1) 빌드 + 기동 (백그라운드). 의존 서비스가 healthy 가 되길 기다린 뒤 돌아온다. 출력은 up.log 에만
    const upCode = await startCompose(["up", "-d", "--build"], env, (line) =>
      upLog.write(`${line}\n`),
    ).done;
    if (upCode !== 0) return upCode;

    // 2) test 컨테이너가 끝날 때까지 로그를 따라간다
    const timedOut = await followTestLogs(env, testLog);
    if (timedOut) {
      upLog.write(
        `test 컨테이너가 ${Math.round(TEST_TIMEOUT_MS / 1000)}초 안에 끝나지 않아 중단했어요\n`,
      );
      return 124;
    }

    // 3) test 컨테이너의 종료 코드
    const code = parseInt(
      inspectContainer("test", "{{.State.ExitCode}}", env),
      10,
    );
    return Number.isNaN(code) ? 1 : code;
  } finally {
    await Promise.all([endStream(upLog), endStream(testLog)]);
  }
}

// 스택이 내려가기 전에 서비스별 로그를 파일로 저장한다
function saveServiceLogs(dir, env) {
  for (const name of SERVICES) {
    const result = spawnSync(
      "docker",
      [...compose, "logs", "--no-color", "--timestamps", name],
      {
        cwd: ROOT,
        env,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(dir, `${name}.log`),
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
}

// ---------------------------------------------------------------- 실패 분석

const readLines = (file) => {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
};

// "not ok" 블록의 error: 값을 한 줄로. assert 에러처럼 여러 줄(|-)이면 앞의 두 줄을 합친다
function tapErrorMessage(block) {
  const i = block.findIndex((l) => /^\s*error:/.test(l));
  if (i < 0) return "";
  const value = block[i].replace(/^\s*error:\s*/, "");
  if (!/^[|>][-+]?$/.test(value)) return value.replace(/^['"]|['"]$/g, "");
  const indent = block[i].search(/\S/);
  const body = [];
  for (let j = i + 1; j < block.length && body.length < 2; j++) {
    if (block[j].search(/\S/) <= indent && block[j].trim() !== "") break; // 블록 끝
    if (block[j].trim() !== "") body.push(block[j].trim());
  }
  return body.join(" ");
}

// node:test 의 TAP 출력에서 "not ok" 블록(에러 메시지 포함)을 뽑는다
function parseTapFailures(lines) {
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const block = [lines[i]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (
        /^\s*(ok|not ok) \d+ /.test(lines[j]) &&
        lines[j].search(/\S/) <= indent.length
      )
        break;
      block.push(lines[j]);
      if (lines[j] === `${indent}  ...`) break;
    }
    failures.push({ name: m[2], message: tapErrorMessage(block), block });
    i = j;
  }
  return failures;
}

// 서비스 로그에서 에러/경고로 보이는 줄 (마지막 max개)
function problemLines(file, max = 20) {
  return readLines(file)
    .filter((l) =>
      /\b(ERROR|WARN|FATAL)\b|Error:|ECONN|unhandled|panic/i.test(l),
    )
    .slice(-max);
}

// 실패 요약: 콘솔용(summary)과 error.log 용(detail)
function analyze(phase, code, dir) {
  const testLines = readLines(path.join(dir, "test.log"));
  const upLines = readLines(path.join(dir, "up.log")).filter(
    (l) => l.trim() !== "",
  );
  const ranTests = testLines.some((l) => /^(단계:|=== )/.test(l));

  const failedSteps = testLines
    .map((l) => /^FAIL  (.+)$/.exec(l)?.[1])
    .filter(Boolean);
  const tapFailures = parseTapFailures(testLines);
  const failedChecks = testLines
    .filter((l) => /^\s+FAIL\s+\S/.test(l))
    .map((l) => l.trim().replace(/^FAIL\s+/, ""));
  const serviceProblems = SERVICES.map((name) => ({
    name,
    lines: problemLines(path.join(dir, `${name}.log`)),
  })).filter((s) => s.lines.length > 0);

  const summary = [
    `✗ ${phase.name} 단계 실패 (RANDOM_SEED=${phase.seed}, 종료 코드 ${code})`,
  ];
  const detail = [
    `[${phase.name} 단계] RANDOM_SEED=${phase.seed}, 종료 코드 ${code}`,
    "",
  ];

  if (code === 124) {
    const msg = `test 컨테이너가 ${Math.round(TEST_TIMEOUT_MS / 1000)}초 안에 끝나지 않아 중단했어요 (TEST_TIMEOUT_MS 환경변수로 조정). 어느 단계에서 멈췄는지는 test.log 마지막 줄을 보세요.`;
    summary.push(`  ${msg}`);
    detail.push(msg, "");
  }
  if (!ranTests) {
    summary.push(
      "  테스트가 실행되기 전에 종료됐어요 (이미지 빌드 또는 스택 기동 실패일 수 있어요). docker compose 출력 마지막 줄:",
    );
    upLines.slice(-12).forEach((l) => summary.push(`    ${short(l)}`));
    detail.push(
      "테스트가 실행되기 전에 종료됨 (이미지 빌드 또는 스택 기동 실패 가능). docker compose up 출력 마지막 60줄:",
    );
    upLines.slice(-60).forEach((l) => detail.push(`  ${l}`));
    detail.push("");
  }

  if (failedSteps.length > 0) {
    summary.push(`  실패한 단계: ${failedSteps.join(", ")}`);
    detail.push(`실패한 단계: ${failedSteps.join(", ")}`, "");
  }
  if (tapFailures.length > 0) {
    summary.push("  실패한 테스트:");
    tapFailures
      .slice(0, 10)
      .forEach((f) =>
        summary.push(
          `    - ${f.name}${f.message ? `\n        ${short(f.message)}` : ""}`,
        ),
      );
    if (tapFailures.length > 10)
      summary.push(`    ... 외 ${tapFailures.length - 10}개 (error.log 참고)`);
    detail.push("실패한 테스트 (node:test 출력):");
    tapFailures.forEach((f) => f.block.forEach((l) => detail.push(`  ${l}`)));
    detail.push("");
  }
  if (failedChecks.length > 0) {
    summary.push("  실패한 검증:");
    failedChecks.slice(0, 10).forEach((c) => summary.push(`    - ${short(c)}`));
    detail.push(
      "실패한 검증 (resume-test / cancel-test):",
      ...failedChecks.map((c) => `  - ${c}`),
      "",
    );
  }

  // 결과 요약 블록 (test 컨테이너 출력의 마지막 부분)
  const resultIdx = testLines.findIndex((l) =>
    l.includes("================ 결과"),
  );
  if (resultIdx >= 0)
    detail.push(
      "test 컨테이너 결과 요약:",
      ...testLines
        .slice(resultIdx)
        .filter((l) => l.trim())
        .map((l) => `  ${l}`),
      "",
    );

  if (serviceProblems.length > 0) {
    summary.push(
      `  서비스의 에러/경고 로그: ${serviceProblems.map((s) => `${s.name} ${s.lines.length}건`).join(", ")}`,
    );
    detail.push("서비스의 에러/경고 로그 (각 서비스 마지막 20줄):");
    for (const s of serviceProblems)
      detail.push(`  --- ${s.name} ---`, ...s.lines.map((l) => `  ${l}`));
    detail.push("");
  } else if (ranTests) {
    detail.push("서비스 로그에 에러/경고 없음", "");
  }

  detail.push(
    `원본 로그: ${path.join(dir)}${path.sep} (test.log, up.log, ${SERVICES.map((s) => `${s}.log`).join(", ")})`,
    "",
  );
  return { summary, detail };
}

// ---------------------------------------------------------------- 메인

(async () => {
  fs.rmSync(LOG_ROOT, { recursive: true, force: true }); // 이전 실행의 로그는 지운다
  fs.mkdirSync(LOG_ROOT, { recursive: true });

  let exitCode = 0;
  const failures = [];

  for (const phase of selected) {
    console.log(
      `\n########## 단계: ${phase.name} (RANDOM_SEED=${phase.seed}) ##########`,
    );
    console.log(
      `이미지 빌드/스택 기동/테스트 실행 중... (전체 로그: ${rel(path.join(LOG_ROOT, phase.name, "up.log"))})`,
    );
    const dir = path.join(LOG_ROOT, phase.name);
    fs.mkdirSync(dir, { recursive: true });
    const env = {
      ...process.env,
      TEST_SEED: String(phase.seed),
      TEST_PHASE: phase.name,
    };

    const code = await runStack(dir, env);
    if (code !== 0) saveServiceLogs(dir, env); // 스택을 내리기 전에 서비스 로그 저장

    const down = spawnSync(
      "docker",
      [...compose, "down", "-v", "--remove-orphans"],
      { cwd: ROOT, env, encoding: "utf8" },
    );
    fs.writeFileSync(
      path.join(dir, "down.log"),
      `${down.stdout ?? ""}${down.stderr ?? ""}`,
    );

    if (code === 0) {
      console.log(`✓ ${phase.name} 단계 통과`);
      if (!KEEP_LOGS) fs.rmSync(dir, { recursive: true, force: true });
    } else {
      const { summary, detail } = analyze(phase, code, dir);
      console.log(`\n${summary.join("\n")}`);
      failures.push(detail.join("\n"));
      exitCode = exitCode || code;
    }
  }

  if (failures.length > 0) {
    const header = [
      `테스트 실패 보고서 (${new Date().toISOString()})`,
      "=".repeat(60),
      "",
    ];
    fs.writeFileSync(
      path.join(LOG_ROOT, "error.log"),
      `${header.join("\n")}\n${failures.join("\n\n")}\n`,
    );
    console.log(`\n자세한 내용: ${rel(path.join(LOG_ROOT, "error.log"))}`);
    console.log(`원본 로그:   ${rel(LOG_ROOT)}${path.sep}<단계>${path.sep}`);
  } else if (!KEEP_LOGS) {
    fs.rmSync(LOG_ROOT, { recursive: true, force: true });
  }
  process.exit(exitCode);
})();
