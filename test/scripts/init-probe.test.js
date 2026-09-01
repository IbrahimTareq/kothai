// Unit tests for the pure parsers in scripts/lib/init-probe.mjs. These read
// real command output shapes — /proc/cpuinfo, `docker info`, `docker stats` —
// which is exactly where a silent misparse would send the wizard's advice
// wrong without ever throwing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAvx2, parseDockerMemTotal, parseDockerStatsUsed } from '../../scripts/lib/init-probe.mjs'

test('AVX2 is found in a Linux /proc/cpuinfo flags line', () => {
  assert.equal(parseAvx2('flags\t\t: fpu vme de pse tsc msr pae mce cx8 avx avx2 bmi2'), true)
})

test('a Gemini Lake Celeron reports no AVX2 even though it has AVX', () => {
  assert.equal(parseAvx2('flags\t\t: fpu vme de pse tsc msr sse4_1 sse4_2 avx'), false)
})

test('macOS sysctl output is matched case-insensitively', () => {
  assert.equal(parseAvx2('AVX1.0 AVX2 BMI1 BMI2 SMEP'), true)
})

test('docker info MemTotal is read from the json form', () => {
  assert.equal(parseDockerMemTotal('{"MemTotal":8318976000,"NCPU":14}'), 8318976000)
})

test('unparseable docker info yields null rather than a wrong number', () => {
  assert.equal(parseDockerMemTotal('not json'), null)
})

test('docker stats usage sums across mixed units', () => {
  const out = '1.4GiB / 7.75GiB\n512MiB / 7.75GiB\n8KiB / 7.75GiB\n'
  const used = parseDockerStatsUsed(out)
  // 1.4 GiB + 512 MiB + 8 KiB
  assert.equal(Math.round(used / (1024 ** 2)), Math.round(1.4 * 1024 + 512 + 8 / 1024))
})

test('empty docker stats output is zero, not NaN', () => {
  assert.equal(parseDockerStatsUsed(''), 0)
})
