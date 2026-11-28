export interface YTPlayer {
  playVideo?: () => void;
  pauseVideo?: () => void;
  stopVideo?: () => void;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime?: () => number;
  getDuration?: () => number;
  setPlaybackRate?: (suggestedRate: number) => void;
  getPlaybackRate?: () => number;
  getAvailablePlaybackRates?: () => number[];
  loadVideoById?: (videoId: string, startSeconds?: number) => void;
  cueVideoById?: (videoId: string, startSeconds?: number) => void;
  destroy?: () => void;
}

export interface YTApiNamespace {
  Player: new (
    elementOrId: HTMLElement | string,
    options: {
      height?: string | number;
      width?: string | number;
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YTPlayer }) => void;
        onStateChange?: (event: { target: YTPlayer; data: number }) => void;
        onError?: (event: { target: YTPlayer; data: number }) => void;
        onPlaybackRateChange?: (event: { target: YTPlayer; data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState?: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YTApiNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export function describeYouTubePlayerError(code: number): string {
  switch (code) {
    case 2:
      return "Invalid YouTube video ID or playback parameter.";
    case 5:
      return "This video cannot be played in the HTML5 embedded player.";
    case 100:
      return "This YouTube video was removed or marked private.";
    case 101:
    case 150:
      return "Playback blocked: the video owner does not allow embedding outside YouTube.";
    default:
      return "YouTube player encountered a network or playback error.";
  }
}

let ytLoadPromise: Promise<YTApiNamespace> | null = null;

export function resetYouTubeIframeApiForTests(): void {
  ytLoadPromise = null;
}

export function loadYouTubeIframeApi(): Promise<YTApiNamespace> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("YouTube IFrame API requires a browser environment."));
  }

  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (ytLoadPromise) {
    return ytLoadPromise;
  }

  ytLoadPromise = new Promise<YTApiNamespace>((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    const timeoutId = window.setTimeout(() => {
      ytLoadPromise = null;
      reject(new Error("Timed out loading YouTube IFrame Player API."));
    }, 10_000);

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeoutId);
      if (typeof prevReady === "function") {
        try {
          prevReady();
        } catch {
          // ignore previous hook error
        }
      }
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        ytLoadPromise = null;
        reject(new Error("YouTube IFrame API loaded without YT.Player."));
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://www.youtube.com/iframe_api"]',
    );
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeoutId);
        ytLoadPromise = null;
        reject(new Error("Unable to load YouTube IFrame Player API script (check network or ad-blocker)."));
      };
      document.head.appendChild(script);
    }
  });

  return ytLoadPromise;
}
