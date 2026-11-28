import {
  DEFAULT_PLAYLIST_CATEGORIES,
  PLAYBACK_SPEEDS,
  PLAYLISTS_SCHEMA_VERSION,
  PLAYLISTS_STORAGE_KEY,
  type PlaybackSpeed,
  type PlayerPreferences,
  type Playlist,
  type PlaylistCategory,
  type PlaylistLibraryState,
  type PlaylistTrack,
  type TrackLoopMarkers,
} from "@/features/playlists/playlistTypes";
import { getDefaultYouTubeThumbnail, isValidYouTubeVideoId } from "@/features/playlists/youtubeUtils";

export interface LoadLibraryResult {
  library: PlaylistLibraryState;
  recoveredFromError: string | null;
  storageAvailable: boolean;
}

export interface SaveLibraryResult {
  ok: boolean;
  error: string | null;
}

export type ImportLibraryValidation =
  | {
      valid: true;
      library: PlaylistLibraryState;
      warnings: string[];
    }
  | {
      valid: false;
      error: string;
    };

export function createPlaylistId(prefix = "pl"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultPreferences(): PlayerPreferences {
  return {
    shuffle: false,
    autoAdvance: true,
    playbackRate: 1.0,
    miniPlayerEnabled: false,
  };
}

export function createDefaultLibrary(): PlaylistLibraryState {
  return {
    schemaVersion: PLAYLISTS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    categories: DEFAULT_PLAYLIST_CATEGORIES.map((c) => ({ ...c })),
    playlists: [],
    preferences: createDefaultPreferences(),
  };
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith("data:")) return false;
  return /^https?:\/\//i.test(trimmed);
}

function sanitizeLoopMarkers(raw: unknown): TrackLoopMarkers {
  if (!raw || typeof raw !== "object") {
    return { aSec: null, bSec: null };
  }
  const obj = raw as Record<string, unknown>;
  const rawA = obj.aSec;
  const rawB = obj.bSec;
  const aSec =
    typeof rawA === "number" && Number.isFinite(rawA) && rawA >= 0
      ? Number(rawA.toFixed(2))
      : null;
  const bSec =
    typeof rawB === "number" && Number.isFinite(rawB) && rawB >= 0
      ? Number(rawB.toFixed(2))
      : null;
  if (aSec !== null && bSec !== null && bSec <= aSec) {
    return { aSec, bSec: null };
  }
  return { aSec, bSec };
}

function sanitizePlaybackRate(value: unknown): PlaybackSpeed {
  const num = typeof value === "number" ? value : Number(value);
  if ((PLAYBACK_SPEEDS as readonly number[]).includes(num)) {
    return num as PlaybackSpeed;
  }
  return 1.0;
}

function sanitizePreferences(raw: unknown): PlayerPreferences {
  const defaults = createDefaultPreferences();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  return {
    shuffle: typeof obj.shuffle === "boolean" ? obj.shuffle : defaults.shuffle,
    autoAdvance: typeof obj.autoAdvance === "boolean" ? obj.autoAdvance : defaults.autoAdvance,
    playbackRate: sanitizePlaybackRate(obj.playbackRate),
    miniPlayerEnabled:
      typeof obj.miniPlayerEnabled === "boolean"
        ? obj.miniPlayerEnabled
        : defaults.miniPlayerEnabled,
  };
}

function sanitizeCategories(raw: unknown): PlaylistCategory[] {
  const byId = new Map<string, PlaylistCategory>();
  for (const def of DEFAULT_PLAYLIST_CATEGORIES) {
    byId.set(def.id, { ...def });
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!id || !name) continue;
      const existingDefault = byId.get(id);
      if (existingDefault) {
        byId.set(id, { ...existingDefault, name });
      } else {
        byId.set(id, {
          id,
          name: name.slice(0, 60),
          isDefault: Boolean(obj.isDefault),
        });
      }
    }
  }
  return Array.from(byId.values());
}

