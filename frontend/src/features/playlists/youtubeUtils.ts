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

export function isValidYouTubeVideoId(videoId: string | null | undefined): videoId is string {
  return typeof videoId === "string" && YOUTUBE_VIDEO_ID_REGEX.test(videoId.trim());
}

export function getDefaultYouTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function extractYouTubeVideoId(rawInput: string): YouTubeUrlParseResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: false, error: "Please enter a YouTube video URL." };
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
