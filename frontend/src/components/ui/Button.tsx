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
        "bg-[#8B5CF6] text-[#F5F3FF] hover:bg-[#7C3AED] active:bg-[#6D28D9] shadow-sm shadow-[#8B5CF6]/20 border border-[#A78BFA]/30",
      secondary:
        "bg-[#181825] text-[#F5F3FF] hover:bg-[#232336] border border-[#27273A]",
      outline:
        "bg-transparent text-[#F5F3FF] hover:bg-[#181825] border border-[#27273A] hover:border-[#A78BFA]/50",
      ghost: "bg-transparent text-[#A1A1AA] hover:text-[#F5F3FF] hover:bg-[#181825]",
      danger:
        "bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/30",
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
