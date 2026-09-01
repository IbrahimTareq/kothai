/* init-probe — what this machine can actually do.
 *
 * The parsers are separated from the commands that feed them because parsing is
 * where this quietly goes wrong: `docker stats` mixes B, KiB, MiB and GiB in one
 * column, and a misparse here would tell someone their NAS is fine right before
 * it OOMs. The impure probe() at the bottom is a thin shell over them.
 *
 * Memory deliberately comes from the Docker daemon, never the host: on Docker
 * Desktop a 24 GB Mac routinely gives the daemon 8 GB, and the host figure would
 * cheerfully report "plenty" in exactly the case that fails.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { arch } from 'node:os'

export function parseAvx2(text) {
  return /\bavx2\b/i.test(text)
}

export function parseDockerMemTotal(json) {
  try {
    const v = JSON.parse(json).MemTotal
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 }

// Each line looks like "1.4GiB / 7.75GiB"; only the first figure is this
// container's usage. Unknown units are skipped rather than guessed.
export function parseDockerStatsUsed(text) {
  let total = 0
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([\d.]+)\s*([A-Za-z]+)\s*\//)
    if (!m) continue
    const unit = UNITS[m[2].toLowerCase()]
    if (unit) total += parseFloat(m[1]) * unit
  }
  return total
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function cpuFlagText() {
  if (existsSync('/proc/cpuinfo')) return readFileSync('/proc/cpuinfo', 'utf8')
  return run('sysctl', ['-n', 'machdep.cpu.leaf7_features']) ?? ''
}

export function probe(dir = process.cwd(), port = 5173) {
  const a = arch() === 'arm64' ? 'arm64' : 'x86_64'
  const info = run('docker', ['info', '--format', '{{json .}}'])
  const memTotal = info ? parseDockerMemTotal(info) : null
  const used = parseDockerStatsUsed(run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}']) ?? '')
  let diskBytes = 0
  try {
    const fs = statfsSync(dir)
    diskBytes = fs.bavail * fs.bsize
  } catch { diskBytes = 0 }

  return {
    arch: a,
    // The question is meaningless on arm64, where NEON is guaranteed.
    avx2: a === 'arm64' ? null : parseAvx2(cpuFlagText()),
    memBytes: memTotal === null ? 0 : Math.max(0, memTotal - used),
    diskBytes,
    dockerOk: info !== null,
    composeV2: run('docker', ['compose', 'version']) !== null,
    existingDb: existsSync(`${dir}/data/kothai.db`),
    existingCompose: existsSync(`${dir}/docker-compose.yml`),
    portFree: run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']) === null,
  }
}
