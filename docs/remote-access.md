# Reaching Kothai

Options for accessing Kothai from outside your local network.

## Tailscale (recommended)

Tailscale is the recommended approach. Your devices join a private mesh, so nothing is published to the public internet and running without a password stays a reasonable choice.

The trade-off: every device you browse from needs the Tailscale client installed and signed in. That covers your own phone and laptops. It does not cover someone else's machine.

**Simplest, install on the host:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Kothai is then at `http://<machine>:5173` from anywhere on your tailnet.

**Tidier, run Tailscale as a sidecar.** [`docker-compose.tailscale.yml`](../docker-compose.tailscale.yml) gives Kothai its own tailnet identity and no LAN presence at all:

```bash
echo 'TS_AUTHKEY=tskey-auth-...' > .env    # admin console -> Settings -> Keys
docker compose -f docker-compose.tailscale.yml up -d
```

The app shares the sidecar's network namespace and publishes no ports of its own. [`ts-config/serve.json`](../ts-config/serve.json) puts Tailscale Serve in front, giving you `https://kothai.<your-tailnet>.ts.net` with a real certificate. Enable **DNS -> HTTPS Certificates** for your tailnet first, or the certificate request fails at startup.

At home Tailscale routes directly over the LAN, so the same URL is fast inside the house and works unchanged outside it.

**From a device you can't install a client on** (a borrowed laptop, a hotel PC) you need a genuinely public URL. Tailscale Funnel (add `"AllowFunnel"` to `serve.json`) is the quickest route. Cloudflare Tunnel with Access in front is the safer one, because unauthenticated requests never reach your machine.
