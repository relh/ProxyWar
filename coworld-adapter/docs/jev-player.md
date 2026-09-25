# Jev player for Proxy War

`src/jev-player.mjs` is an optional player policy for the existing Coworld
websocket contract. It reads the seat observation and exact offered
`LegalAction.id` values. The game still owns observations, action validation,
rules, results, and replay. The bundled starter and other player runtimes remain
available.

The policy asks System One to rank a bounded menu of primary actions. It sends
one primary action per decision. It also ranks the separate spawn ballot and,
when offered, the independent deal and message slots. Messages use fixed,
non-sensitive text templates. Provider failures produce an offered legal action
with `fallbackUsed`, `llmPlannerDegraded`, and `degradedCause` attribution.
Successful model calls carry bounded provider evidence for decision accounting.

The runnables image includes the player at
`/app/integration/src/jev-player.mjs`. Select that script in a player manifest's
`run` command to use Jev; the default image command still starts the scripted
player. Local direct calls use `TYPESAFE_API_KEY`, with optional
`TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`. Hosted calls use
`AWS_ENDPOINT_URL_BEDROCK_RUNTIME`. `METTA_CAPTURE_URL` and
`METTA_CAPTURE_KEY` select an explicit capture transport for local tests.

Local checks:

```bash
npm run inst
npx vitest run coworld-adapter/src/jev-player.test.mjs coworld-adapter/src/starter-player.test.ts
python3 coworld-adapter/scripts/smoke-jev-local.py
docker build --platform linux/amd64 -f coworld-adapter/Dockerfile.runnables -t proxywar-jev-runnables:local coworld-adapter
docker run --rm --platform linux/amd64 --entrypoint node proxywar-jev-runnables:local --check /app/integration/src/jev-player.mjs
```

The local episode smoke uses a mock System One endpoint and two seats, one Jev
and one starter. It checks the private decision artifact for accepted Jev
actions, no fallback, and the normal results file. It does not measure real
model quality or cost.
