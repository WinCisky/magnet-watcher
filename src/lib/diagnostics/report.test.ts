import { describe, expect, it } from "vitest";
import { newRecovery, newVisit, type RecoveryRecord, type VisitRecord } from "./records";
import { buildReport } from "./report";
import { MS_BOUNDS, RATE_BOUNDS, add } from "./stats";

const MiB = 1024 * 1024;
const ENV = { browser: "Chrome 140", os: "Android", mobile: true, cores: 8, memoryGb: 4, connection: "4g", downlinkMbps: 10 };

function recovery(tune: (r: RecoveryRecord) => void): RecoveryRecord {
	const r = newRecovery({ fileSize: 1_200_000_000, videos: 1, ext: "mkv" });
	r.torrent = "a1b2c3d4e5f6";
	r.traits.freshStart = true;
	r.storage.kind = "cache";
	tune(r);
	return r;
}

function visit(recoveries: RecoveryRecord[], tune: (v: VisitRecord) => void = () => {}): VisitRecord {
	const v = newVisit(ENV, "test");
	v.recoveries = recoveries;
	tune(v);
	return v;
}

function report(visits: VisitRecord[]) {
	return buildReport({
		visits,
		installId: "id",
		build: "test",
		environment: ENV,
		storage: { usageMb: 500, quotaMb: 10_000, persisted: false },
		now: Date.UTC(2026, 8, 29),
	});
}

/** A recovery where everything went well. */
function healthy(r: RecoveryRecord) {
	r.infoDict.ok = 1;
	add(r.infoDict.ms, MS_BOUNDS, 400);
	r.swarm.ok = 3;
	add(r.swarm.ms, MS_BOUNDS, 800);
	r.swarm.reachable = 40;
	r.milestones = { ...r.milestones, infoDict: 500, peers: 900, firstByte: 1_800, ready4MiB: 3_500 };
	r.worker.ends = { done: 90, no_peer: 8, aborted: 30, stalled: 2 };
	for (let i = 0; i < 30; i++) add(r.transfer.windows, RATE_BOUNDS, 4.5 * MiB);
	r.transfer.recoveringMs = 300_000;
	r.transfer.stallMs = 3_000;
	r.transfer.bytes = 1_000 * MiB;
	add(r.seeks.readyMs, MS_BOUNDS, 2_500);
}

describe("buildReport", () => {
	it("calls a healthy recovery good across the board", () => {
		const out = report([
			visit([recovery(healthy)], (v) => {
				v.metadataApi.ok = 2;
				add(v.metadataApi.ms, MS_BOUNDS, 1_500);
			}),
		]);
		for (const part of ["metadataApi", "infoDict", "swarm", "worker", "startup", "throughput", "seeking", "integrity", "storage", "app"]) {
			expect([part, out.health[part].status]).toEqual([part, "good"]);
		}
		expect(out.health.seedersCount.status).toBe("no data");
		expect(out.weakSpots).toEqual([]);
		expect(out.overview).toMatchObject({ visits: 1, recoveries: 1, torrents: 1, downloadedMb: 1_000 });
	});

	it("puts the poor parts first among the weak spots, with a reason", () => {
		const slow = recovery((r) => {
			healthy(r);
			r.worker.ends = { done: 20, no_peer: 70, error: 10 };
			r.worker.candidates = { connect_timeout: 300, lost: 500, choked: 40 };
			r.transfer.windows.b.fill(0);
			r.transfer.windows.n = 0;
			for (let i = 0; i < 30; i++) add(r.transfer.windows, RATE_BOUNDS, 1.5 * MiB);
		});
		const out = report([visit([slow])]);
		expect(out.health.worker.status).toBe("poor");
		expect(out.health.worker.summary).toContain("20% of 100 requests served");
		expect(out.health.worker.summary).toContain("connect_timeout (88%)");
		expect(out.health.throughput.status).toBe("fair");
		expect(out.health.throughput.summary).toContain("median 1–2 MB/s");
		expect(out.weakSpots.map((w) => w.part)).toEqual(["worker", "throughput"]);
		expect(out.workingWell.map((w) => w.part)).toContain("startup");
	});

	it("counts starts that never got going, and skips resumed ones", () => {
		const stuck = recovery((r) => {
			r.durationMs = 60_000;
		});
		const resumed = recovery((r) => {
			r.traits.freshStart = false;
			r.milestones.ready4MiB = 0;
		});
		const out = report([visit([stuck, resumed, recovery(healthy)])]);
		expect(out.health.startup.status).toBe("poor");
		expect(out.health.startup.details).toMatchObject({ videos: 2, failed: 1 });
	});

	it("flags page errors and storage trouble", () => {
		const unsaved = recovery((r) => {
			healthy(r);
			r.storage.kind = "memory";
		});
		const out = report([
			visit([unsaved], (v) => v.errors.push({ where: "uncaught", message: "TypeError: x is undefined", count: 3, firstAt: 0 })),
		]);
		expect(out.health.app.status).toBe("poor");
		expect(out.health.app.summary).toContain("uncaught: TypeError: x is undefined");
		expect(out.health.storage.status).toBe("fair");
	});

	it("exports nothing that names a torrent, file or peer", () => {
		const out = JSON.stringify(report([visit([recovery(healthy)])]));
		expect(out).not.toMatch(/magnet:\?xt|[0-9a-f]{40}|\d+\.\d+\.\d+\.\d+:\d+|\.mkv"/i);
	});
});
