import { useTheme } from "@/features/theme/ThemeContext";
import { cn } from "@/lib/utils";

interface AmbientScoreBackdropProps {
  variant?: "hero" | "watermark";
  className?: string;
}

const FEATHER_MASK =
  "radial-gradient(ellipse 75% 70% at 50% 45%, black 35%, transparent 85%)";

/**
 * Decorative, non-interactive ambient musical score backdrop using /images/hero1.webp.
 * Feathered with a radial CSS mask so no rectangular edges are visible.
 */
export function AmbientScoreBackdrop({
  variant = "hero",
  className,
}: AmbientScoreBackdropProps) {
  const { theme } = useTheme();
  const isHero = variant === "hero";
  const isLight = theme === "light";

  const opacityClass = isHero
    ? isLight
      ? "opacity-[0.35]"
      : "opacity-[0.22]"
    : isLight
      ? "opacity-[0.18]"
      : "opacity-[0.12]";

  const blendClass = isLight ? "mix-blend-multiply" : "mix-blend-screen";

  return (
    <div
      aria-hidden="true"
      data-testid={`ambient-backdrop-${variant}`}
      className={cn(
        "pointer-events-none select-none overflow-hidden absolute inset-x-0 top-0 z-0",
        isHero ? "inset-y-0" : "h-64 sm:h-72",
        className,
      )}
    >
      {isHero && !isLight && (
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.18),rgba(245,158,11,0.05)_45%,transparent_72%)]" />
      )}
      <div
        className="absolute inset-0"
        style={{
          maskImage: FEATHER_MASK,
          WebkitMaskImage: FEATHER_MASK,
        }}
      >
        <img
          src="/images/hero1.webp"
          alt=""
          draggable={false}
          loading={isHero ? "eager" : "lazy"}
          decoding="async"
          className={cn(
            "h-full w-full object-cover object-center",
            blendClass,
            opacityClass,
            isHero && "animate-ambient-breathe",
          )}
          style={{
            filter: isLight
              ? "contrast(1.08) brightness(1.02) saturate(0.95)"
              : "saturate(1.2) hue-rotate(-8deg) contrast(1.08) brightness(0.92)",
          }}
        />
      </div>
    </div>
  );
}
