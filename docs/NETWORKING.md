# Networking patterns

How to connect a worker on machine B to a hub on machine A — from same-LAN
through public VPS.

The hub listens on two TCP ports:
- **8080** — WebSocket for workers (`ws://hub:8080`)
- **3000** — HTTP for MCP clients (`http://hub:3000`)

Both ports must be reachable from the clients that use them. Pick a pattern
below based on trust and network topology.

---

## 1. Same LAN (home / office)

Simplest case. Both machines on the same subnet.

```
your laptop (hub + MCP client) ──LAN──► server (worker)
    192.168.1.5:8080                     192.168.1.12
```

**Setup:**
- Open 8080 in the hub's OS firewall (`sudo ufw allow 8080/tcp` or macOS System Settings)
- On the worker: `HUB_URL=ws://192.168.1.5:8080`

Find the hub's LAN IP: `hostname -I` (Linux) / `ipconfig getifaddr en0` (macOS).

**Add TLS?** Not strictly required on your own LAN, but the next section shows how.

---

## 2. Across the internet — Tailscale (recommended)

Best-in-class for personal / small-team setups. Zero firewall config, end-to-end
encrypted, identity-based auth.

```bash
# On both machines:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Each machine gets a `100.x.y.z` IP or a `*.ts.net` hostname. Use that as the
hub URL:

```bash
# On the worker:
HUB_URL=ws://raspberry-pi.tailnet-abc.ts.net:8080
```

No public ports, no DNS records, no TLS certificates. Tailscale handles it all
at the network layer.

---

## 3. Across the internet — VPS with reverse proxy + TLS

If you want a public hub (e.g. hub on a DigitalOcean droplet, workers on
various machines), front it with Caddy or nginx for TLS.

### Caddy (simplest)

`/etc/caddy/Caddyfile`:
```
hub.example.com {
    # MCP clients
    reverse_proxy /mcp* localhost:3000

    # Workers — WebSocket upgrade
    reverse_proxy /ws* localhost:8080
}
```

Workers: `HUB_URL=wss://hub.example.com/ws`
MCP clients: `url: "https://hub.example.com/mcp"`

Note: the hub's HTTP server doesn't natively serve under a path prefix.
Easier pattern: use subdomains.

### Caddy subdomain pattern

```
mcp.example.com { reverse_proxy localhost:3000 }
ws.example.com  { reverse_proxy localhost:8080 }
```

Workers: `HUB_URL=wss://ws.example.com`
MCP clients: `url: "https://mcp.example.com"`

Caddy issues and renews LetsEncrypt certificates automatically.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name ws.example.com;
    ssl_certificate     /etc/letsencrypt/live/ws.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ws.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # keep-alive through idle periods
    }
}
```

---

## 4. Public hub, private workers — NAT traversal

Workers sit behind home routers / corporate NAT, hub is on a public VPS.
This is the default case when you want to access your home machine remotely.

**Just works.** WebSocket is a client-initiated connection, so workers dial out
to the hub — no inbound ports needed on the worker's side. The hub only needs
8080 (or 443 via reverse proxy) reachable from the internet.

---

## 5. Air-gapped

No internet, no Telegram, no metrics shipping.

```bash
# hub/.env
AIRGAP=1
# BOT_TOKEN MUST be unset
AUDIT_NETWORK=1  # optional — log any accidental outbound attempt
```

With `AIRGAP=1` the hub refuses every non-loopback outbound connection. The CLI
`net` command shows you nothing slipped through.

---

## Firewall cheatsheet

| OS | Open port 8080 |
|----|-----------------|
| Ubuntu/Debian (ufw) | `sudo ufw allow 8080/tcp` |
| RHEL/Fedora (firewalld) | `sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload` |
| macOS | System Settings → Network → Firewall → Options → allow `node` |
| Cloud VPS | Open the security-group / VPC rule too |

---

## Pairing across a restricted network

The pair code is one-time and short-lived (10 min). If your network blocks
the hub's port, you can still bootstrap over a temporary SSH tunnel:

```bash
# On the worker machine:
ssh -L 8080:localhost:8080 user@hub.example.com
# Now ws://localhost:8080 on the worker → hub's 8080
HUB_URL=ws://localhost:8080 ./add-worker.sh
```

After pairing, credentials persist. Drop the tunnel and set `HUB_URL` to the
real address for subsequent connects.

---

## Service discovery (LAN)

`./add-worker.sh` runs a 3-second mDNS scan if `dns-sd` (macOS) or
`avahi-browse` (Linux) is installed. If your hub is already announced by
another mDNS tool it'll show up. Otherwise the script falls back to asking
for the hub URL.

Native mDNS broadcast from the hub is on the roadmap — for now, rely on the
hub's LAN IP or a DNS record.
