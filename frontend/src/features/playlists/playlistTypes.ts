export const PLAYLISTS_STORAGE_KEY = "scribasheet_playlists_v1";
export const PLAYLISTS_SCHEMA_VERSION = 1;

export const PLAYBACK_SPEEDS = [0.5, 0.75, 0.85, 1.0, 1.25] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type TrackSourceType = "youtube" | "project_audio";

export interface PlaylistCategory {
  id: string;
  name: string;
  isDefault: boolean;
}

export const DEFAULT_PLAYLIST_CATEGORIES: PlaylistCategory[] = [
  { id: "cat-classical-violin", name: "Classical Violin", isDefault: true },
  { id: "cat-choral-satb", name: "Choral / SATB", isDefault: true },
  { id: "cat-piano-arrangements", name: "Piano Arrangements", isDefault: true },
  { id: "cat-practice-reference", name: "Practice / Reference", isDefault: true },
  { id: "cat-sight-reading", name: "Sight-Reading", isDefault: true },
];

export interface TrackLoopMarkers {
  aSec: number | null;
  bSec: number | null;
}

export interface PlaylistTrack {
  id: string;
  sourceType: TrackSourceType;
  title: string;
  artist: string;
  categoryId: string;
  thumbnailUrl: string | null;
  practiceNotes: string;
  loop: TrackLoopMarkers;
  youtubeVideoId?: string | null;
  youtubeUrl?: string | null;
  projectId?: string | null;
  mediaAssetId?: string | null;
  projectTitle?: string | null;
  mediaFilename?: string | null;
  mediaMimeType?: string | null;
  durationSec?: number | null;
  addedAt: string;
  updatedAt: string;
}

export interface Playlist {
  id: string;
  serverId?: string | null;
  title: string;
  description?: string;
  categoryId: string;
  tracks: PlaylistTrack[];
  isShared?: boolean;
  shareToken?: string | null;
  sharedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistShareStatus {
  playlistId: string;
  serverId: string;
  isShared: boolean;
  shareToken: string | null;
  sharedAt: string | null;
}

export interface PublicSharedTrack {
  position: number;
  title: string;
  artist: string;
  sourceType: TrackSourceType;
  thumbnailUrl: string | null;
  practiceNotes: string;
  loop: TrackLoopMarkers;
  youtubeVideoId?: string | null;
  youtubeUrl?: string | null;
  playablePublicly: boolean;
  unavailableReason?: string | null;
}

export interface PublicSharedPlaylist {
  title: string;
  description: string;
  categoryName: string;
  sharedAt: string | null;
  updatedAt: string;
  tracks: PublicSharedTrack[];
}

export interface PlayerPreferences {
  shuffle: boolean;
  autoAdvance: boolean;
  playbackRate: PlaybackSpeed;
  miniPlayerEnabled: boolean;
}

export interface PlaylistLibraryState {
  schemaVersion: number;
  updatedAt: string;
  categories: PlaylistCategory[];
  playlists: Playlist[];
  preferences: PlayerPreferences;
}

export interface PlaylistHandoffState {
  action: "transcribe" | "playground";
  sourceType: TrackSourceType;
  trackId: string;
  trackTitle: string;
  artist?: string;
  categoryId?: string;
  practiceNotes?: string;
  youtubeVideoId?: string | null;
  youtubeUrl?: string | null;
  sourceProjectId?: string | null;
  sourceMediaAssetId?: string | null;
  sourceMediaFilename?: string | null;
}
