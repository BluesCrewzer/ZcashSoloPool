# ZcashSoloPool Project Notes

## Purpose
`ZcashSoloPool` is a Node.js Zcash solo mining pool backend for private/home deployments. It connects miners over Stratum, validates shares, submits block candidates to the node, and provides API stats for dashboards.

This file summarizes:
- what the system does and how it works,
- key problems encountered and fixes applied,
- the validation path,
- operational notes for testnet/mainnet and future research.

## High-Level Architecture
- `index.js`: Orchestrator. Starts RPC, Stratum, WorkManager, API, periodic polling, and pool-wide stats/logging.
- `lib/workManager.js`: Job build + share validation pipeline.
- `lib/stratumServer.js`: Stratum protocol handling, compatibility controls, vardiff, per-miner metrics.
- `lib/zcashRpc.js`: RPC wrapper (`getblocktemplate`, `submitblock`, info calls, proposal checks).
- `lib/apiServer.js`: JSON API endpoints (`/health`, `/stats`, `/miners`, `/network`, `/job`).

## End-to-End Mining Flow
1. Pool fetches block template from node.
2. Pool builds job fields and broadcasts `mining.notify`.
3. Miner submits solution via `mining.submit`.
4. Pool parses payload (supports firmware variations), reconstructs PoW header candidates.
5. Equihash solution is validated locally via the native `equihashverify` addon.
6. Hash is checked against:
- pool share target -> accepted share,
- network target -> block candidate.
7. For block candidates, pool calls `submitblock`.
8. If rejected, pool runs proposal validation for diagnostics (`accepted` there usually indicates race/stale, not malformed block).

## Validation Path
- Local share validation (`shareValidationMode: "local"`) using the native `equihashverify` module for each share.
- Deterministic and independent of a remote checker service.

## Major Issues Encountered and Resolved
1. Excess rejected shares (`Invalid solution` / `Low Diff`)
- Root cause: miner firmware differences in submit parameter layout and endian expectations.
- Fixes:
  - Expanded nonce/time/bits candidate generation and normalization.
  - Better handling of different header field orientations.
  - ZIP301-compatible flow and notify format controls.

2. Miner auth/compat instability (A9/Z11 behavior mismatches)
- Fixes:
  - `mining.configure` support.
  - Immediate notify after authorize.
  - `set_target` advertisement and configurable `useSetTarget`.
  - Added firmware compatibility knobs:
    - `protocolMode`
    - `notifyFormat`
    - `notifyPreset`
    - `notifyReservedMode`
    - `notifyVersionEndian`
    - `extranonce2Size`

3. Duplicate block/job churn around updates
- Fix: added job-update in-flight queue/guard to coalesce overlapping updates.

4. Block candidate diagnostics unclear
- Fixes:
  - detailed logs: worker, miner id, net diff, found diff,
  - proposal validation fallback after `submitblock` rejection,
  - block submission de-dup window (`blockSubmitDedupWindowMs`).

5. Missing/limited miner stats visibility
- Fixes:
  - per-miner counters (accepted/rejected/invalid/lowDiff/stale/blocks),
  - best share difficulty and block attribution,
  - richer periodic `[Stats]` and `[Miner #]` logs,
  - richer `/stats` and `/miners` API fields.

6. Difficulty display inconsistencies
- Fixes:
  - unified difficulty text formatting (scaled notation),
  - added text fields in API for formatted display.

7. Hashrate display unrealistic
- Root cause:
  - Bitcoin-style conversion inflated Equihash presentation.
  - Rate contributions originally over-weighted by lucky shares.
- Fixes:
  - rate now based on assigned share difficulty contributions,
  - configurable `solutionRateScale` for calibration against miner UI.

## Why `submitblock rejected` + `proposal accepted` Happens
This usually means:
- block structure is valid (`proposal accepted`),
- but node rejected it for chain-state timing/race reasons (`submitblock rejected`), often stale or tip changed.

This can happen even in healthy operation and does not always indicate validator failure.

## Key Current Configuration Concepts
- `pool.difficulty`, `pool.vardiff.*`: miner share difficulty behavior.
- `pool.protocolMode`: `zip301` recommended.
- `pool.notify*` settings: firmware compatibility controls.
- `pool.solutionRateScale`: hashrate display calibration.
- `pool.blockSubmitDedupWindowMs`: duplicate block candidate suppression window.
- `zcash.rpcCookiePath`: node auth requirement.
- `zcash.walletAddress`: payout/coinbase address (testnet vs mainnet matters).
- `api.apiKey`: secure API when exposed beyond local machine.

## Mainnet Switch Checklist
1. Node fully synced on mainnet.
2. Replace testnet address (`tm...`) with mainnet transparent address (`t...`).
3. Keep working Stratum compatibility settings as-is for first mainnet run.
4. Set API security:
- bind API to localhost or private network,
- set `apiKey` if remotely reachable.
5. Lower logging verbosity from `debug` to `info` for production.
6. Start one miner first, then scale up; monitor reject/stale rates.

## 0.5.0 Fixes and Hardening

### Miner disconnect resolution
Three critical bugs caused persistent miner disconnects and failover:
1. **Missing `extranonce2_size` in ZIP 301 subscribe**: Response was `[sessionId, extranonce1]` instead of `[sessionId, extranonce1, extranonce2Size]`. Miners failed protocol negotiation.
2. **Wrong `extranonce2Size` default**: Code defaulted to 8 when config was 0 (due to `> 0` check). Equihash ASICs need 0.
3. **Authorize cascade**: `updateJob(true)` was called on every authorize, broadcasting clean jobs to ALL miners. Each reconnecting miner disrupted all others.

### Network stability additions
- TCP keepalive (15s) on stratum sockets for NAT keepalive.
- 10-minute socket read timeout to detect dead connections.
- Job refresh periodic rebroadcast (`pool.jobRefresh`) for ASIC session stability.
- Richer disconnect logging (reason, worker, uptime, endpoint).

### Stratum hardening
- Connection ACL system (`pool.connectionAcl`): allow/deny CIDRs, temporary bans.
- Per-client buffer cap (16 KB) prevents memory exhaustion.
- Per-IP connection limit (8) prevents connection slot exhaustion.
- Pre-auth timeout (30s) kicks unauthenticated clients.
- Pre-auth message rate limit (10 msgs) prevents message flooding.
- Bad JSON tracking for both auth and unauth clients.
- Worker name sanitization (control chars stripped, 128 char cap).
- Method name sanitization in error responses (64 char cap).
- Periodic ban cleanup (60s interval) instead of per-connection.
- Safe `socket.write()` error handling.

### API hardening
- Internal error details no longer exposed to clients.

## Known Operational Notes
- Some stale/expired shares during reconnect/restart are expected.
- Miner failover return may lag by miner firmware behavior.
- Very short windows can make hashrate noisy; use rolling windows and compare over minutes, not seconds.
- Recommended Linux sysctl: `tcp_keepalive_intvl=15`, `tcp_keepalive_probes=5`.

## Suggested Future Improvements
1. Persist miner stats across restarts.
2. Add explicit rejection classification for `submitblock` outcomes.
3. Export Prometheus metrics and add alert thresholds.
4. Add model-specific profile presets (A9/Z11 firmware variants).
5. Add latency and stale-rate trend charts for faster troubleshooting.

## Project State Summary
System validated with A9 and Z11 miners on mainnet with strong accept rates, accepted block submissions, and improved observability. Stratum server hardened against spam/abuse on the mining port. All critical disconnect bugs resolved.
