<img width="1866" height="1080" alt="Screenshot 2026-04-08 at 09-01-09 Zcash Solo Pool Dashboard" src="https://github.com/user-attachments/assets/86bdbb09-3dd6-4137-836b-88f5a4b5aa27" />

# ZcashSoloPool

I was in search of a solo mining project and found that none were working, mainly due to ZcashD deprecation and other dependency issues. I built this from scratch for Zebrad node only, in mind for the home/hobby miner and to learn how it all works. I spent several months working on it as I could. The first block found with this software was block#3267605, I have about 750ksols in my hobby farm.

- Not inteneded for large scale, although it can handle a large number of miners
- No pay system, pays to only one address configured in the Zebrad.toml
- Do not expsose to the ineternet unless you know what you are doing, there is some stratum hardning built in

For guides and information check my website https://zcashsolomining.com/

There are no dev fees, if this works for you, please consider a donation to support my work.

- ZCASH: t1SP4j14QSh9LJp3vKMgk7Lqqad8bL93AUT

- BTC: bc1q9raqlpk0h3kgapd695mwys049wpg3klrc3gds7

- ETH: 0xC423754eF14fC163c61E152162C78df531811426

- DOGE: DRLFCoTGAED9ByE8Rrdg4D7Z64tzNWBN5G


## Node.js Zcash solo mining pool with:
- local share validation (`equihashverify` native module),
- ZIP-301 style Stratum flow for ASIC compatibility,
- VarDiff,
- block submit de-duplication,
- built-in JSON API for stats/miners/network/job,
- built-in Web GUI (served from `./webgui`, auto-wired to the API),
- persisted pool state across restarts (block history, best share, counts).


## Features

- Local share verification (no trusted remote share checker).
- Zcash RPC cookie authentication.
- Stratum server with:
  - `protocolMode` (`zip301` recommended),
  - configurable notify format/preset options,
  - VarDiff support,
  - configurable hashrate averaging window.
- Pool stats and per-miner stats in API.
- Optional API key and CORS support.
- Optional log file rotation.
- Enforces coinbase payouts to the configured transparent address (fails fast if the template pays elsewhere).
- Rejects stale jobs/shares after a new height is broadcast.

## Repository

- Upstream repository URL in `package.json`:
  - `https://github.com/BluesCrewzer/ZcashSoloPool`

## Requirements

- Linux host (recommended for native module build/tooling).
- Node.js 18+ (Node 20 LTS recommended).
- `npm`.
- Build tools for native addon compilation:
  - `python3`
  - `make`
  - `g++` (or equivalent C++ toolchain)
- Zebrad node only (zcashd is not supported).
- `zcash.walletAddress` must be a transparent P2PKH address (t1/tm). The pool validates that each `coinbasetxn` pays this address and will abort startup if it does not.
- Access to the `zebrad` RPC cookie file (for auth).

## 1) Prepare zebrad

Ensure your node is fully synced, has many peers (this is key) and exposes RPC on the host/port in your config (defaults: `127.0.0.1:8232`).

Pool uses cookie auth only:
- `zcash.rpcCookiePath` must point to a file like:
  - `/var/lib/zebrad/.cookie`, or
  - `/home/<user>/.cache/zebra/.cookie`

The cookie file content must be:
- `username:password`

If the pool cannot read the cookie file, startup will fail.

## 2) Install

From project root:

```bash
npm install
```

Notes:
- This compiles `native/equihashverify`.
- If build fails, install missing build dependencies and rerun `npm install`.

## 3) Configure

Copy and edit config:

```bash
cp config.example.json config.json
```

Minimum required edits:
- `zcash.walletAddress`
- `zcash.rpcCookiePath` (must exist/readable)
- Optional: `pool.port`, `api.port`, `logging.file`

### Example `config.json` (key fields)

