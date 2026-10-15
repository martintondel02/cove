import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cx } from "../cx";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Lift and deepen the shadow on hover. Turn off for static panels. */
  interactive?: boolean;
  /** Apply the standard card padding. Off for cards that bleed media to the edge. */
  padded?: boolean;
}

/**
 * Card — the surface primitive.
 *
 * Owns the "layered depth, no hard borders" rule: one hairline border plus a
 * soft shadow, and on hover a 3px lift into the deeper shadow (the distance lives
 * in `--card-lift`, so the `cardStyle` theme knob can flatten it to nothing).
 * The transform is declared in CSS rather than inline because reduced-motion
 * handling is global, and the transition must be reachable by that override.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive = true, padded = true, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        "cove-card",
        interactive && "cove-card--interactive",
        padded && "cove-card--padded",
        className,
      )}
      {...rest}
    />
  );
});
