import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// release-please builds CHANGELOG.md from conventional-commit subjects and
// drops anything that does not parse — silently, with the entry simply absent
// from the release notes. Both guards against that (the commit-msg hook and the
// ci.yml backstop) shell out to this one config, so if the config is lost or
// stops rejecting bad subjects, both go quietly dead at once. Assert it here,
// where `pnpm test` will notice.
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const cli = join(root, 'node_modules/.bin/commitlint')

function lint(message: string): number {
  // Without this, a missing binary throws ENOENT, which carries no `status` —
  // `lint()` would return undefined and the "is rejected" assertion below would
  // pass for entirely the wrong reason.
  assert.ok(existsSync(cli), 'commitlint is not installed — run pnpm install')
  try {
    execFileSync(cli, [], {
      cwd: root,
      input: message,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return 0
  } catch (err) {
    return (err as { status: number }).status
  }
}

test('the conventional config is wired into package.json', () => {
  assert.deepEqual(pkg.commitlint?.extends, ['@commitlint/config-conventional'])
})

test('a non-conventional subject is rejected', () => {
  // f7d81be, a real subject from before the convention landed.
  assert.notEqual(lint('Drop the trybehold.com attribution from the design system'), 0)
})

test('a conventional subject is accepted', () => {
  assert.equal(lint('feat(changelog): generate release notes with release-please'), 0)
})

test("release-please's own release commit is accepted", () => {
  // The bot commits this on every release, and ci.yml lints it on the tag
  // push that follows. Rejecting it would fail the release build itself.
  assert.equal(lint('chore(main): release 1.4.0'), 0)
})
