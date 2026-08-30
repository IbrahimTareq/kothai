# Verifying a build on an x86-64 VPS

Kothai's development happens on Apple Silicon and its self-hosting story has
been Raspberry-Pi-first, so the arm64 image is exercised constantly and the
amd64 one mostly is not. That matters because x86 is where the rest of
self-hosting lives: Hetzner, Coolify, Dokploy, Railway, and any rented box in a
future fleet.

The image bundles native prebuilds — llama.cpp, onnx, rocksdb — and native code
fails on an untested CPU in two ways that are quiet enough to miss:

- **Illegal instruction.** A prebuild compiled for a wider SIMD level than the
  CPU implements dies the moment it is loaded. This project already carries a
  workaround for the arm64 version of exactly this (`@qvac/translation-nmtcpp`
  is compiled with SVE and SIGILLs on Pi and Apple Silicon, so the Dockerfile
  swaps its binding for a JS stub). The amd64 equivalent is a prebuild that
  assumes AVX-512 on a shared vCPU that only has AVX2.
- **OOM during model load.** The first load pulls ~1.3 GB of weights and needs
  headroom to map them. On a box that is too small the kernel kills the
  process, Docker restarts it, and it downloads again — a restart loop that
  looks like a network problem rather than a memory one.

Neither produces a `docker run` failure you would notice in passing, so
`scripts/vps-smoke.sh` looks for both directly.

## Pick the box

**Hetzner CX32** (4 vCPU / 8 GB, ~€6/mo) for the full image. **Not CX22** — its
4 GB will OOM partway through the model load and produce exactly the restart
loop described above.

Any provider is fine as long as the vCPU is x86-64 with AVX2. Deliberately
choose a box *without* AVX-512: nearly all shared vCPUs lack it, so a box that
has it proves less than one that does not. Hetzner's CAX line is ARM — that
tests the other image.

For the lite image, 2 GB is enough; it has no native dependencies at all, so it
is arch-independent by construction and mostly needs a sanity check rather than
a real verification.

## Build and push an amd64 image

The published `:latest` is multi-arch, but when verifying an unreleased change
you want the image built from your working tree:

```bash
docker buildx build --platform linux/amd64 -t kothai:amd64-check --load .
docker save kothai:amd64-check | ssh root@YOUR_VPS docker load
```

Or push to a registry and pull on the box. Building *on* the VPS also works and
avoids the transfer, but wants a few GB of RAM for the pnpm install — the
Dockerfile already caps `--network-concurrency` at 4 for that reason.

## Run it

```bash
apt-get update && apt-get install -y curl jq
scp scripts/vps-smoke.sh root@YOUR_VPS:/root/
ssh root@YOUR_VPS 'bash /root/vps-smoke.sh --image kothai:amd64-check'
```

It prints a pass/fail line per check and exits non-zero if anything failed.

| Flag | Effect |
|---|---|
| `--image REF` | Image to test (default `ghcr.io/ibrahimtareq/kothai:latest`) |
| `--port N` | Host port for the main container (default 5173; the auth container uses N+1) |
| `--skip-models` | Skip the weight download and inference — fast, but skips the part that actually exercises the native prebuilds |
| `--lite` | Test the lite image (implies `--skip-models`, no models volume) |
| `--keep` | Leave the containers and temp directory in place for poking at |

Budget 20–30 minutes for a full run; almost all of it is the weight download.

## What it checks

**Host** — x86-64, AVX2 present, AVX-512 reported for information, RAM against
the profile being tested, free disk, and the tools it needs.

**Image** — that the thing you are testing is actually `amd64` and not an arm64
image pulled by a multi-arch manifest matching your laptop.

**Boot** — container starts, `/api/health` answers, the container was not
OOM-killed, the logs contain no illegal-instruction or loader crash, and
Docker's own healthcheck reaches `healthy`.

**Core API** — saves a note and reads it back, then saves a link and waits for
its title. That last one is not busywork: the SSRF guard resolves hostnames
before fetching, and a container whose DNS behaves differently from the host's
would reject every real link and present as "link previews are broken".

**Backup** — downloads `/api/backup`, checks the SQLite header, runs
`PRAGMA integrity_check` using the node inside the image (so the host needs no
`sqlite3`), and confirms the temp snapshot was cleaned up.

**Password gate** — starts a second container with `STASH_PASSWORD` set and
confirms the API returns 401 without a session and 200 after logging in. It
also waits for Docker's healthcheck on *that* container, which is the check
worth having: the healthcheck carries no credentials, so if it ever pointed at
a gated endpoint again, every orchestrator would mark the container unhealthy
and restart-loop it. That is a failure mode you would only ever see with a
password set.

**Local inference** — drives the first-run model picker (a fresh install
downloads nothing until models are chosen, so this has to be done explicitly),
waits for the LLM to reach `ready`, re-checks for OOM and illegal instructions
now that the native code has actually run, and asks a question.

## When something fails

**`CPU has AVX2` fails** — wrong box. Nothing else will pass either.

**Illegal instruction in the logs** — find which prebuild by running the
container with `--entrypoint sh` and loading the addons one at a time. The fix
follows the existing pattern in the Dockerfile: drop that package's
`prebuilds/` directory and substitute a stub, or pin to a version built for a
narrower instruction set.

**OOM during model load** — check `docker inspect -f '{{.State.OOMKilled}}'`.
If true on an 8 GB box, try a smaller LLM preset (`QWEN3_600M_INST_Q4`) to
establish whether it is the model or the loader.

**`LLM reached ready` times out with no crash** — usually the download, not the
CPU. `docker logs` shows the progress; re-run with a longer `MODEL_TIMEOUT`.

**Healthcheck unhealthy only on the authed container** — `/api/health` has
stopped being public. See `server/router.js`, where it sits deliberately ahead
of the password gate.
