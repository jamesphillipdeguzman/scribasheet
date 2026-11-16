import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  showText = true,
  size = "md",
}: {
  className?: string;
  showText?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const iconSize = size === "sm" ? "h-7 w-7" : size === "lg" ? "h-10 w-10" : "h-8 w-8";
  const textSize = size === "sm" ? "text-base" : size === "lg" ? "text-xl" : "text-lg";

  return (
    <span className={cn("inline-flex items-center gap-2.5 select-none", className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        className={iconSize}
        aria-hidden="true"
      >
        <rect width="64" height="64" rx="14" fill="#181825" />
        <rect x="2" y="2" width="60" height="60" rx="12" stroke="#A78BFA" strokeOpacity="0.4" strokeWidth="2" />
        <path
          d="M15 24H49M15 32H49M15 40H49"
          stroke="#A78BFA"
          strokeOpacity="0.32"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M27 42V19L43 15V37"
          stroke="#A78BFA"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="22.5" cy="42.5" r="5.5" fill="#A78BFA" />
        <circle cx="38.5" cy="37.5" r="5.5" fill="#8B5CF6" />
      </svg>
      {showText && (
        <span className={cn("font-semibold tracking-tight text-[#F5F3FF]", textSize)}>
          Scriba<span className="text-[#A78BFA]">Sheet</span>
        </span>
      )}
    </span>
  );
}
