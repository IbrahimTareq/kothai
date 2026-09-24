import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The image's client stage has twice been broken by the local build gate
// creeping into it: 8ca5afb had to COPY scripts/ in after lint-tokens.mjs was
// added to `build`, and 765cbf4 added `biome check .`, which failed on 295
// files because biome.json is not in that stage. Neither is caught by CI until
// a release tag runs docker.yml, so assert the coupling here instead.
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const clientStage = dockerfile.slice(
  dockerfile.indexOf('AS client'),
  dockerfile.indexOf('FROM', dockerfile.indexOf('AS client')),
)

test('the client stage runs the bundler, never the gate', () => {
  const lines = clientStage.match(/^RUN .*/gm)
  // A null here means the stage has no RUN at all — which would pass a naive
  // `.filter(...)` check by finding nothing to object to.
  assert.ok(lines, 'the client stage has no RUN lines')
  const scripts = lines
    .filter(line => /pnpm run build/.test(line))
    .map(line => line.match(/pnpm run (\S+)/))
    .map(m => {
      assert.ok(m, 'a `pnpm run` line matched the filter but not the capture')
      return m[1]
    })
  assert.deepEqual(scripts, ['build:client'])
})

test('build:client is the bundler alone', () => {
  assert.equal(pkg.scripts['build:client'], 'vite build')
})

test('build is still the full gate locally', () => {
  assert.match(pkg.scripts.build, /biome check .*lint-tokens.*typecheck.*build:client/)
})
