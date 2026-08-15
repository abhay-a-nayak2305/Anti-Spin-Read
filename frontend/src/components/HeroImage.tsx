import { useState } from "react";
import { faviconUrl } from "../types";
import { LetterBadge } from "./LetterBadge";

/**
 * Hero image with a privacy-preserving fallback chain:
 * og:image → site favicon (`<host>/favicon.ico`, no Google lookup) → inline
 * SVG letter monogram. The final badge costs zero network requests, so the
 * hero box is always filled.
 *
 * The wrapper owns the 16:9 aspect ratio and the img carries explicit
 * intrinsic dimensions (1280×720), so the browser reserves layout space
 * before the image arrives — no CLS.
 */
export function HeroImage({
  src,
  site,
  eager = false,
}: {
  src: string;
  site: string;
  /** Above-the-fold heroes (first card) may load eagerly; everything else lazy. */
  eager?: boolean;
}) {
  const [srcIndex, setSrcIndex] = useState(0);
  const candidates = [src, faviconUrl(site)].filter(Boolean);
  const current = candidates[srcIndex];
  const exhausted = srcIndex >= candidates.length;

  return (
    <div className="relative aspect-video overflow-hidden bg-ink">
      {srcIndex > 0 && (
        <div className="absolute inset-0 no-img opacity-30" aria-hidden />
      )}
      {exhausted ? (
        <LetterBadge site={site} className="h-full w-full" />
      ) : (
        <img
          src={current}
          alt=""
          width={1280}
          height={720}
          loading={eager ? "eager" : "lazy"}
          decoding={eager ? "sync" : "async"}
          referrerPolicy="no-referrer"
          onError={() => setSrcIndex((i) => i + 1)}
          className="h-full w-full object-cover grayscale contrast-125"
        />
      )}
    </div>
  );
}