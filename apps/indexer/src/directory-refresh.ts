/**
 * `pnpm --filter @copy-trade-vault/indexer directory:refresh [source…]` — crawls the directory sources (all enabled ones, or
 * those named) and rewrites the committed seed `src/directory-snapshot.json`, keeping other sources' last rows.
 * The running indexer refreshes on its own schedule; this seeds fresh deploys.
 */
import { Directory, SNAPSHOT_FILE, writeSnapshot } from "./directory";
import { DIRECTORY_SOURCES } from "./directory-sources";

const log = {
  info: (obj: object, msg: string) => console.log(`· ${msg}`, JSON.stringify(obj)),
  warn: (obj: object, msg: string) => console.warn(`! ${msg}`, JSON.stringify(obj)),
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !DIRECTORY_SOURCES.some((m) => m.id === w));
if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")} (have ${DIRECTORY_SOURCES.map((m) => m.id).join(", ")})`);

const dir = new Directory({ log });
let failed = 0;
for (const m of DIRECTORY_SOURCES) {
  if (wanted.length ? !wanted.includes(m.id) : !m.enabled()) {
    if (!wanted.length) console.log(`- ${m.id}: disabled (see its enabled() check in src/directory-sources)`);
    continue;
  }
  const t0 = Date.now();
  try {
    const r = await dir.refresh(m);
    console.log(`✓ ${m.id}: ${r.wallets.filter((w) => !w.profileOnly).length} wallets (+${r.wallets.filter((w) => w.profileOnly).length} profiles) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (err) {
    failed++;
    console.error(`✗ ${m.id}: ${String(err)}`);
  }
}
writeSnapshot(SNAPSHOT_FILE, dir.snapshot());

const all = dir.all();
const bySource: Record<string, number> = {};
for (const w of all) for (const s of w.sources) bySource[s] = (bySource[s] ?? 0) + 1;
console.log("\nper source (listing):", bySource);
console.log(
  `total: ${all.length} wallets, ${dir.personCount()} persons; ${all.filter((w) => w.handle).length} with X handle; ${all.filter((w) => w.avatarSources.length).length} with an avatar source; ${all.filter((w) => w.score !== null).length} scored; ${all.filter((w) => w.tags.includes("hft")).length} hft`,
);
console.log(`snapshot → ${SNAPSHOT_FILE}`);
if (failed) process.exitCode = 1;
