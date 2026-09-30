# Magnet Watcher

Paste a magnet link, pick a video file, and the page recovers the file's
pieces from the BitTorrent swarm, verifying each one in the browser, and
plays the video while it downloads. Recovery is sequential (the file's head
and tail first, then in order from a movable front), and the player moves
that front to wherever playback needs data.

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
  - `/files`: the magnet's files (name, size, offset), read from its info
    dict, largest first. A file's place in this list is its index in
    `?file=` links and saved videos.
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

## Playback

The video page has a player above the recovery details. Press play once the
video's header is read (a few MiB from the file's start or end). A read of
data that isn't in yet waits for its piece and moves the recovery front
there. So seeking in the player, playing past the front, or a container
index at the end of the file all steer recovery. The piece strip at the
bottom marks where playback last read.

- **Formats** (Chrome as the baseline):

  | Kind | Supported |
  | :-- | :-- |
  | Containers | MKV/WebM, MP4/MOV, AVI, MPEG-TS |
  | Video | H.264, HEVC (8 and 10 bit), MPEG-4 Part 2 (Xvid, DivX), DivX 3, MPEG-2, VP9, AV1 |
  | Audio | AAC, MP3, AC3, EAC3, DTS, Opus, Vorbis, FLAC, PCM |
  | Extras | several audio tracks; text subtitles (SRT, ASS/SSA, WebVTT, TTML), in the video or as files in the torrent |

  There are no decoders for TrueHD, MP2 audio, WMV or RealVideo.
- **Decoding.** Built on [libmedia](https://github.com/zhaohappy/libmedia)
  (`@libmedia/avplayer`). It uses the GPU (WebCodecs) where it can, or
  Chrome's own player (MSE) when the codecs are ones Chrome plays.
  Otherwise it decodes with FFmpeg compiled to wasm, one decoder per codec,
  fetched only when a video needs it: HEVC on machines without hardware
  support, DivX/Xvid, and AC3/EAC3/DTS audio. Nothing is re-encoded.
- **Cross-origin isolation.** libmedia needs SharedArrayBuffer to run on
  real threads. Without it, its workers can't pass subtitles to the page,
  and wasm decoding is single-threaded. GitHub Pages can't send the
  COOP/COEP headers that enable it, so `public/coi-sw.js`, a service worker
  registered in `src/pages/index.astro`, adds them to the site's own
  responses.
  - The first visit reloads once so the worker can take over.
  - Requests to other origins pass through untouched; they must allow
    CORS, as magnet-seeders and the worker do. Anything
    new loaded from another origin (images, fonts) must allow CORS or send
    `Cross-Origin-Resource-Policy`.
  - If isolation fails (a hard reload bypasses the worker), the Subtitles
    menu says to reload. The diagnostics record `isolated` in the
    environment.
- **Controls.** Seek bar with the downloaded parts shaded (bytes mapped
  linearly to time, so approximate), volume, full screen. Keys: space or
  `k`, `←`/`→` (10 s), `f`, `m`, and `c` for subtitles on/off.
- **Audio and subtitles.** With several audio tracks, the **Audio** menu
  picks one. Tracks are named by language and title, with codec and
  channels ("Italian · AC3 5.1"). The **Subtitles** menu lists:
  - **Off**;
  - the video's own subtitles. Image subtitles (PGS, VobSub) are listed but
    greyed out, since only text subtitles can be shown;
  - under **Subtitle files**, the torrent's `.srt/.ass/.ssa/.vtt/.ttml`
    files for this video. They are recovered only when picked, kept in
    memory and not saved. A file counts as the video's when:
    - its name starts with the video's (`Movie.it.srt`);
    - or it's in a `Subs` folder, under the video's name
      (`Subs/Show.S01E02/2_English.srt`);
    - or the torrent has a single video.
    The language and flags (forced, SDH) come from the file name.

  Subtitles start off unless the video flags one of its tracks as default
  (or titles one "forced").
- **Code.** The player and recovery are independent:
  - `src/lib/player/` reads from any `ByteSource` (`source.ts`) and knows
    nothing about torrents;
  - `src/lib/torrent/stream.ts` serves a file's bytes from its verified
    pieces, and knows nothing about players;
  - the video page joins them, and `src/lib/boundaries.test.ts` fails if
    either side imports the other.
- **Codec files.** `scripts/fetch-codecs.mjs` runs before `dev` and
  `build`. It downloads libmedia's wasm decoders (from jsDelivr, or GitHub
  if that fails) into `public/libmedia/` (gitignored), pinned to the
  version and SHA-256s in `scripts/codecs.json`, so the site serves them
  itself. After upgrading `@libmedia/avplayer`, set
  the new version there and run `node scripts/fetch-codecs.mjs --update`.
  `scripts/vite-libmedia.mjs` copies libmedia's lazily loaded format chunks
  next to its bundle.
- **Licenses.** libmedia is LGPL-3.0-or-later, used unmodified from npm.
  Its wasm decoders are built from [FFmpeg](https://ffmpeg.org) (LGPL).

## Diagnostics

The page records anonymous measurements of how each part of it performs.
They stay in the browser (IndexedDB) until the user exports them from the
home page's **Diagnostics** menu as JSON. The same menu deletes them.
Nothing is ever sent anywhere. The code is in `src/lib/diagnostics/`.

- **Visits.** One record per page load that did something:
  - what the user did (magnet submitted, file picked, saved video opened…);
  - magnet-seeders' `/files` (the magnet's file list) and `/peers`
    requests: outcomes, latency and errors;
  - uncaught errors;
  - the browser, OS and device class.
- **Recoveries.** One record per video opened:
  - milestones: piece hashes, first peers, first data, 1/4/16 MiB ready;
  - `/metadata` and `/swarm` outcomes, and the largest swarm size seen;
  - worker requests by how they ended, time to unchoke, why candidates
    failed, and which clients served the data;
  - speed per 10 s window, stalls (5 s or more with no data), time from a
    seek to 4 MiB ready, failed piece checks, and storage errors;
  - the player: how it decoded (the browser's player or libmedia's
    decoders) and the codecs, time to read the header and from play to the
    first picture, waits for data, seek times, decoder stutters, and errors;
    how many audio tracks, subtitles and subtitle files the video offered,
    which were picked, and how subtitle file downloads went.
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
    playback, storage, page errors) as good, fair or poor. The limits are in
    `thresholds`. Each part has a one-line summary and details;
  - `visits` holds the raw records;
  - histograms are counts per bucket, with the bounds in `buckets`.

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` |
| `npm test` | Unit tests (vitest) |
| `npx astro check` | Type-check |

`src/lib/torrent/live.test.ts` benchmarks the real engine against running
services and real peers: time to the first 1/4/16 MiB, throughput per 10 s,
and four seeks per torrent, over the legal video and Linux ISO swarms in
`live-torrents.json`. It's skipped unless `MW_LIVE=1`; see the file's header.