```json
{
  "pool": {
    "host": "0.0.0.0",
    "port": 3333,
    "difficulty": 1,
    "shareTarget": "00003fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "solutionRateScale": 1000,
    "hashrateWindowSeconds": 300,
    "minerPing": {
      "enabled": false,
      "intervalMinutes": 5,
      "timeoutMs": 1500,
      "logResults": true
    },
    "blockSubmitDedupWindowMs": 120000,
    "jobResendDelayMs": 800,
    "jobRefresh": {
      "enabled": true,
      "intervalSeconds": 30,
      "cleanJobs": false
    },
    "protocolMode": "zip301",
    "notifyFormat": "inno",
    "notifyPreset": "headerle",
    "shareValidationMode": "local",
    "connectionAcl": {
      "enabled": false,
      "allowCidrs": ["192.168.0.0/16", "10.0.0.0/8"],
      "denyCidrs": [],
      "banOnBadJson": true,
      "maxBadJsonBeforeClose": 3,
      "badJsonBanSeconds": 900,
      "logDenied": true
    },
    "maxConnectionsPerIp": 8,
    "vardiff": {
      "enabled": true,
      "initialDifficulty": 1,
      "minDifficulty": 0.5,
      "maxDifficulty": 4096,
      "targetTime": 15,
      "retargetTime": 90,
      "variancePercent": 25,
      "minSamples": 6
    }
  },
  "zcash": {
    "rpcHost": "127.0.0.1",
    "rpcPort": 8232,
    "rpcCookiePath": "/home/jon/.cache/zebra/.cookie",
    "walletAddress": "tmYourTransparentAddress"
  },
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8080,
    "corsOrigin": "",
    "apiKey": ""
  },
  "logging": {
    "level": "info",
    "file": "",
    "maxFileSizeMb": 50,
    "maxFiles": 7
  }
}
```

## 4) Run

Using npm script:

```bash
npm start
```

Or directly:

```bash
node index.js ./config.json
```

Optional helper script:

```bash
./start.sh
```

On startup you should see logs like:
- `Starting ZCashSoloPool...`
- `Connected to node: height ...`
- `Stratum listening on ...`
- `[API] listening on ...`

## Miner setup

Point miners to:

- URL: `stratum+tcp://<pool-ip>:3333`
- Worker: any label (for example `A9-1`, `Z11-3`)
- Password: typically `x` (ignored by pool logic)

Example:

```text
stratum+tcp://192.168.1.208:3333
worker: A9-2
password: x
```

## API endpoints

Default routes:

- `GET /health`
- `GET /stats`
- `GET /miners`
- `GET /network`
- `GET /job`

If `api.apiKey` is set, pass the key via header only:
- header: `X-API-Key: <key>`

> **Note:** Query-parameter auth (`?key=`) was removed — keys in URLs appear in server access logs.

Quick test:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/stats
```

## Web GUI (built-in)

- Static dashboard is served directly from this repo (`./webgui`) via the `webgui` server started by `index.js`.
- Default bind: `http://0.0.0.0:8086` (configure with `webgui.host` / `webgui.port`).
- The dashboard auto-loads `config.json` at runtime and points to the API host/port from your backend config (no manual edits needed).
- If you expose the dashboard on another host, set `api.corsOrigin` to the dashboard origin and set `api.apiKey`/`webgui` accordingly.
- You can still deploy the standalone `ZcashSoloPool-WebGui`; the API surface is unchanged.

## Configuration reference

### `zcash`

- `rpcHost` / `rpcPort`: node RPC target.
- `rpcCookiePath`: required cookie auth file path.
- `walletAddress`: payout address for block template/coinbase flow.

### `pool`

- `host`, `port`: Stratum bind target.
- `difficulty`: base/initial share difficulty.
- `shareTarget`: base share target hex (64 chars).
- `solutionRateScale`: scaling factor for hashrate estimate.
- `hashrateWindowSeconds`: rolling average window (default `300`).
- `minerPing.enabled`: enable periodic ICMP ping checks to connected miners.
- `minerPing.intervalMinutes`: ping sweep interval in minutes.
- `minerPing.timeoutMs`: ping timeout per miner.
- `minerPing.logResults`: log each ping result line.
- `blockSubmitDedupWindowMs`: suppress duplicate block submits.
- `jobResendDelayMs`: delayed re-notify after authorize (helps some ASIC reconnect cases).
- `useSetTarget`: emit `mining.set_target`.
- `jobRefresh.enabled`: periodic job rebroadcast to keep ASIC sessions alive.
- `jobRefresh.intervalSeconds`: rebroadcast interval (default `30`).
- `jobRefresh.cleanJobs`: send clean flag on refresh (default `false`).
- `maxConnectionsPerIp`: per-IP connection cap (default `8`).
- `connectionAcl.enabled`: enable IP allow/deny filtering and ban system.
- `connectionAcl.allowCidrs` / `denyCidrs`: CIDR-based IP filtering lists.
- `connectionAcl.banOnBadJson`: auto-ban IPs for malformed traffic.
- `connectionAcl.badJsonBanSeconds`: ban duration.
- `connectionAcl.maxBadJsonBeforeClose`: malformed messages before disconnect.
- `logOutbound`, `logSubmissions`, `submitAudit`: debugging verbosity.
- `protocolMode`: `zip301` recommended.
- `notifyFormat`, `notifyPreset`, `extranonce2Size`, `notifyReservedMode`, `notifyVersionEndian`: miner compatibility controls.
- `shareValidationMode`: currently `local`.
- `name`: display name for the pool in API responses (default `"ZCashSoloPool"`).
- `blockIntervalSeconds`: target block interval in seconds for effort/luck calculation (default `75` for Zcash).
- `blockReward`: display string for block reward (default `"1.25 ZEC"`).
- `vardiff.*`: variable difficulty controls.

