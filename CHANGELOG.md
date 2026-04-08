# Changelog

## 0.3.1
- Fix: add `WorkManager.getCurrentJob()` so the height poller doesn’t throw.

## 0.3.2
- Fix: handle mining.configure for Innosilicon firmware.
- Fix: send mining.notify immediately after authorize to prevent auth timeout.

## 0.3.3
- Fix: advertise mining.set_target in subscribe response (InnoMiner auth stability).
- Add pool.useSetTarget (default true) and pool.logOutbound (debug).

## 0.3.4
- Fix: send miner-facing notify fields in BE (prevhash/merkleroot/ntime) while keeping LE internals for hashing.
- Compat: try both BE and LE nTime layouts when validating shares.

## 0.3.5
- Fix: syntax error in WorkManager validateShare loop (nTime candidates).

## 0.3.6
- Add pool.notifyFormat preset: 'inno' (default) or 'zcash' for mining.notify param ordering.

## 0.3.7
- Add pool.notifyPreset: 'headerle' (default) vs 'display' to match picky miner notify endian expectations.

## 0.3.8
- Add pool.extranonce2Size (default 8) for ASIC subscribe compatibility.
- Add pool.notifyReservedMode (default 'empty') to avoid firmware disconnects on reserved field.

## 0.3.9
- Add pool.notifyVersionEndian (default 'be') to satisfy firmware that rejects LE version in notify.

## 0.4.0
- Implement ZIP 301 (Zcash Stratum spec) protocolMode for mining.subscribe + mining.notify encoding.
- Add pool.shareValidationMode: local vs node (proposal-based) for debugging/Option-A-style validation.

## 0.5.0

### Bug fixes (miner disconnect resolution)

- Fix: ZIP 301 `mining.subscribe` response now includes `extranonce2_size` as the third element (`[sessionId, extranonce1, extranonce2Size]`). Previously only `[sessionId, extranonce1]` was sent, causing miners to fail protocol negotiation and disconnect.
- Fix: `extranonce2Size` default changed from 8 to 0 for Equihash miners. Equihash ASICs generate their own full nonce, so `extranonce2_size` should be 0. The config value `0` was previously ignored due to a `> 0` check instead of `>= 0`.
- Fix: `mining.authorize` no longer calls `updateJob(true)`, which was broadcasting a clean job to ALL connected miners every time any single miner reconnected. This caused cascading disruption. The stratum server already sends `lastJob` directly to the newly authorized client.

### Network stability

- Add TCP keepalive on stratum sockets (`setKeepAlive(true, 15000)`) to keep NAT state tables alive on firewalls (especially OPNsense).
- Add `socket.setNoDelay(true)` to reduce latency on stratum messages.
- Add 10-minute socket read timeout to detect and clean up dead connections.
- Add `pool.jobRefresh` periodic notify rebroadcast to improve ASIC session stability during long no-block gaps.
- Add richer disconnect logging in Stratum (`reason`, `worker`, `uptime`, `endpoint`) for easier troubleshooting.

### Stratum server hardening

- Add `pool.connectionAcl` support: allow/deny CIDR filtering plus temporary bans for malformed traffic.
- Add per-client buffer size cap (16 KB). Clients sending data without newlines are disconnected and banned to prevent memory exhaustion.
- Add per-IP connection limit (8). Prevents a single IP from consuming all connection slots.
- Add 30-second pre-auth timeout. Unauthenticated clients that don't complete `mining.authorize` within 30s are disconnected.
- Add pre-auth message rate limit (10 messages). Clients sending excessive messages before authenticating are disconnected and banned.
- Bad JSON tracking now applies to both authenticated and unauthenticated clients. Authorized clients are disconnected (but not IP-banned) after `maxBadJsonBeforeClose` malformed messages.
- Worker names are sanitized: control characters stripped, length capped at 128 characters. Applies to both `mining.authorize` and `mining.submit`.
- Method names in "Unsupported method" error responses are sanitized (control chars stripped, truncated to 64 chars) to prevent log injection.
- `cleanupAddressBans()` runs on a periodic 60-second interval instead of per-connection.
- Safe error handling on `socket.write()` failures.

### API hardening

- Internal error responses no longer expose `e.message` details to clients. Error details are logged server-side only.
