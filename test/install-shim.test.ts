import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const env = ['KOTHAI_PASSWORD=two words here', 'KOTHAI_SETUP_PROVIDER=local', 'PATH=/usr/bin']
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
  assert.deepEqual(pairs('-e'), ['KOTHAI_PASSWORD=two words here', 'KOTHAI_SETUP_PROVIDER=local'])
  assert.equal(run.at(-1), 'ghcr.io/ibrahimtareq/kothai:latest')
})