### `webgui`

- `enabled`: start/stop the built-in web dashboard server (default `true`).
- `host`: bind address for the dashboard (default `"0.0.0.0"`).
- `port`: port for the dashboard (default `8086`).

### `api`

- `enabled`: start/stop API server.
- `host`, `port`: API bind target.
- `corsOrigin`: `""` (off), `"*"` or exact origin.
- `apiKey`: optional auth key for API requests.

### `logging`

- `level`: `error|warn|info|debug|trace`.
- `file`: optional log file path.
- `maxFileSizeMb`, `maxFiles`: rotation settings.

## Recommended solo ASIC defaults

- VarDiff: `targetTime` 12–15s, `variancePercent` 20–25, `minSamples` 6, `retargetTime` 90s, `maxDifficulty` sized to your rig’s steady rate to avoid long idle periods.
- Jobs: `jobResendDelayMs` 500–1000; `jobRefresh.enabled=true`, `intervalSeconds` 30–45, `cleanJobs=false` (keeps sessions alive without forcing miner resets).
- Stratum ACL: set `connectionAcl.enabled=true` and populate `allowCidrs` with your LAN/VPN ranges; keep `banOnBadJson=true` and `maxConnectionsPerIp` modest (4–8) to blunt malformed traffic.
- Logging: use `logging.level=info` for normal operation; set `logging.file` with rotation if running long-term, and only enable `debug` temporarily.
- API/Web GUI security: expose API only on trusted networks; set `apiKey` and `corsOrigin` when the GUI is on another host; keep `api.host=127.0.0.1` unless you have firewall rules.
- Ping sweep: leave disabled unless diagnosing connectivity; if enabled, use `intervalMinutes>=5` and `timeoutMs≈1500`.
- Native addon: build with `npm install --build-from-source` on the deploy host to avoid ABI drift; prefer Node 20 LTS.

## Deployment tips

- Systemd (example): run as non-root with `WorkingDirectory` set to the repo, `ExecStart=/usr/bin/node index.js ./config.json`, `Restart=always`, `LimitNOFILE=8192`, and `NoNewPrivileges=yes`.
- Firewall: keep Stratum/API on LAN/VPN; if you must expose, restrict by CIDR and/or reverse proxy the API with an auth key.

## Operational notes

- Miner software may take several minutes to switch back after failover; this is normal behavior.
- After pool restart, a few stale `Job Expired` shares during reconnect are expected.
- `bestDiff` now reflects highest observed effective difficulty, including block-level found difficulty when applicable.
- `lastBlockDiff` tracks last block share difficulty per miner.
- Hashrate is a fixed-window rolling average (default 5 minutes).
- `pool.jobRefresh.enabled=true` with `intervalSeconds` (for example `30`) keeps miners from timing out during quiet network periods.

## Stratum hardening

The stratum server includes built-in protections against spam, resource exhaustion, and abuse on the mining port:

| Protection | Default | Description |
|---|---|---|
| Buffer size cap | 16 KB | Disconnects + bans clients sending data without newlines (memory exhaustion prevention) |
| Per-IP connection limit | 8 | Prevents a single IP from consuming all connection slots |
| Pre-auth timeout | 30 s | Kicks unauthenticated clients that don't complete `mining.authorize` promptly |
| Pre-auth message limit | 10 msgs | Disconnects + bans clients flooding messages before authenticating |
| Bad JSON limit | 3 msgs | Disconnects clients sending repeated malformed JSON (bans unauthenticated clients) |
| Worker name sanitization | 128 chars | Strips control characters, caps length on authorize and submit |
| Method name sanitization | 64 chars | Truncates and strips control chars in error responses to prevent log injection |
| TCP keepalive | 15 s | Keeps NAT state tables alive on firewalls |
| Socket read timeout | 10 min | Detects and cleans up dead connections |

These protections work alongside `connectionAcl` allow/deny CIDR filtering. Bans from buffer overflow, message flooding, and malformed JSON use `connectionAcl.badJsonBanSeconds` (default 900s, configurable).

## Recommended sysctl tuning

For environments behind NAT/firewalls (especially OPNsense), tune TCP keepalive to prevent state table expiry:

