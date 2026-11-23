import React from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", type = "button", ...props }, ref) => {
    const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
      primary:
        "bg-violet-600 text-white hover:bg-violet-700 active:bg-violet-800 font-semibold shadow-sm border border-violet-700/20 dark:bg-[#8B5CF6] dark:text-[#F5F3FF] dark:hover:bg-[#7C3AED] dark:active:bg-[#6D28D9] dark:font-medium dark:shadow-[#8B5CF6]/20 dark:border-[#A78BFA]/30",
      secondary:
        "bg-white text-stone-800 hover:bg-stone-100 border border-stone-300 shadow-sm font-medium dark:bg-[#181825] dark:text-[#F5F3FF] dark:hover:bg-[#232336] dark:border-[#27273A]",
      outline:
        "bg-white text-stone-800 hover:bg-stone-100 border border-stone-300 shadow-sm font-medium dark:bg-transparent dark:text-[#F5F3FF] dark:hover:bg-[#181825] dark:border-[#27273A] dark:hover:border-[#A78BFA]/50",
      ghost:
        "bg-transparent text-stone-700 hover:text-stone-950 hover:bg-stone-200/70 disabled:text-stone-400 dark:text-[#A1A1AA] dark:hover:text-[#F5F3FF] dark:hover:bg-[#181825] dark:disabled:text-[#A1A1AA]",
      danger:
        "bg-red-50 hover:bg-red-100 text-red-700 border border-red-300 font-medium disabled:bg-stone-100 disabled:text-stone-400 disabled:border-stone-200 disabled:cursor-not-allowed disabled:opacity-100 dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25 dark:border-red-500/30 dark:disabled:opacity-50",
    };

    const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
      sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
      md: "h-10 px-4 text-sm rounded-lg gap-2",
      lg: "h-11 px-6 text-base rounded-xl gap-2",
    };

    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
