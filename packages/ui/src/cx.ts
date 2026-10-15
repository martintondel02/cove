/**
 * Join conditional class names.
 *
 * Hand-rolled rather than pulling in `clsx`/`classnames`: the package is
 * intentionally dependency-free, and this covers every call site we have.
 */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}
