import { useState } from "react";
import { LetterBadge } from "./LetterBadge";

/**
 * Hero image with a privacy-preserving fallback chain:
 * og:image → inline SVG letter monogram.
 *
 * The site favicon is deliberately NOT part of the hero chain — a 16×16
 * logo stretched across a 16:9 box reads as a broken/inaccurate image
 * (the live site showed favicon heroes on ~1/3 of cards). The monogram is
 * a designed "no image" placeholder: it costs zero network requests, and
 * the diagonal-stripe pattern shows through at 30% so the box reads as
 * intentional. (Article thumbnails in the story modal keep the favicon —
 * at 40×40 a site mark is legible and useful.)
 *
 * The wrapper owns the 16:9 aspect ratio and the img carries explicit
 * intrinsic dimensions (1280×720), so the browser reserves layout space
 * before the image arrives — no CLS.
 */
export function HeroImage({
  src,
  site,
  categoryColor,
  eager = false,
}: {
  src: string;
  site: string;
  /** Optional category color CSS var (e.g. "var(--color-cat-politics)") for the monogram fallback. */
  categoryColor?: string;
  /** Above-the-fold heroes (first card) may load eagerly; everything else lazy. */
  eager?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const exhausted = !src || broken;

  return (
    <div className="relative aspect-video overflow-hidden bg-ink">
      {(!src || broken) && (
        <div
          className="absolute inset-0 no-img opacity-30"
          style={{ "--color-badge": categoryColor } as React.CSSProperties}
          aria-hidden
        />
      )}
      {exhausted ? (
        <LetterBadge site={site} className="h-full w-full" color={categoryColor} />
      ) : (
        <img
          src={src}
          alt=""
          width={1280}
          height={720}
          loading={eager ? "eager" : "lazy"}
          decoding={eager ? "sync" : "async"}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover grayscale contrast-125"
        />
      )}
    </div>
  );
}