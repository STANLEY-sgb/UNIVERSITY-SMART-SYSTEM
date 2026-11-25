# Measured access-decision performance

Measured 2026-11-15 on 12th Gen Intel(R) Core(TM) i5-1235U (12 logical cores, 12 GB RAM, win32), Node v26.12.1.
Setup: one compiled API process, an embedded PostgreSQL on the same machine, real HTTP, real reader HMAC signing and Ed25519 QR verification, every request a different signed QR (gate service, alternating ENTRY/EXIT per card; the seeded demo data includes some suspended students, so a minority of requests are denials). Client and server share the machine, so the client's own work is in the numbers. **This is a measurement on a developer laptop, not a capacity or production claim.**

| Scenario | Requests | OK | GRANT | DENY | Errors | req/s | p50 ms | p95 ms | p99 ms | max ms | server p50 | server p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| one reader at a time | 600 | 600 | 580 | 20 | 0 | 43 | 22.5 | 26.6 | 29.6 | 64.3 | 13.0 | 16.0 |
| 10 readers at once | 2000 | 2000 | 1934 | 66 | 0 | 168 | 58.7 | 69.8 | 78.8 | 215.1 | 34.0 | 42.0 |
| 50 readers at once | 3000 | 3000 | 2900 | 100 | 0 | 165 | 297.5 | 393.8 | 481.2 | 617.1 | 178.0 | 230.0 |

Latency is measured by the client from just before sending to the response body being read ("server" = the API's own `processing_ms`). The product target is a decision in about 800 ms (online-first window); compare p95/p99 with that number.

What this does **not** show: network latency between a real reader and the server, TLS, a separate database host, many API instances, Redis, a cold cache, or face verification. Re-run with `pnpm bench` after changes.
