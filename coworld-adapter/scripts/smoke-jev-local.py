"""Run Jev and starter policies in one local Proxy War episode with mock inference."""

import json
import os
import pathlib
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

repo = pathlib.Path(__file__).resolve().parents[2]
requests = []

class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/v1/systemone'
        assert self.headers['authorization'] == 'Bearer mock'
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        answers = {}
        for name, question in body['questions'].items():
            ids = list(question['criteria'])
            if name == 'action':
                winner = next((id for id in ids if id.startswith('spawn:')), None)
                winner = winner or next((id for id in ids if id != 'hold'), ids[0])
            else:
                winner = 'none'
            answers[name] = {'type': 'choice', 'choice': winner, 'confidence': 1.0,
                             'probabilities': {id: float(id == winner) for id in ids}}
        requests.append((body, answers))
        data = json.dumps({'model': 'mock-jev', 'answers': answers,
                           'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='proxywar-jev-smoke-') as temp:
        wrapper = pathlib.Path(temp) / 'player.mjs'
        wrapper.write_text(
            'const seat = new URL(process.env.COWORLD_PLAYER_WS_URL).searchParams.get("slot");\n'
            f'await import(seat === "0" ? "{repo}/coworld-adapter/src/jev-player.mjs"'
            f' : "{repo}/coworld-adapter/src/starter-player.mjs");\n'
        )
        env = dict(
            os.environ,
            PROXYWAR_REPO=str(repo),
            PROXYWAR_PLAYER_SCRIPT=str(wrapper),
            METTA_CAPTURE_URL=f'http://127.0.0.1:{server.server_port}',
            METTA_CAPTURE_KEY='mock',
            PROXYWAR_SKIP_ROUTE_CHECKS='1',
            GAME_ENV='dev',
        )
        env.pop('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', None)
        env.pop('TYPESAFE_API_KEY', None)
        proc = subprocess.run(
            ['npx', 'tsx', 'coworld-adapter/src/no-docker-coworld-episode.ts'],
            cwd=repo, env=env, capture_output=True, text=True, timeout=180,
        )
        if proc.returncode:
            raise RuntimeError(f'episode failed ({proc.returncode}): {proc.stderr}')
        summary = json.loads(proc.stdout[proc.stdout.rfind('\n{') + 1:])
        results = json.loads(pathlib.Path(summary['resultsPath']).read_text())
        decisions = pathlib.Path(summary['proxyWarArtifactDir']) / 'decisions.jsonl'
        entries = [json.loads(line) for line in decisions.read_text().splitlines()]
        jev = [item for item in entries if item['runtimeMode'] == 'llm-action-selector']
        starter = [item for item in entries if item['runtimeMode'] == 'local-policy-baseline']
        assert len(requests) == len(jev) > 0
        assert starter
        assert all(
            item['result']['accepted'] and not item['fallbackUsed'] and item['externalActionCall']
            for item in jev
        )
        assert results['fallback_count'] == 0
        print(json.dumps({
            'jev_calls': len(requests),
            'jev_accepted': len(jev),
            'starter_accepted': len(starter),
            'fallbacks': results['fallback_count'],
            'results_path': summary['resultsPath'],
        }, indent=2))
finally:
    server.shutdown()
