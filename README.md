# Magnet Watcher

Paste a magnet link, pick a video file, and the page recovers the file's
pieces from the BitTorrent swarm, verifying each one in the browser.
Recovery is sequential (the file's head and tail first, then in order from a
movable front) so it can back streaming and seeking later.

- **Choosing a video.** A magnet's videos are shown as a folder tree (like
  `tree`): folders first, episodes in number order, folders holding a single
  folder merged into one row. Large folders start closed. With 8 or more
  videos, a filter box matches every typed word against the full path. Names
  are never cut off; they wrap at dots, dashes and slashes. On the video
  page, **Other videos** opens the same tree to switch to another video of
  the torrent.
- **Saved videos.** Every video opened is saved in the browser as it's
  recovered. **Saved**, top-left of the home page (`?saved`), lists them,
  most recent first:
  - partly recovered ones are tagged **Partial** with their percentage;
  - opening one resumes where it left off;
  - each can be deleted on its own, or everything at once, with a second
    click to confirm.

  Deleting a video keeps the pieces at its edges that a neighbouring saved
  video still needs. Pieces saved before names were recorded show up by
  info-hash: open one to pick its video again, or delete it.

## How chunk recovery works

- **[magnet-seeders](https://github.com/WinCisky/magnet-seeders)** (VPS)
  provides:
  - `/swarm`: the peers, probed over TCP (reachable, seed or bitfield,
    unchoke speed), each with a signed token. It answers as soon as the
    first peers unchoke a probe (`complete: false`); the page polls every
    1.5 s until the whole swarm is probed, then every 5 minutes. The page
    asks for it alongside the info dict, not after.
  - `/metadata`: the torrent's info dict. Its SHA-1 must equal the
    info-hash, and it holds every piece's hash.
- **[magnet-worker](https://github.com/WinCisky/magnet-worker)** (Cloudflare
  Worker) does what the browser can't: it opens TCP connections to peers. The
  page asks it for blocks from a lead peer plus up to a dozen fallbacks (most
  of a swarm is usually unreachable). The worker tries them 6 connections at
  a time, gives the lead a head start, and streams back whatever the first
  to unchoke sends, unverified. With an older worker (no `/v1/info`), the
  page names 1–3 peers instead.
- The engine in `src/lib/torrent/` schedules the requests, assembles the
  pieces, and checks each piece's SHA-1. How it schedules:
  - At the start and after a seek, at most 6 requests run until 4 MiB are
    verified from the playback position: the first MiB in 256 KiB batches
    and the rest in 1 MiB batches, each from a different peer. A new
    connection starts slowly, and parallel requests share the link evenly,
    so this gets the first chunks in sooner.
  - Then requests run in parallel: up to 24 at once, fewer on a slow
    connection.
  - A seek cancels requests far from the new position.
  - Each request is a run of blocks sized to the peer's measured speed,
    because every request pays ~0.2–1 s of setup.
  - Near the playback front, it uses only peers that unchoke quickly.
  - Peers that serve fast get up to 3 parallel connections.
  - Peers that crawl have their blocks handed to others.
  - Peers that unchoke on a timer (Transmission) are given a longer wait
    instead of being marked as failures.

  Verified pieces are stored in Cache Storage (one cache per torrent, with a
  record of the files opened from it: `src/lib/torrent/library.ts`), so a
  reload resumes where it left off. The view shows every piece's state
  (recovered, downloading, pending, no source, failed check) on a piece map
  and a seek-bar-style strip.

Service URLs default to production. Override them at build/dev time:

```sh
PUBLIC_SEEDERS_URL=http://127.0.0.1:8080 PUBLIC_WORKER_URL=http://127.0.0.1:8787 npm run dev
```

To see every worker request in the browser console, run
`localStorage.setItem("mw-debug", "1")` and reload.

## Diagnostics

The page records anonymous measurements of how each part of it performs.
They stay in the browser (IndexedDB) until the user exports them from the
home page's **Diagnostics** menu as JSON. The same menu deletes them.
Nothing is ever sent anywhere. The code is in `src/lib/diagnostics/`.

- **Visits.** One record per page load that did something:
  - what the user did (magnet submitted, file picked, saved video opened…);
  - the metadata API and `/peers` requests: outcomes, latency and errors;
  - uncaught errors;
  - the browser, OS and device class.
- **Recoveries.** One record per video opened:
  - milestones: piece hashes, first peers, first data, 1/4/16 MiB ready;
  - `/metadata` and `/swarm` outcomes, and the largest swarm size seen;
  - worker requests by how they ended, time to unchoke, why candidates
    failed, and which clients served the data;
  - speed per 10 s window, stalls (5 s or more with no data), time from a
    seek to 4 MiB ready, failed piece checks, and storage errors.
- **Privacy.** There are no magnet links, file or torrent names, info-hashes
  or IP addresses. Error text is scrubbed of all of them, and sizes are
  rounded. A torrent appears only as a hash salted with a secret that never
  leaves the browser, so one torrent's recoveries can be grouped without
  revealing which torrent it is. `installId` is a random id that tells one
  browser's exports apart.
- **Cost.** Recording bumps counters in memory, at points that already run
  (a request ending, the 200 ms progress snapshot): about 0.3 µs per snapshot
  and 2 µs per request. The visit is written at most every 15 s, when the
  browser is idle, and when the page is hidden. A recovery's record is
  ~1.5 KB. At most 300 visits, up to 90 days old, are kept. The report code
  loads only on export.
- **The export.** `weakSpots` and `workingWell` summarize the verdicts:
  - `health` grades each part (lookup, seeder count, piece hashes, peer
    discovery, worker requests, startup, download speed, seeking, integrity,
    storage, page errors) as good, fair or poor. The limits are in
    `thresholds`. Each part has a one-line summary and details;
  - `visits` holds the raw records;
  - histograms are counts per bucket, with the bounds in `buckets`.

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` |
| `npm test` | Unit tests for the recovery engine (vitest) |
| `npx astro check` | Type-check |

`src/lib/torrent/live.test.ts` benchmarks the real engine against running
services and real peers: time to the first 1/4/16 MiB, throughput per 10 s,
and four seeks per torrent, over the legal video and Linux ISO swarms in
`live-torrents.json`. It's skipped unless `MW_LIVE=1`; see the file's header.