function sanitizeTrack(raw: unknown, validCategoryIds: Set<string>, nowIso: string): PlaylistTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const sourceType = obj.sourceType === "youtube" || obj.sourceType === "project_audio"
    ? obj.sourceType
    : null;
  if (!sourceType) return null;

  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 200) : "";
  if (!title) return null;

  const categoryRaw = typeof obj.categoryId === "string" ? obj.categoryId.trim() : "";
  const categoryId = validCategoryIds.has(categoryRaw) ? categoryRaw : "cat-practice-reference";

  if (sourceType === "youtube") {
    const vid = typeof obj.youtubeVideoId === "string" ? obj.youtubeVideoId.trim() : "";
    if (!isValidYouTubeVideoId(vid)) return null;
    const thumbnailUrl = isSafeHttpUrl(obj.thumbnailUrl)
      ? obj.thumbnailUrl.trim()
      : getDefaultYouTubeThumbnail(vid);
    const youtubeUrl = isSafeHttpUrl(obj.youtubeUrl)
      ? obj.youtubeUrl.trim()
      : `https://www.youtube.com/watch?v=${vid}`;
    return {
      id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createPlaylistId("trk"),
      sourceType: "youtube",
      title,
      artist: typeof obj.artist === "string" ? obj.artist.trim().slice(0, 160) : "",
      categoryId,
      thumbnailUrl,
      practiceNotes: typeof obj.practiceNotes === "string" ? obj.practiceNotes.slice(0, 2000) : "",
      loop: sanitizeLoopMarkers(obj.loop),
      youtubeVideoId: vid,
      youtubeUrl,
      durationSec:
        typeof obj.durationSec === "number" && Number.isFinite(obj.durationSec) && obj.durationSec >= 0
          ? obj.durationSec
          : null,
      addedAt: typeof obj.addedAt === "string" && obj.addedAt ? obj.addedAt : nowIso,
      updatedAt: typeof obj.updatedAt === "string" && obj.updatedAt ? obj.updatedAt : nowIso,
    };
  }

  const projectId = typeof obj.projectId === "string" ? obj.projectId.trim() : "";
  if (!projectId) return null;
  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createPlaylistId("trk"),
    sourceType: "project_audio",
    title,
    artist: typeof obj.artist === "string" ? obj.artist.trim().slice(0, 160) : "",
    categoryId,
    thumbnailUrl: isSafeHttpUrl(obj.thumbnailUrl) ? obj.thumbnailUrl.trim() : null,
    practiceNotes: typeof obj.practiceNotes === "string" ? obj.practiceNotes.slice(0, 2000) : "",
    loop: sanitizeLoopMarkers(obj.loop),
    projectId,
    mediaAssetId:
      typeof obj.mediaAssetId === "string" && obj.mediaAssetId.trim()
        ? obj.mediaAssetId.trim()
        : null,
    projectTitle:
      typeof obj.projectTitle === "string" && obj.projectTitle.trim()
        ? obj.projectTitle.trim().slice(0, 200)
        : null,
    mediaFilename:
      typeof obj.mediaFilename === "string" && obj.mediaFilename.trim()
        ? obj.mediaFilename.trim().slice(0, 255)
        : null,
    mediaMimeType:
      typeof obj.mediaMimeType === "string" && obj.mediaMimeType.trim()
        ? obj.mediaMimeType.trim().slice(0, 128)
        : null,
    durationSec:
      typeof obj.durationSec === "number" && Number.isFinite(obj.durationSec) && obj.durationSec >= 0
        ? obj.durationSec
        : null,
    addedAt: typeof obj.addedAt === "string" && obj.addedAt ? obj.addedAt : nowIso,
    updatedAt: typeof obj.updatedAt === "string" && obj.updatedAt ? obj.updatedAt : nowIso,
  };
}

