import type { HTMLAttributes } from "react";
import { cx } from "../cx";

export type BadgeVariant = "neutral" | "live" | "glass";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/**
 * Badge — a small status pill.
 *
 * `live` is the only variant that carries motion: a 6px white dot on a 1.9s
 * pulse. The dot is `aria-hidden` because the word "Live" is already the
 * accessible label, and the animation is disabled under reduced motion (see
 * components.css) so the signal survives without the flicker.
 */
export function Badge({ variant = "neutral", className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("cove-badge", `cove-badge--${variant}`, className)} {...rest}>
      {variant === "live" ? <span className="cove-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
