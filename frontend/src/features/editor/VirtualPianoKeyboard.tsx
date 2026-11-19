import React, { useMemo, useRef } from "react";
import { midiToNoteName } from "@/lib/utils";

export interface PlaybackActivePitch {
  pitchMidi: number;
  trackIndex: number;
}

interface VirtualPianoKeyboardProps {
  minPitch?: number;
  maxPitch?: number;
  activePlaybackNotes: PlaybackActivePitch[];
  activeMidiPitches: Set<number>;
  rePitchArmed?: boolean;
  onKeyDown: (pitchMidi: number, velocity?: number) => void;
  onKeyUp: (pitchMidi: number) => void;
}

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

export function VirtualPianoKeyboard({
  minPitch = 21, // A0 (88-key lower bound)
  maxPitch = 108, // C8 (88-key upper bound)
  activePlaybackNotes,
  activeMidiPitches,
  rePitchArmed = false,
  onKeyDown,
  onKeyUp,
}: VirtualPianoKeyboardProps) {
  const pressedMouseKeysRef = useRef<Set<number>>(new Set());

  const { whiteKeys, blackKeys } = useMemo(() => {
    const whites: number[] = [];
    const blacks: { pitch: number; leftPercent: number }[] = [];
    for (let p = minPitch; p <= maxPitch; p++) {
      if (!BLACK_PCS.has(p % 12)) {
        whites.push(p);
      }
    }
    const totalWhites = Math.max(1, whites.length);
    let whiteIdx = 0;
    for (let p = minPitch; p <= maxPitch; p++) {
      if (!BLACK_PCS.has(p % 12)) {
        whiteIdx++;
      } else {
        // Position black key centered over the boundary between whiteIdx-1 and whiteIdx
        const leftPercent = ((whiteIdx - 0.34) / totalWhites) * 100;
        blacks.push({ pitch: p, leftPercent });
      }
    }
    return { whiteKeys: whites, blackKeys: blacks };
  }, [minPitch, maxPitch]);

  const playbackTrackByPitch = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of activePlaybackNotes) {
      // Prefer Vocal/Lead (track 0) if overlapping, otherwise record accompaniment track
      const prev = map.get(item.pitchMidi);
      if (prev === undefined || item.trackIndex < prev) {
        map.set(item.pitchMidi, item.trackIndex);
      }
    }
    return map;
  }, [activePlaybackNotes]);

  const handlePressStart = (pitch: number, e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (pressedMouseKeysRef.current.has(pitch)) return;
    pressedMouseKeysRef.current.add(pitch);
    onKeyDown(pitch, 90);
  };

  const handlePressEnd = (pitch: number) => {
    if (!pressedMouseKeysRef.current.has(pitch)) return;
    pressedMouseKeysRef.current.delete(pitch);
    onKeyUp(pitch);
  };

  const whiteWidthPercent = 100 / Math.max(1, whiteKeys.length);
  const blackWidthPercent = whiteWidthPercent * 0.66;

  return (
    <div
      data-testid="virtual-piano-keyboard"
      className="w-full overflow-x-auto rounded-lg border border-[#27273A] bg-[#09090F] p-1.5 select-none"
    >
      <div
        className="relative h-24 min-w-[780px] w-full"
        role="group"
        aria-label="Virtual Piano Keyboard"
      >
        {/* White Keys */}
        <div className="flex h-full w-full">
          {whiteKeys.map((pitch) => {
            const isC = pitch % 12 === 0;
            const isMidiActive = activeMidiPitches.has(pitch);
            const playbackTrack = playbackTrackByPitch.get(pitch);
            const isVocalPlaying = playbackTrack === 0;
            const isAccompPlaying = playbackTrack !== undefined && playbackTrack > 0;
            const label = midiToNoteName(pitch);

            let bgClass = "bg-[#E4E4E7] hover:bg-[#F4F4F5] text-[#52525B]";
            if (isMidiActive) {
              bgClass = rePitchArmed
                ? "bg-amber-300 text-[#09090F] ring-1 ring-amber-400"
                : "bg-[#A78BFA] text-[#09090F]";
            } else if (isVocalPlaying) {
              bgClass = "bg-[#C4B5FD] text-[#1E1B4B]";
            } else if (isAccompPlaying) {
              bgClass = "bg-[#7DD3FC] text-[#082F49]";
            }

            return (
              <button
                key={pitch}
                type="button"
                data-pitch={pitch}
                aria-label={`Piano key ${label}`}
                onMouseDown={(e) => handlePressStart(pitch, e)}
                onMouseUp={() => handlePressEnd(pitch)}
                onMouseLeave={() => handlePressEnd(pitch)}
                onTouchStart={(e) => handlePressStart(pitch, e)}
                onTouchEnd={() => handlePressEnd(pitch)}
                onTouchCancel={() => handlePressEnd(pitch)}
                style={{ width: `${whiteWidthPercent}%` }}
                className={`relative h-full border-r border-b border-[#27273A] last:border-r-0 rounded-b-sm flex items-end justify-center pb-1 text-[9px] font-mono transition-colors ${bgClass}`}
              >
                {isC && (
                  <span className="font-semibold leading-none pointer-events-none">
                    {label}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Black Keys */}
        {blackKeys.map(({ pitch, leftPercent }) => {
          const isMidiActive = activeMidiPitches.has(pitch);
          const playbackTrack = playbackTrackByPitch.get(pitch);
          const isVocalPlaying = playbackTrack === 0;
          const isAccompPlaying = playbackTrack !== undefined && playbackTrack > 0;
          const label = midiToNoteName(pitch);

          let bgClass = "bg-[#181825] hover:bg-[#27273A] border-[#09090F]";
          if (isMidiActive) {
            bgClass = rePitchArmed
              ? "bg-amber-400 border-amber-200"
              : "bg-[#8B5CF6] border-[#C4B5FD]";
          } else if (isVocalPlaying) {
            bgClass = "bg-[#7C3AED] border-[#DDD6FE]";
          } else if (isAccompPlaying) {
            bgClass = "bg-[#0284C7] border-[#BAE6FD]";
          }

          return (
            <button
              key={pitch}
              type="button"
              data-pitch={pitch}
              aria-label={`Piano key ${label}`}
              onMouseDown={(e) => handlePressStart(pitch, e)}
              onMouseUp={() => handlePressEnd(pitch)}
              onMouseLeave={() => handlePressEnd(pitch)}
              onTouchStart={(e) => handlePressStart(pitch, e)}
              onTouchEnd={() => handlePressEnd(pitch)}
              onTouchCancel={() => handlePressEnd(pitch)}
              style={{
                left: `${leftPercent}%`,
                width: `${blackWidthPercent}%`,
              }}
              className={`absolute top-0 h-[58%] z-10 rounded-b-sm border shadow-sm transition-colors ${bgClass}`}
            />
          );
        })}
      </div>
    </div>
  );
}
