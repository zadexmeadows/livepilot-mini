import * as React from "react";
import { cn } from "@/lib/utils";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "secondary" | "outline" | "ghost" | "danger"; size?: "default" | "sm" | "icon" };
export function Button({ className, variant = "default", size = "default", ...props }: Props) {
  return <button className={cn("btn", `btn-${variant}`, `btn-${size}`, className)} {...props} />;
}
