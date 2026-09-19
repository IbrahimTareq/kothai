# More ways to start

## Build from source

Instead of pulling the published image, uncomment `build: .` in `docker-compose.yml`, then:

```bash
docker compose up -d --build
```

## Bare metal

No container:

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
pnpm start
```
