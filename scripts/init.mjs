#!/usr/bin/env node
/* init — the setup wizard.
 *
 * Probe the machine, ask at most three questions, write .env (and a compose file
 * if none exists), start the stack, and confirm it is actually serving before
 * claiming success. Model selection is deliberately absent: client/views/
 * Onboarding.tsx already does it with live sizes and a progress bar, and two
 * copies of the preset list would drift.
 *
 * Run: node scripts/init.mjs [--dry-run] [--lite]
 */
import { createInterface } from 'node:readline/promises'
import { writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { probe } from './lib/init-probe.mjs'
import { decide, capability } from './lib/init-decide.mjs'

const flags = { dryRun: process.argv.includes('--dry-run'), lite: process.argv.includes('--lite') }
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''} `)).trim() || def || ''

// A numbered menu instead of free text — less to get wrong than typing an
// exact word. Blank or unrecognized input silently falls back to the
// default, matching ask()'s behavior.
const askChoice = async (question, options, defaultIndex) => {
  console.log(question)
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`))
  const raw = await rl.question(`Choice [${defaultIndex + 1}]: `)
  const n = parseInt(raw.trim(), 10)
  const i = Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defaultIndex
  return options[i].value
}

const COMPOSE = (image, port) => `services:
  kothai:
    image: ghcr.io/ibrahimtareq/kothai:${image}
    container_name: kothai
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    volumes:
      - ./data:/app/data${image === 'lite' ? '' : '\n      - ./models:/app/models'}
    env_file: .env
`

async function main() {
  const p = probe()
  if (!p.dockerOk) fail('Docker is not running or not installed — https://docs.docker.com/get-docker/')
  if (!p.composeV2) fail('Docker Compose v2 is required. `docker compose version` must work.')
  if (p.diskBytes < 1024 ** 3) fail(`Less than 1 GB free on this directory — Kothai needs room for its database and uploads.`)

  const cap = capability(p)
  console.log(`\n  ${p.arch}${p.avx2 === false ? ' (no AVX2)' : ''} · ${(p.memBytes / 1024 ** 3).toFixed(1)} GB available to Docker · ${(p.diskBytes / 1024 ** 3).toFixed(0)} GB free`)
  console.log(`  On-device models: ${cap.canRunLocal ? 'supported' : `unavailable — ${cap.reason}`}\n`)
  if (p.existingDb) console.log('  Existing install detected. Your data and models will not be touched.\n')

  const ai = await askChoice('Where should AI run?', [
    { label: 'local', value: 'local' },
    { label: 'external', value: 'external' },
    { label: 'none', value: 'none' },
  ], cap.canRunLocal ? 0 : 1)

  let baseUrl = null, apiKey = null
  if (ai === 'external') {
    baseUrl = await ask('  OpenAI-compatible endpoint URL', 'http://ollama:11434/v1')
    apiKey = (await ask('  API key (blank for Ollama or llama.cpp)', '')) || null
  }

  const wantPw = await askChoice('Set a password?', [
    { label: 'yes', value: true },
    { label: 'no', value: false },
  ], 0)
  const password = wantPw ? randomBytes(24).toString('base64url') : null

  let port = 5173
  if (!p.portFree) {
    port = parseInt(await ask('Port 5173 is in use. Use which port instead?', '5273'), 10) || 5273
  }

  const d = decide(p, { ai, baseUrl, apiKey, password, port }, flags)
  const envText = Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'

  console.log(`\n  Image:  ghcr.io/ibrahimtareq/kothai:${d.image}`)
  console.log(`  Writes: .env${d.writeCompose ? ', docker-compose.yml' : ''}`)
  for (const w of d.warnings) console.log(`  Note:   ${w}`)

  if (flags.dryRun) {
    console.log(`\n--- .env ---\n${envText}`)
    if (d.writeCompose) console.log(`--- docker-compose.yml ---\n${COMPOSE(d.image, port)}`)
    return rl.close()
  }

  let skipWrite = false
  if (existsSync('.env')) {
    console.log()
    const overwrite = await askChoice('.env exists. Overwrite?', [
      { label: 'yes', value: true },
      { label: 'no', value: false },
    ], 1)
    skipWrite = !overwrite
  }

  if (skipWrite) {
    console.log('\n  Keeping existing .env. Starting with your current configuration…')
  } else {
    writeFileSync('.env', envText, { mode: 0o600 })
    if (d.writeCompose) writeFileSync('docker-compose.yml', COMPOSE(d.image, port))
    if (existsSync('.gitignore') && !readFileSync('.gitignore', 'utf8').includes('.env')) appendFileSync('.gitignore', '\n.env\n')
  }

  rl.close()
  console.log('\n  Starting…')
  try {
    execFileSync('docker', ['compose', 'up', '-d'], { stdio: 'inherit' })
  } catch {
    fail('`docker compose up -d` failed — see the output above.')
  }
  await waitHealthy(port)

  console.log(`\n  Ready — http://localhost:${port}`)
  if (password) console.log(`  Password: ${password}   (shown once; it is in .env)`)
  console.log('  Open it to choose your models.\n')
}

// Liveness only. /api/health sits in front of the password gate, so this works
// whether or not one was set. On failure print the container's own logs — a
// wait loop that reports nothing but "timed out" sends you diagnosing the
// wrong thing, which is exactly how the release smoke test stayed broken for
// months.
async function waitHealthy(port) {
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return
    } catch {}
    process.stdout.write(`\r  waiting for the server… ${i * 2}s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.error('\n  Server did not become healthy. Container logs:\n')
  try { execFileSync('docker', ['compose', 'logs', '--tail', '40'], { stdio: 'inherit' }) } catch {}
  process.exit(1)
}

function fail(msg) {
  console.error(`\n  ${msg}\n`)
  rl.close()
  process.exit(1)
}

main()
