# Magnet Watcher

Paste a magnet link, pick a video file, and the page recovers the file's
pieces from the BitTorrent swarm, verifying each one in the browser.
Recovery is sequential (the file's head and tail first, then in order from a
movable front) so it can back streaming and seeking later.

## How chunk recovery works

- **[magnet-seeders](https://github.com/WinCisky/magnet-seeders)** (VPS)
  provides:
  - `/swarm`: the peers, probed over TCP (reachable, seed or bitfield,
    unchoke speed), each with a signed token. The page polls it every 5
    minutes.
  - `/metadata`: the torrent's info dict. Its SHA-1 must equal the
    info-hash, and it holds every piece's hash.
- **[magnet-worker](https://github.com/WinCisky/magnet-worker)** (Cloudflare
  Worker) does what the browser can't: it opens TCP connections to peers. The
  page asks it for blocks from 1–3 candidate peers, and it streams back
  whatever the fastest one sends, unverified.
- The engine in `src/lib/torrent/` schedules the requests, assembles the
  pieces, and checks each piece's SHA-1. Verified pieces are stored in Cache
  Storage (one cache per torrent), so a reload resumes where it left off. The
  view shows every piece's state (recovered, downloading, pending, no source,
  failed check) on a piece map and a seek-bar-style strip.

Service URLs default to production. Override them at build/dev time:

```sh
PUBLIC_SEEDERS_URL=http://127.0.0.1:8080 PUBLIC_WORKER_URL=http://127.0.0.1:8787 npm run dev
```

To see every worker request in the browser console, run
`localStorage.setItem("mw-debug", "1")` and reload.

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` |
| `npm test` | Unit tests for the recovery engine (vitest) |
| `npx astro check` | Type-check |

`src/lib/torrent/live.test.ts` runs the real engine against running services
and real peers. It's skipped unless `MW_LIVE=1`; see the file's header.
