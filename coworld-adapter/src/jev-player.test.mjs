import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const { WebSocketServer } = createRequire(import.meta.url)(
  `${repoRoot}/node_modules/ws`,
);

function action(id, kind) {
  return { id, kind, label: id, risk: { level: "low", score: 0.1 } };
}

async function playerReply(request, choose, useMock = true) {
  const calls = [];
  const http = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/systemone");
    assert.equal(req.headers.authorization, "Bearer mock");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, question]) => {
        const ids = Object.keys(question.criteria);
        const winner = choose(name, ids);
        assert.ok(ids.includes(winner));
        const probabilities = Object.fromEntries(
          ids.map((id) => [id, Number(id === winner)]),
        );
        return [
          name,
          {
            type: "choice",
            choice: winner,
            confidence: 1,
            probabilities,
          },
        ];
      }),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "mock-jev",
        answers,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
    );
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const childEnv = {
    ...process.env,
    PROXYWAR_REPO: repoRoot,
    COWORLD_PLAYER_WS_URL: `ws://127.0.0.1:${wss.address().port}`,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${http.address().port}`,
  };
  delete childEnv.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
  delete childEnv.METTA_CAPTURE_URL;
  if (useMock) childEnv.TYPESAFE_API_KEY = "mock";
  else delete childEnv.TYPESAFE_API_KEY;
  const child = spawn(process.execPath, [path.join(here, "jev-player.mjs")], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const reply = new Promise((resolve, reject) => {
    wss.once("connection", (socket) => {
      socket.send(JSON.stringify(request));
      socket.once("message", (data) => {
        resolve(JSON.parse(String(data)));
        socket.close();
      });
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Jev exited ${code} before response: ${stderr}`)),
    );
  });
  let timeout;
  try {
    const response = await Promise.race([
      reply,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Jev response timed out: ${stderr}`)),
          8000,
        );
      }),
    ]);
    clearTimeout(timeout);
    return { response, calls };
  } finally {
    clearTimeout(timeout);
    child.kill();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  }
}

function request(legalActions, protocol) {
  return {
    type: "decision_request",
    requestID: "req_1",
    slot: 0,
    protocol,
    request: { observation: { ownState: { playerID: "P_A" } }, legalActions },
  };
}

test("Jev ranks offered spawn preferences", async () => {
  const actions = [action("spawn:1", "spawn"), action("spawn:2", "spawn")];
  const { response, calls } = await playerReply(
    request(actions, { maxSpawnPreferences: 16 }),
    (_, ids) => ids[1],
  );
  assert.equal(response.selectedLegalActionId, "spawn:2");
  assert.deepEqual(response.spawnPreferenceLegalActionIds, [
    "spawn:2",
    "spawn:1",
  ]);
  assert.equal(response.runtimeMode, "llm-action-selector");
  assert.equal(response.fallbackUsed, undefined);
  assert.equal(response.providerEvidence.callKind, "action");
  assert.equal(response.providerEvidence.inputTokens, 1);
  assert.deepEqual(Object.keys(calls[0].questions), ["action"]);
});

test("Jev uses offered action, deal, and message slots", async () => {
  const actions = [
    action("hold", "hold"),
    action("attack:1", "attack"),
    action("build:1", "build"),
    action("deal_accept:1", "deal_accept"),
    action("message:P_B", "message"),
  ];
  const { response, calls } = await playerReply(
    request(actions, { maxActionsPerDecision: 5, maxMessageChars: 280 }),
    (name, ids) => (name === "action" ? "attack:1" : ids[1]),
  );
  assert.equal(response.selectedLegalActionId, "attack:1");
  assert.equal(response.selectedDealActionId, "deal_accept:1");
  assert.equal(response.selectedMessageActionId, "message:P_B");
  assert.ok(response.messageText.length <= 280);
  assert.deepEqual(Object.keys(calls[0].questions), [
    "action",
    "deal",
    "message",
  ]);
  assert.deepEqual(Object.keys(calls[0].questions.action.criteria), [
    "hold",
    "attack:1",
    "build:1",
  ]);
});

test("Jev reports a legal fallback when no transport is available", async () => {
  const { response, calls } = await playerReply(
    request([action("hold", "hold"), action("attack:1", "attack")], {
      maxActionsPerDecision: 5,
    }),
    () => "hold",
    false,
  );
  assert.equal(response.selectedLegalActionId, "hold");
  assert.equal(response.fallbackUsed, true);
  assert.equal(response.llmPlannerDegraded, true);
  assert.equal(response.degradedCause, "policy-error");
  assert.equal(response.providerEvidence, undefined);
  assert.equal(calls.length, 0);
});
