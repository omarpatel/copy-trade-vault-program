import { fomo } from "./fomo";
import { gmgn } from "./gmgn";
import { kolexplorer } from "./kolexplorer";
import { kolscan } from "./kolscan";
import { pump } from "./pump";
import type { DirectorySourceModule } from "./types";

/** Refresh order: the KOL rosters first, so pump.fun / GMGN profile enrichment sees their wallets. */
export const DIRECTORY_SOURCES: readonly DirectorySourceModule[] = [kolscan, kolexplorer, gmgn, pump, fomo];