```bash
sudo sysctl -w net.ipv4.tcp_keepalive_intvl=15
sudo sysctl -w net.ipv4.tcp_keepalive_probes=5
```

To persist across reboots, add to `/etc/sysctl.d/99-pool.conf`.

## Troubleshooting

### Pool exits at startup (cookie/auth errors)

- Verify `zcash.rpcCookiePath` exists and is readable by the pool process.
- Confirm file contains `user:pass`.
- Ensure RPC host/port match node settings.

### Native module build fails

- Install build dependencies (`python3`, `make`, `g++`).
- Re-run `npm install`.

### Miners disconnect frequently / failover

Common causes (all fixed in 0.5.0):
1. Missing `extranonce2_size` in subscribe response — miners fail protocol negotiation.
2. Wrong `extranonce2Size` default (8 instead of 0) — Equihash ASICs generate their own nonce.
3. Authorize cascade — `updateJob(true)` on every authorize broadcasts clean jobs to ALL miners.

Additional checks:
- Enable `pool.jobRefresh.enabled=true` to keep sessions alive during quiet block periods.
- Tune Linux TCP keepalive: `tcp_keepalive_intvl=15`, `tcp_keepalive_probes=5`.
- Check OPNsense/firewall NAT state timeouts for remote miners.

### Miners connect but do not submit

- Confirm miner uses correct pool IP/port.
- Check for `Authorize request` and `Share submit` in logs.
- Try `protocolMode: "zip301"` and keep current notify defaults.
- Increase `jobResendDelayMs` (for example `2000`-`3000`) if reconnects are unstable after restarts.

### API works locally but GUI fails remotely

- Set `api.corsOrigin`.
- Open API port in firewall/LAN rules.
- Match GUI API key to backend `apiKey` if enabled.

## Security notes

- Do not expose Stratum/API ports directly to the public internet unless you understand the risks.
- Prefer LAN/VPN/private network use.
- If exposing API externally, set `apiKey` and restrict with firewall/reverse proxy.
- The API server binds to `127.0.0.1` by default — only change `api.host` to `0.0.0.0` if you have firewall rules in place.
- API key comparison uses `crypto.timingSafeEqual()` to prevent timing side-channel attacks.
- API key is accepted via `X-API-Key` header only; query-parameter auth is not supported.
- The RPC cookie path is canonicalized with `path.resolve()` before access to prevent directory traversal.

## Recent changes (2025-03-17)

### Security fixes
- **Timing-safe API key comparison** (`lib/apiServer.js`): replaced plain string equality with `crypto.timingSafeEqual()`; key is accepted via `X-API-Key` header only (query-param auth removed)
- **Cookie path traversal** (`lib/zcashRpc.js`): cookie path is now resolved with `path.resolve()` after `~` expansion to neutralize any `..` sequences

### Bug fixes
- **VarDiff grace period** (`lib/stratumServer.js`): stale previous-target grace period is now correctly cleared when difficulty decreases; previously a grace period from a past increase could incorrectly apply after a subsequent decrease
- **`updateJob` race condition** (`index.js`): `jobUpdateInFlight` is now nulled using an identity check (`if (this.jobUpdateInFlight === inflight)`) to prevent a concurrent caller from nulling a newly-started in-flight promise
- **TCP backpressure** (`lib/stratumServer.js`): `send()` now checks `socket.writableLength` before writing; clients with an outbound buffer above the high-water mark are disconnected rather than silently buffering without bound
- **Graceful shutdown** (`index.js`, `lib/apiServer.js`, `lib/webguiServer.js`): `api.stop()` and `webgui.stop()` are now called on `SIGINT`/`SIGTERM`; prevents port-reuse errors on rapid restart

### Performance
- **O(1) IP connection counting** (`lib/stratumServer.js`): per-IP connection count is maintained in a `Map` instead of scanning all connected clients on each new connection
- **Async WebGui file serving** (`lib/webguiServer.js`): `handleRequest` is now fully async (`fs.promises`); eliminates synchronous `statSync`/`readFileSync` calls that blocked the event loop on cache misses
- **Block dedup cleanup** (`index.js`): periodic `setInterval` now prunes the dedup map instead of scanning it on every block submission

### Code quality
- **`formatDifficulty` deduplication** (`index.js`): `index.js` now delegates to `stratumServer.formatDifficulty()` — single implementation with full SI prefix support (including "Z" Zetta scale)
- **`savePersistedState` on all block outcomes** (`index.js`): state is now persisted on soft rejection and RPC error paths, not only on accepted blocks

## License

See [LICENSE](./LICENSE).