function sanitizePlaylists(
  raw: unknown,
  validCategoryIds: Set<string>,
  nowIso: string,
): Playlist[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const out: Playlist[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const rawId = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createPlaylistId("pl");
    const id = seenIds.has(rawId) ? createPlaylistId("pl") : rawId;
    seenIds.add(id);

    const title = typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, 200)
      : "Untitled Playlist";
    const categoryRaw = typeof obj.categoryId === "string" ? obj.categoryId.trim() : "";
    const categoryId = validCategoryIds.has(categoryRaw) ? categoryRaw : "cat-practice-reference";

    const tracks: PlaylistTrack[] = [];
    const rawTracks = Array.isArray(obj.tracks) ? obj.tracks : [];
    for (const tr of rawTracks) {
      const sanitized = sanitizeTrack(tr, validCategoryIds, nowIso);
      if (sanitized) tracks.push(sanitized);
    }

    out.push({
      id,
      serverId: typeof obj.serverId === "string" ? obj.serverId : null,
      title,
      description: typeof obj.description === "string" ? obj.description.slice(0, 2000) : "",
      categoryId,
      tracks,
      isShared: Boolean(obj.isShared && typeof obj.shareToken === "string" && obj.shareToken),
      shareToken:
        Boolean(obj.isShared) && typeof obj.shareToken === "string" && obj.shareToken
          ? obj.shareToken
          : null,
      sharedAt: typeof obj.sharedAt === "string" ? obj.sharedAt : null,
      createdAt: typeof obj.createdAt === "string" && obj.createdAt ? obj.createdAt : nowIso,
      updatedAt: typeof obj.updatedAt === "string" && obj.updatedAt ? obj.updatedAt : nowIso,
    });
  }

  return out;
}

export function migrateAndSanitizeLibrary(raw: unknown): PlaylistLibraryState {
  const nowIso = new Date().toISOString();
  if (!raw || typeof raw !== "object") {
    return createDefaultLibrary();
  }
  const obj = raw as Record<string, unknown>;
  // Supports v0 legacy data missing schemaVersion or older version numbers smoothly
  const categories = sanitizeCategories(obj.categories);
  const validCatIds = new Set(categories.map((c) => c.id));
  const playlists = sanitizePlaylists(obj.playlists, validCatIds, nowIso);
  const preferences = sanitizePreferences(obj.preferences);

  return {
    schemaVersion: PLAYLISTS_SCHEMA_VERSION,
    updatedAt: typeof obj.updatedAt === "string" && obj.updatedAt ? obj.updatedAt : nowIso,
    categories,
    playlists,
    preferences,
  };
}

export function loadPlaylistLibrary(): LoadLibraryResult {
  try {
    if (
      typeof window === "undefined" ||
      typeof window.localStorage?.getItem !== "function"
    ) {
      return {
        library: createDefaultLibrary(),
        recoveredFromError: null,
        storageAvailable: false,
      };
    }

    const rawStr = window.localStorage.getItem(PLAYLISTS_STORAGE_KEY);
    if (!rawStr) {
      return {
        library: createDefaultLibrary(),
        recoveredFromError: null,
        storageAvailable: true,
      };
    }

    const parsed: unknown = JSON.parse(rawStr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        library: createDefaultLibrary(),
        recoveredFromError: "Stored playlist data had an unexpected format and was reset safely.",
        storageAvailable: true,
      };
    }

    const obj = parsed as Record<string, unknown>;
    const hadMissingSchema = typeof obj.schemaVersion !== "number";
    const migrated = migrateAndSanitizeLibrary(parsed);

    if (hadMissingSchema || obj.schemaVersion !== PLAYLISTS_SCHEMA_VERSION) {
      try {
        window.localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(migrated));
      } catch {
        // Ignore re-persist error during load
      }
    }

    return {
      library: migrated,
      recoveredFromError: null,
      storageAvailable: true,
    };
  } catch {
    return {
      library: createDefaultLibrary(),
      recoveredFromError:
        "Stored playlist data was corrupted or unreadable; loaded a clean default library.",
      storageAvailable:
        typeof window !== "undefined" && typeof window.localStorage?.setItem === "function",
    };
  }
}

