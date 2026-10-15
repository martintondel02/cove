import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "../cx";

export type MediaAspect = "16:9" | "4:5" | "9:16";
export type MediaBadgePosition = "top-left" | "bottom-right";

/** Dominant colours extracted from the media at ingest time. */
export interface MediaAmbient {
  from: string;
  to: string;
}

const ASPECT_CLASS: Record<MediaAspect, string> = {
  "16:9": "cove-media--16x9",
  "4:5": "cove-media--4x5",
  "9:16": "cove-media--9x16",
};

/** ReactNode may be `0` or `""`, both falsy but both meaningful to render. */
function isSet(node: ReactNode): boolean {
  return node !== undefined && node !== null;
}

/** `title` is redefined as a node, so the native string tooltip attr is omitted. */
export interface MediaCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  /** Timestamp, view count, type. Rendered with tabular numerals. */
  meta?: ReactNode;
  /** The poster/video/picture. Any media is cropped with object-fit: cover. */
  media?: ReactNode;
  aspect?: MediaAspect;
  /** Duration chip, "New", or a <Badge variant="live">. */
  badge?: ReactNode;
  badgePosition?: MediaBadgePosition;
  /** Watch progress, 0–100. Clamped; ignored when not a finite number. */
  progress?: number;
  /** Ambient backdrop for the media frame. */
  ambient?: MediaAmbient;
  /** Makes the whole card one link. The title carries the accessible name. */
  href?: string;
  /** Only honoured with `href`; `_blank` gets noopener/noreferrer for free. */
  target?: string;
  /** Lift on hover. Off for cards inside an already-interactive container. */
  interactive?: boolean;
}

/**
 * MediaCard — the feed's core object.
 *
 * Video, reel and photo are the same card with a different `aspect`, which is
 * what lets one masonry feed hold mixed shapes. The media frame paints an
 * ambient gradient from the item's dominant colours *behind* the media: it makes
 * a plain CSS card read as expensive, and it guarantees the frame has content in
 * the first paint (before the poster image decodes) instead of a grey hole.
 *
 * The title is an <h3> by design: feed items sit under the page's h1/h2, and the
 * consumer owns the surrounding section headings.
 *
 * Renders <article> normally, or a single <a> when `href` is set — wrapping the
 * whole card beats a small "read more" target on touch, and the hover/focus
 * affordances come from the .cove-card styles in both cases.
 */
export function MediaCard({
  title,
  meta,
  media,
  aspect = "16:9",
  badge,
  badgePosition = "bottom-right",
  progress,
  ambient,
  href,
  target,
  interactive = true,
  className,
  ...rest
}: MediaCardProps) {
  const classes = cx(
    "cove-card",
    "cove-mediacard",
    interactive && "cove-card--interactive",
    href !== undefined && "cove-mediacard--link",
    className,
  );

  const showMedia = isSet(media) || ambient !== undefined;
  const clamped =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.min(100, Math.max(0, progress))
      : undefined;

  // Custom properties cannot be expressed in React's CSSProperties type, so the
  // ambient colours are handed to the .cove-media background as inline vars.
  const mediaStyle =
    ambient === undefined
      ? undefined
      : ({
          "--cove-amb-from": ambient.from,
          "--cove-amb-to": ambient.to,
        } as CSSProperties);

  const linkProps =
    href === undefined
      ? undefined
      : {
          href,
          ...(target === undefined
            ? {}
            : {
                target,
                rel: target === "_blank" ? "noopener noreferrer" : undefined,
              }),
        };

  const body = (
    <>
      {showMedia ? (
        <div className={cx("cove-media", ASPECT_CLASS[aspect])} style={mediaStyle}>
          {isSet(media) ? <div className="cove-media__content">{media}</div> : null}
          <span className="cove-media__sheen" aria-hidden="true" />
          {isSet(badge) ? (
            <span className={cx("cove-media__badge", `cove-media__badge--${badgePosition}`)}>
              {badge}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="cove-card__body">
        <h3 className="cove-mediacard__title">{title}</h3>
        {isSet(meta) ? <div className="cove-mediacard__meta">{meta}</div> : null}
        {clamped === undefined ? null : (
          /* Decorative: the bar is a glanceable affordance, and the percentage
             belongs in `meta` where the consumer controls wording and locale. */
          <div className="cove-progress" aria-hidden="true">
            <span className="cove-progress__bar" style={{ width: `${clamped}%` }} />
          </div>
        )}
      </div>
    </>
  );

  if (href !== undefined) {
    return (
      <a className={classes} {...(linkProps ?? {})} {...rest}>
        {body}
      </a>
    );
  }

  return (
    <article className={classes} {...rest}>
      {body}
    </article>
  );
}
