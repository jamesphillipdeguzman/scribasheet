import { api } from "@/services/api";

const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export type YouTubeUrlParseResult =
  | {
      valid: true;
      videoId: string;
      canonicalUrl: string;
      thumbnailUrl: string;
    }
  | {
      valid: false;
      error: string;
    };

export interface YouTubeMetadataResult {
  fetched: boolean;
  videoId: string;
  title: string | null;
  authorName: string | null;
  thumbnailUrl: string;
  error?: string;
}

export interface YouTubeBatchValidItem {
  rawUrl: string;
  videoId: string;
  canonicalUrl: string;
  thumbnailUrl: string;
}

export interface YouTubeBatchInvalidItem {
  rawUrl: string;
  error: string;
}

export interface YouTubeBatchDuplicateItem {
  rawUrl: string;
  videoId: string;
}

export interface YouTubeBatchParseResult {
  validItems: YouTubeBatchValidItem[];
  duplicateInBatch: YouTubeBatchDuplicateItem[];
  invalidItems: YouTubeBatchInvalidItem[];
}

export function isValidYouTubeVideoId(videoId: string | null | undefined): videoId is string {
  return typeof videoId === "string" && YOUTUBE_VIDEO_ID_REGEX.test(videoId.trim());
}

export function getDefaultYouTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function extractYouTubeVideoId(rawInput: string): YouTubeUrlParseResult {
  let trimmed = rawInput.trim().replace(/^[[(<"']+|[)\]>,"';]+$/g, "");
  if (!trimmed) {
    return { valid: false, error: "Please enter a YouTube video URL." };
  }

  // Allow protocol-less YouTube URLs such as youtu.be/<id> or www.youtube.com/watch?v=<id>
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const firstSegment = trimmed.split("/")[0].toLowerCase();
    if (ALLOWED_YOUTUBE_HOSTS.has(firstSegment)) {
      trimmed = `https://${trimmed}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Please enter a valid http/https YouTube URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "YouTube links must use http:// or https://." };
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_YOUTUBE_HOSTS.has(host)) {
    return {
      valid: false,
      error: "Unsupported URL host. Enter a youtube.com or youtu.be link.",
    };
  }

  let candidate: string | null = null;
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" || host === "www.youtu.be") {
    candidate = pathSegments[0] ?? null;
  } else if (
    pathSegments[0] === "shorts" ||
    pathSegments[0] === "embed" ||
    pathSegments[0] === "live" ||
    pathSegments[0] === "v"
  ) {
    candidate = pathSegments[1] ?? null;
  } else if (parsed.pathname === "/watch" || parsed.searchParams.has("v")) {
    candidate = parsed.searchParams.get("v");
  }

  const cleanId = candidate?.trim() ?? "";
  if (!isValidYouTubeVideoId(cleanId)) {
    return {
      valid: false,
      error:
        "Could not extract a valid 11-character YouTube video ID. Avoid bare playlist links without an individual video ID.",
    };
  }

  return {
    valid: true,
    videoId: cleanId,
    canonicalUrl: `https://www.youtube.com/watch?v=${cleanId}`,
    thumbnailUrl: getDefaultYouTubeThumbnail(cleanId),
  };
}

export function parseYouTubeUrlsBatch(rawInput: string): YouTubeBatchParseResult {
  const tokens = rawInput
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^[[(<"']+|[)\]>,"';]+$/g, ""))
    .filter(Boolean);

  const validItems: YouTubeBatchValidItem[] = [];
  const duplicateInBatch: YouTubeBatchDuplicateItem[] = [];
  const invalidItems: YouTubeBatchInvalidItem[] = [];
  const seenIds = new Set<string>();

  for (const token of tokens) {
    const res = extractYouTubeVideoId(token);
    if (!res.valid) {
      invalidItems.push({ rawUrl: token, error: res.error });
      continue;
    }
    if (seenIds.has(res.videoId)) {
      duplicateInBatch.push({ rawUrl: token, videoId: res.videoId });
      continue;
    }
    seenIds.add(res.videoId);
    validItems.push({
      rawUrl: token,
      videoId: res.videoId,
      canonicalUrl: res.canonicalUrl,
      thumbnailUrl: res.thumbnailUrl,
    });
  }

  return { validItems, duplicateInBatch, invalidItems };
}

export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadataResult> {
  const defaultThumb = getDefaultYouTubeThumbnail(videoId);
  if (!isValidYouTubeVideoId(videoId)) {
    return {
      fetched: false,
      videoId,
      title: null,
      authorName: null,
      thumbnailUrl: defaultThumb,
      error: "Invalid YouTube video ID.",
    };
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Try authenticated ScribaSheet oEmbed metadata endpoint first
  try {
    const res = await api.checkExternalUrl(canonicalUrl);
    if (res.title || res.author_name || res.thumbnail_url) {
      return {
        fetched: Boolean(res.title || res.author_name),
        videoId,
        title: res.title ?? null,
        authorName: res.author_name ?? null,
        thumbnailUrl:
          res.thumbnail_url && res.thumbnail_url.startsWith("http")
            ? res.thumbnail_url
            : defaultThumb,
      };
    }
  } catch {
    // Fall back to direct YouTube oEmbed endpoint
  }

  // 2. Fall back to official YouTube oEmbed JSON endpoint
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const resp = await fetch(oembedUrl);
    if (resp.ok) {
      const json = (await resp.json()) as {
        title?: unknown;
        author_name?: unknown;
        thumbnail_url?: unknown;
      };
      const title = typeof json.title === "string" && json.title.trim() ? json.title.trim() : null;
      const authorName =
        typeof json.author_name === "string" && json.author_name.trim()
          ? json.author_name.trim()
          : null;
      const thumb =
        typeof json.thumbnail_url === "string" && /^https?:\/\//i.test(json.thumbnail_url)
          ? json.thumbnail_url
          : defaultThumb;

      return {
        fetched: Boolean(title || authorName),
        videoId,
        title,
        authorName,
        thumbnailUrl: thumb,
      };
    }
  } catch {
    // Ignore network / CORS issues and allow manual entry
  }

  return {
    fetched: false,
    videoId,
    title: null,
    authorName: null,
    thumbnailUrl: defaultThumb,
    error: "Metadata could not be fetched automatically. You can enter title and composer details manually.",
  };
}

export async function fetchYouTubeMetadataBatch(
  videoIds: string[],
  concurrency = 3,
): Promise<Map<string, YouTubeMetadataResult>> {
  const uniqueIds = Array.from(new Set(videoIds.filter((id) => isValidYouTubeVideoId(id))));
  const results = new Map<string, YouTubeMetadataResult>();
  if (uniqueIds.length === 0) return results;

  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), uniqueIds.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < uniqueIds.length) {
      const idx = cursor++;
      const vid = uniqueIds[idx];
      try {
        const meta = await fetchYouTubeMetadata(vid);
        results.set(vid, meta);
      } catch {
        results.set(vid, {
          fetched: false,
          videoId: vid,
          title: null,
          authorName: null,
          thumbnailUrl: getDefaultYouTubeThumbnail(vid),
          error: "Metadata unavailable; using default title.",
        });
      }
    }
  });

  await Promise.all(workers);
  return results;
}