export function savePlaylistLibrary(library: PlaylistLibraryState): SaveLibraryResult {
  try {
    if (
      typeof window === "undefined" ||
      typeof window.localStorage?.setItem !== "function"
    ) {
      return {
        ok: false,
        error: "Browser localStorage is unavailable; changes cannot be saved locally.",
      };
    }
    const sanitized = migrateAndSanitizeLibrary(library);
    window.localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(sanitized));
    return { ok: true, error: null };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "QuotaExceededError"
        ? "Local browser storage quota exceeded. Export your playlists (.json) and free space."
        : "Unable to persist playlists to localStorage. Export a JSON backup to avoid losing changes.";
    return { ok: false, error: msg };
  }
}

export function buildPlaylistExportPayload(library: PlaylistLibraryState) {
  const clean = migrateAndSanitizeLibrary(library);
  return {
    app: "ScribaSheet",
    exportType: "playlists_library",
    exportedAt: new Date().toISOString(),
    schemaVersion: PLAYLISTS_SCHEMA_VERSION,
    categories: clean.categories,
    playlists: clean.playlists.map((pl) => ({
      ...pl,
      serverId: undefined,
      isShared: undefined,
      shareToken: undefined,
      sharedAt: undefined,
    })),
    preferences: clean.preferences,
  };
}

export function downloadPlaylistsJson(library: PlaylistLibraryState): string {
  const payload = buildPlaylistExportPayload(library);
  const jsonText = JSON.stringify(payload, null, 2);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `scribasheet-playlists-${dateStamp}.json`;

  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}

export function validateAndParseImportJson(rawText: string): ImportLibraryValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, error: "Invalid JSON file. Please select a valid ScribaSheet playlists JSON backup." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, error: "Playlist JSON must be an object containing schemaVersion and playlists." };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.schemaVersion !== "number" || obj.schemaVersion < 1) {
    return { valid: false, error: "Missing or invalid 'schemaVersion' field in playlist JSON." };
  }
  if (!Array.isArray(obj.playlists)) {
    return { valid: false, error: "Missing 'playlists' array in playlist JSON." };
  }

  const warnings: string[] = [];
  let droppedTracks = 0;
  for (const rawPl of obj.playlists) {
    if (!rawPl || typeof rawPl !== "object") {
      return { valid: false, error: "Playlist entries inside 'playlists' must be valid objects." };
    }
    const plObj = rawPl as Record<string, unknown>;
    if (typeof plObj.title !== "string" || !plObj.title.trim()) {
      return { valid: false, error: "Each playlist in the JSON file must have a non-empty 'title'." };
    }
    if (!Array.isArray(plObj.tracks)) {
      return { valid: false, error: `Playlist "${plObj.title}" is missing a valid 'tracks' array.` };
    }
    for (const tr of plObj.tracks) {
      if (!tr || typeof tr !== "object") {
        droppedTracks += 1;
        continue;
      }
      const trObj = tr as Record<string, unknown>;
      if (typeof trObj.thumbnailUrl === "string" && trObj.thumbnailUrl.trim().toLowerCase().startsWith("data:")) {
        return { valid: false, error: "Embedded binary data URIs are not permitted in playlist JSON files." };
      }
    }
  }

  const sanitized = migrateAndSanitizeLibrary(parsed);
  const rawTrackCount = obj.playlists.reduce((acc, p) => {
    const arr = (p as { tracks?: unknown[] }).tracks;
    return acc + (Array.isArray(arr) ? arr.length : 0);
  }, 0);
  const keptTrackCount = sanitized.playlists.reduce((acc, p) => acc + p.tracks.length, 0);
  const skipped = droppedTracks + Math.max(0, rawTrackCount - keptTrackCount);
  if (skipped > 0) {
    warnings.push(`${skipped} invalid or incomplete track ${skipped === 1 ? "entry was" : "entries were"} skipped.`);
  }

  return {
    valid: true,
    library: sanitized,
    warnings,
  };
}

