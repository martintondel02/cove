import { forwardRef } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
  Ref,
} from "react";
import { cx } from "../cx";

export type ButtonVariant = "primary" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md";

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

/**
 * Props are a discriminated union: adding `href` turns the button into an anchor
 * and makes the anchor-only attributes available. There is no `asChild` (that
 * needs a Slot primitive we deliberately do not depend on); a plain `href`
 * covers every link-that-looks-like-a-button case.
 */
export type ButtonProps = ButtonOwnProps &
  (
    | (Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & {
        href?: undefined;
      })
    | (Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonOwnProps> & { href: string })
  );

/**
 * Button — the one clickable primitive.
 *
 * Renders <button type="button"> unless `href` is set, in which case it renders
 * an <a> with identical styling and the same focus ring. The default `type` for
 * a real button is "button" so it can never submit a form by accident.
 */
export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function Button(props, ref) {
    const { variant = "primary", size = "md", className, children, ...rest } = props;
    const classes = cx("cove-btn", `cove-btn--${variant}`, `cove-btn--${size}`, className);

    if (rest.href !== undefined) {
      const anchorProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
      return (
        <a ref={ref as Ref<HTMLAnchorElement>} {...anchorProps} className={classes}>
          {children}
        </a>
      );
    }

    // In this branch `href` is undefined, so the spread cannot leak it onto the
    // button element (React drops undefined-valued props).
    const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        className={classes}
      >
        {children}
      </button>
    );
  },
);
