import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 76aaa35 put `\'` inside a single-quoted printf. sh has no escapes there, so
// the published installer stopped parsing and every `curl | sh` died on line
// 146 before doing anything. Nothing ran the script, so nothing noticed.
test('the installer parses', () => {
  execFileSync('sh', ['-n', fileURLToPath(new URL('../site/public/install.sh', import.meta.url))])
})

// `kothai update` recreates the container from what `docker inspect` reports.
// It used to word-split that report, so a data directory under a path with a
// space (every macOS "My Drive"-style folder) or a password containing one
// came back as a broken `docker run`, after the old container was already gone.
const installer = readFileSync(new URL('../site/public/install.sh', import.meta.url), 'utf8')
const body = installer.match(/<<'SHIM_BODY'\n([\s\S]*?)\nSHIM_BODY\n/)?.[1]

// Answers the handful of `docker` calls the shim makes, rendering the range
// templates it passes the way Go's text/template would, and records the final
// `docker run` argv as JSON.
const fakeDocker = `#!${process.execPath}
const fs = require('fs')
const a = process.argv.slice(2)
const mounts = [
  { Source: '/Users/me/My Stuff/models', Destination: '/app/models' },
  { Source: '/Users/me/My Stuff/data', Destination: '/app/data' },
]
const env = ['KOTHAI_PASSWORD=two words here', 'KOTHAI_SETUP_PROVIDER=openai', 'PATH=/usr/bin']
const range = (t, items) => {
  const b = t.match(/\\{\\{range [^}]+\\}\\}([\\s\\S]*)\\{\\{end\\}\\}$/)[1]
  return items.map(i => b
    .replace(/\\{\\{println \\.\\}\\}/g, i + '\\n')
    .replace(/\\{\\{println\\}\\}/g, '\\n')
    .replace(/\\{\\{\\.Source\\}\\}/g, i.Source)
    .replace(/\\{\\{\\.Destination\\}\\}/g, i.Destination)).join('')
}
if (a[0] === 'ps') process.stdout.write('kothai\\n')
else if (a[0] === 'inspect') {
  const t = a[2]
  if (t.includes('if eq .Destination')) process.stdout.write(mounts[1].Source)
  else if (t.includes('range .Mounts')) process.stdout.write(range(t, mounts))
  else if (t.includes('range .Config.Env')) process.stdout.write(range(t, env))
  else if (t.includes('Config.Image')) process.stdout.write('ghcr.io/ibrahimtareq/kothai:latest\\n')
  else if (t.includes('HostPort')) process.stdout.write('5173\\n')
  else if (t.includes('RestartPolicy')) process.stdout.write('unless-stopped\\n')
  else if (t.includes('State.Running')) process.stdout.write('true\\n')
} else if (a[0] === 'run') fs.writeFileSync(process.env.RUN_LOG, JSON.stringify(a))
`

test('kothai update carries mounts and env through intact, spaces and all', () => {
  assert.ok(body, 'could not find the shim body in install.sh')
  const dir = mkdtempSync(join(tmpdir(), 'kothai-shim-'))
  const shim = join(dir, 'kothai')
  writeFileSync(shim, `#!/bin/sh\nset -eu\nNAME=kothai\n${body}\n`)
  writeFileSync(join(dir, 'docker'), fakeDocker)
  writeFileSync(join(dir, 'curl'), '#!/bin/sh\nexit 0\n')
  for (const f of ['kothai', 'docker', 'curl']) chmodSync(join(dir, f), 0o755)

  const log = join(dir, 'run.json')
  execFileSync('sh', [shim, 'update'], {
    env: { PATH: `${dir}:/usr/bin:/bin`, RUN_LOG: log, HOME: dir },
    stdio: 'pipe',
  })
  const run: string[] = JSON.parse(readFileSync(log, 'utf8'))

  const pairs = (flag: string) => run.flatMap((v, i) => (v === flag ? [run[i + 1]] : []))
  assert.deepEqual(pairs('-v'), ['/Users/me/My Stuff/models:/app/models', '/Users/me/My Stuff/data:/app/data'])
  assert.deepEqual(pairs('-e'), ['KOTHAI_PASSWORD=two words here', 'KOTHAI_SETUP_PROVIDER=openai'])
  assert.equal(run.at(-1), 'ghcr.io/ibrahimtareq/kothai:latest')
})

// The installer used to offer an on-device models option and pass
// KOTHAI_SETUP_PROVIDER=local for it. On-device models are gone, so a fresh
// install must never claim that provider, and --local must say why it is dead
// instead of silently starting a container that can do nothing.
const installerPath = fileURLToPath(new URL('../site/public/install.sh', import.meta.url))

function runInstaller(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'kothai-install-'))
  const log = join(dir, 'run.json')
  writeFileSync(
    join(dir, 'docker'),
    `#!${process.execPath}
const a = process.argv.slice(2)
if (a[0] === 'run') require('fs').writeFileSync(process.env.RUN_LOG, JSON.stringify(a))
`,
  )
  for (const name of ['curl', 'open', 'xdg-open']) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
  for (const f of ['docker', 'curl', 'open', 'xdg-open']) chmodSync(join(dir, f), 0o755)
  // detached drops the controlling terminal, so a developer's tty cannot make
  // the installer stop and ask a question mid-test.
  const r = spawnSync('sh', [installerPath, '--no-shim', '--dir', join(dir, 'home'), ...args], {
    env: { PATH: `${dir}:/usr/bin:/bin`, RUN_LOG: log, HOME: dir, LANG: 'C' },
    encoding: 'utf8',
    detached: true,
    input: '',
  })
  const run: string[] | null = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null
  return { status: r.status, output: r.stdout + r.stderr, run }
}

test('--local exits non-zero and points at Ollama', () => {
  const r = runInstaller(['--local'])
  assert.notEqual(r.status, 0)
  assert.match(
    r.output,
    /On-device models were removed in v2\. Install Ollama and pick it during setup: https:\/\/getkothai\.com\/docs\/how-it-works\/models/,
  )
  assert.equal(r.run, null, 'must fail before starting a container')
})

test('--lite is an accepted no-op: same container as no flag', () => {
  const plain = runInstaller([])
  const lite = runInstaller(['--lite'])
  assert.equal(lite.status, 0)
  assert.equal(plain.status, 0)
  // The temp --dir differs per run, so compare the argv with it masked out.
  const mask = (run: string[] | null) => run?.map(v => v.replace(/^.*\/home\//, '<dir>/'))
  assert.deepEqual(mask(lite.run), mask(plain.run))
})

test('a fresh install never emits KOTHAI_SETUP_PROVIDER=local', () => {
  // The prompt only runs on a terminal, which the runs below cannot have, so
  // the source is checked for the one path that could still set it.
  assert.ok(!/PROVIDER=local/.test(installer), 'install.sh can still set PROVIDER=local')
  for (const args of [[], ['--lite'], ['--endpoint', 'http://ollama:11434/v1']]) {
    const { run } = runInstaller(args)
    assert.ok(run, 'installer should have run docker')
    assert.ok(!run.some(v => v.includes('KOTHAI_SETUP_PROVIDER=local')), `${args} emitted provider=local`)
  }
})

test('the installer no longer mounts a models directory or sets the provider env', () => {
  const { run } = runInstaller(['--endpoint', 'http://ollama:11434/v1'])
  assert.ok(run)
  assert.ok(!run.some(v => v.includes('/app/models')))
  assert.ok(!run.some(v => v.startsWith('KOTHAI_AI_PROVIDER')))
})
