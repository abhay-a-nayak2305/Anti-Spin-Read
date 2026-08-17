import { useState } from "react";

/**
 * Brutalist search form. Submits on Enter or the SEARCH button; a live
 * query is always reflected in the input so the user can refine it.
 * Disabled while a query is in flight or the input is too short (<2 chars —
 * the backend rejects those anyway).
 */
export function SearchBox({
  onSearch,
  busy = false,
}: {
  onSearch: (q: string) => void;
  busy?: boolean;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value);
      }}
      className="flex w-full sm:max-w-md"
    >
      <label htmlFor="search-input" className="sr-only">
        Search stories
      </label>
      <input
        id="search-input"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search stories…"
        autoComplete="off"
        spellCheck={false}
        className="w-full border-2 border-ink bg-paper px-3 py-2 font-display text-sm uppercase tracking-wide placeholder:normal-case placeholder:text-ink/40 focus:bg-acid/20 focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || value.trim().length < 2}
        className="shrink-0 border-2 border-l-0 border-ink bg-ink px-3 font-display text-xs uppercase tracking-wide text-paper transition-colors hover:bg-acid hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Searching…" : "Search"}
      </button>
    </form>
  );
}