import { toneClass } from "../types";

/**
 * Shared brutalist badges used by both StoryCard and StoryModal.
 * Each badge takes a className that is appended to the base classes, so call
 * sites keep their per-context sizing/rotation without duplicating markup.
 */

/** "N outlets" counter badge — number + outlet(s) label. */
export function SourceCountBadge({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  return (
    <span
      className={`flex items-baseline ${className}`}
      aria-label={`${count} outlets`}
    >
      <span className="font-display text-xl leading-none">{count}</span>
      <span className="text-[9px] font-bold uppercase tracking-widest text-ink/60">
        outlet{count > 1 ? "s" : ""}
      </span>
    </span>
  );
}

/** Tone chip — colored via toneClass, labeled "source: tone". */
export function ToneChip({
  source,
  tone,
  className = "",
}: {
  source: string;
  tone: string;
  className?: string;
}) {
  return (
    <span
      className={`tone-chip border-2 border-ink font-bold uppercase tracking-wide ${toneClass(tone)} ${className}`}
    >
      {source}: {tone}
    </span>
  );
}