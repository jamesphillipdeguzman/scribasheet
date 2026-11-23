import { cn } from "@/lib/utils";

interface AmbientScoreBackdropProps {
  variant?: "hero" | "watermark";
  className?: string;
}

/**
 * Decorative, non-interactive ambient musical score backdrop using /images/hero1.webp.
 * Feathered with a radial CSS mask so no rectangular edges are visible.
 */
export function AmbientScoreBackdrop({
  variant = "hero",
  className,
}: AmbientScoreBackdropProps) {
  const isHero = variant === "hero";

  const maskGradient = isHero
    ? "radial-gradient(ellipse 78% 72% at 50% 40%, rgba(0, 0, 0, 0.96) 0%, rgba(0, 0, 0, 0.55) 48%, rgba(0, 0, 0, 0) 82%)"
    : "radial-gradient(ellipse 72% 68% at 78% 28%, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.35) 45%, rgba(0, 0, 0, 0) 80%)";

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
      {isHero && (
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.14),transparent_65%)]" />
      )}
      <div
        className="absolute inset-0"
        style={{
          maskImage: maskGradient,
          WebkitMaskImage: maskGradient,
        }}
      >
        <img
          src="/images/hero1.webp"
          alt=""
          draggable={false}
          loading={isHero ? "eager" : "lazy"}
          decoding="async"
          className={cn(
            "h-full w-full object-cover object-center mix-blend-luminosity",
            isHero
              ? "opacity-[0.11] animate-ambient-breathe"
              : "opacity-[0.05]",
          )}
          style={{
            filter: isHero
              ? "saturate(1.15) hue-rotate(-10deg) contrast(1.06) brightness(0.9)"
              : "saturate(1.05) hue-rotate(-10deg) contrast(1.02) brightness(0.85)",
          }}
        />
      </div>
    </div>
  );
}
