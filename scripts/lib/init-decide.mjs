/* init-decide — pure setup decisions.
 *
 * Given what the machine looks like and what the user answered, work out which
 * image to run, what belongs in .env, and what to warn about. Deliberately free
 * of I/O so every branch is unit testable: the wizard's job is to stop people
 * downloading 3+ GB of weights onto hardware that cannot execute them, and that
 * guarantee is only worth as much as its test coverage.
 */

export const GB = 1024 ** 3

// Local inference needs roughly 1.5 GB resident at the default residency, so
// 2 GB is the floor and 4 GB is where it stops being uncomfortable.
export const MIN_MEM_LOCAL = 2 * GB
export const WARN_MEM_LOCAL = 4 * GB
// Full image (~2 GB) plus the default weight trio (~3.3 GB), with headroom.
export const MIN_DISK_FULL = 6 * GB
export const MIN_DISK_ANY = 1 * GB

const gb = (bytes) => `${Math.round((bytes / GB) * 10) / 10} GB`

// Can this machine run models on-device at all? Two hard gates, both of which
// otherwise fail *after* a multi-gigabyte download: an x86 CPU without AVX2
// SIGILLs in the llama.cpp kernels, and too little memory gets OOM-killed
// mid-load.
export function capability(probe) {
  if (probe.arch === 'x86_64' && probe.avx2 === false) {
    return { canRunLocal: false, reason: 'this CPU has no AVX2, which the on-device model kernels require' }
  }
  if (probe.memBytes < MIN_MEM_LOCAL) {
    return { canRunLocal: false, reason: `only ${gb(probe.memBytes)} is available to Docker, and on-device models need at least ${gb(MIN_MEM_LOCAL)}` }
  }
  return { canRunLocal: true, reason: null }
}

// Rules in order: disk first because it is a physical limit no answer can
// argue with, then capability. Note that a capable machine gets `latest` even
// when the user picks an external endpoint — remote mode keeps the embedding
// role on-device (server/ai/index.js routes per role; only the language and
// vision roles go out), because most hosted endpoints serve no /embeddings at
// all. So the full image is not merely harmless for an external setup, it is
// what makes semantic search work on one — see the test.
export function chooseImage(probe, answers, flags = {}) {
  if (flags.lite) return 'lite'
  if (probe.diskBytes < MIN_DISK_FULL) return 'lite'
  return capability(probe).canRunLocal ? 'latest' : 'lite'
}

// Only the keys the answers actually imply — an .env full of empty values is
// harder to read than a short one. Credentials live here and nowhere else:
// docs/security.md guarantees the endpoint URL and key are never written to
// SQLite, so they cannot leak through a backup or an export.
export function buildEnv(answers, image) {
  const env = {}
  // The lite image has no @qvac/sdk installed, so `local` would crash on boot.
  env.STASH_AI_PROVIDER = image === 'lite' || answers.ai === 'external' ? 'remote' : 'local'
  if (answers.ai === 'external') {
    if (answers.baseUrl) env.STASH_AI_BASE_URL = answers.baseUrl
    if (answers.apiKey) env.STASH_AI_API_KEY = answers.apiKey
  }
  if (answers.password) env.STASH_PASSWORD = answers.password
  if (answers.port !== 5173) env.PORT = String(answers.port)
  return env
}

// The one entry point the shell calls. Everything it returns is data: the shell
// decides how to print it and what to write, this decides what is true.
export function decide(probe, answers, flags = {}) {
  const warnings = []
  const cap = capability(probe)
  const image = chooseImage(probe, answers, flags)

  // Asking for local on a machine that cannot is not an error worth aborting
  // for — silently degrade to remote and say exactly why.
  const effective = { ...answers }
  if (answers.ai === 'local' && !cap.canRunLocal) {
    effective.ai = 'external'
    warnings.push(`On-device models are unavailable: ${cap.reason}. Configured for an external endpoint instead.`)
  }
  if (image === 'latest' && probe.memBytes < WARN_MEM_LOCAL) {
    warnings.push(`Only ${Math.round((probe.memBytes / GB) * 10) / 10} GB is available to Docker. On-device models will work but may be slow; pick the lighter presets when the app asks.`)
  }
  if (probe.diskBytes < MIN_DISK_FULL) {
    warnings.push(`Less than ${Math.round(MIN_DISK_FULL / GB)} GB free, so the lite image was chosen — it ships no model weights.`)
  }
  if (probe.existingCompose) {
    warnings.push('docker-compose.yml already exists and was left untouched; only .env was written.')
  }

  return {
    image,
    env: buildEnv(effective, image),
    warnings,
    mode: probe.existingDb ? 'update' : 'scaffold',
    writeCompose: !probe.existingCompose,
  }
}
