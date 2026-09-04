"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Horizontal snap scroller that starts at the content edge and bleeds off the
 * right, so the row reads as continuing past the page rather than ending.
 * Arrows are hidden below the breakpoint where the rail is swipeable anyway.
 */
export function Rail({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [sync]);

  const nudge = (dir: 1 | -1) => {
    const el = ref.current;
    if (el === null) return;
    const step = el.querySelector("div")?.clientWidth ?? 400;
    el.scrollBy({ left: dir * (step + 16), behavior: "smooth" });
  };

  return (
    <>
      <div ref={ref} onScroll={sync} className="ac-rail -mr-5 pr-5 sm:-mr-8 sm:pr-8">
        {children}
      </div>
      <div className="mt-8 hidden gap-3 lg:flex">
        <button
          type="button"
          aria-label="Previous"
          disabled={atStart}
          onClick={() => nudge(-1)}
          className="grid h-11 w-11 place-items-center rounded-full border border-line transition-colors hover:bg-paper-deep disabled:opacity-35"
        >
          <span aria-hidden="true">←</span>
        </button>
        <button
          type="button"
          aria-label="Next"
          disabled={atEnd}
          onClick={() => nudge(1)}
          className="grid h-11 w-11 place-items-center rounded-full border border-line transition-colors hover:bg-paper-deep disabled:opacity-35"
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </>
  );
}
