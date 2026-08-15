import { siteInitial } from "../types";

/**
 * Zero-network image fallback: the site's first letter as an inline SVG
 * monogram on the ink/acid palette. No request, no third-party dependency —
 * the browser never leaves the page. The square viewBox scales with
 * preserveAspectRatio="slice", so the same badge fills both the 16:9 hero
 * box and the 40×40 article thumbnail.
 */
export function LetterBadge({
  site,
  className = "",
}: {
  site: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect width="100" height="100" fill="var(--color-ink)" />
      <text
        x="50"
        y="50"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'Archivo Black', 'Arial Black', system-ui, sans-serif"
        fontSize="56"
        fill="var(--color-acid)"
      >
        {siteInitial(site)}
      </text>
    </svg>
  );
}