export function applyImportedLibrary(
  existing: PlaylistLibraryState,
  imported: PlaylistLibraryState,
  mode: "merge" | "replace",
): PlaylistLibraryState {
  const nowIso = new Date().toISOString();
  if (mode === "replace") {
    return migrateAndSanitizeLibrary({
      ...imported,
      updatedAt: nowIso,
      playlists: imported.playlists.map((pl) => ({
        ...pl,
        id: createPlaylistId("pl"),
        serverId: null,
        isShared: false,
        shareToken: null,
        sharedAt: null,
        tracks: pl.tracks.map((tr) => ({
          ...tr,
          id: createPlaylistId("trk"),
        })),
      })),
    });
  }

  // Safe merge: keep all existing categories & playlists, deduplicate category IDs/names,
  // rename conflicting playlist titles cleanly, and allocate fresh unique IDs on collisions.
  const mergedCategories = [...existing.categories];
  const categoryIdMap = new Map<string, string>();
  const existingCatIds = new Set(mergedCategories.map((c) => c.id));
  const existingCatByName = new Map(mergedCategories.map((c) => [c.name.toLowerCase(), c.id]));

  for (const impCat of imported.categories) {
    const sameId = existingCatIds.has(impCat.id);
    const sameNameId = existingCatByName.get(impCat.name.toLowerCase());
    if (sameId) {
      categoryIdMap.set(impCat.id, impCat.id);
    } else if (sameNameId) {
      categoryIdMap.set(impCat.id, sameNameId);
    } else {
      mergedCategories.push({ ...impCat, isDefault: false });
      existingCatIds.add(impCat.id);
      existingCatByName.set(impCat.name.toLowerCase(), impCat.id);
      categoryIdMap.set(impCat.id, impCat.id);
    }
  }

  const usedPlaylistIds = new Set(existing.playlists.map((p) => p.id));
  const usedTitles = new Set(existing.playlists.map((p) => p.title.trim().toLowerCase()));
  const usedTrackIds = new Set(
    existing.playlists.flatMap((p) => p.tracks.map((t) => t.id)),
  );

  const importedAdditions: Playlist[] = imported.playlists.map((pl) => {
    const nextId = usedPlaylistIds.has(pl.id) ? createPlaylistId("pl") : pl.id;
    usedPlaylistIds.add(nextId);

    let nextTitle = pl.title.trim();
    if (usedTitles.has(nextTitle.toLowerCase())) {
      let candidate = `${nextTitle} (Imported)`;
      let counter = 2;
      while (usedTitles.has(candidate.toLowerCase())) {
        candidate = `${nextTitle} (Imported ${counter})`;
        counter += 1;
      }
      nextTitle = candidate;
    }
    usedTitles.add(nextTitle.toLowerCase());

    const mappedCategory = categoryIdMap.get(pl.categoryId) || "cat-practice-reference";

    const seenTrackSignatures = new Set<string>();
    const tracks: PlaylistTrack[] = [];
    for (const tr of pl.tracks) {
      const sig =
        tr.sourceType === "youtube"
          ? `yt:${tr.youtubeVideoId || ""}`
          : `proj:${tr.projectId || ""}:${tr.mediaAssetId || ""}`;
      if (seenTrackSignatures.has(sig)) continue;
      seenTrackSignatures.add(sig);

      const trId = usedTrackIds.has(tr.id) ? createPlaylistId("trk") : tr.id;
      usedTrackIds.add(trId);
      tracks.push({
        ...tr,
        id: trId,
        categoryId: categoryIdMap.get(tr.categoryId) || mappedCategory,
      });
    }

    return {
      ...pl,
      id: nextId,
      serverId: null,
      isShared: false,
      shareToken: null,
      sharedAt: null,
      title: nextTitle,
      categoryId: mappedCategory,
      tracks,
      updatedAt: nowIso,
    };
  });

  return {
    schemaVersion: PLAYLISTS_SCHEMA_VERSION,
    updatedAt: nowIso,
    categories: mergedCategories,
    playlists: [...existing.playlists, ...importedAdditions],
    preferences: existing.preferences,
  };
}
