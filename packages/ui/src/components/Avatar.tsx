import type { HTMLAttributes } from "react";
import { cx } from "../cx";

export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  src?: string;
  /** Accessible name. Omit when a visible name sits next to the avatar. */
  alt?: string;
  size?: AvatarSize;
}

/**
 * Avatar — a circular identity chip.
 *
 * Falls back to the accent gradient when there is no image, so a missing or
 * still-uploading avatar reads as intentional rather than as a broken image.
 * Without an `alt` the <img> is decorative (empty alt), which is the correct
 * default next to a visible display name.
 */
export function Avatar({ src, alt, size = "md", className, children, ...rest }: AvatarProps) {
  return (
    <span className={cx("cove-avatar", `cove-avatar--${size}`, className)} {...rest}>
      {src ? (
        <img className="cove-avatar__img" src={src} alt={alt ?? ""} loading="lazy" decoding="async" />
      ) : (
        children
      )}
    </span>
  );
}
