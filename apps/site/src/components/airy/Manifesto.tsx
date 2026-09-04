"use client";

import { useEffect, useRef } from "react";

/**
 * The signature move of the system: one long sentence whose words warm from
 * line-grey to ink as they cross the fold. It is the only scroll-driven
 * animation on the page, and it earns its place by making the reader slow
 * down on the one sentence that says what missura is.
 *
 * Under prefers-reduced-motion the CSS ships every word already lit, so the
 * observer below is never wired up and the sentence is simply readable.
 */
export function Manifesto({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const words = Array.from(root.querySelectorAll<HTMLElement>(".ac-word"));

    const paint = () => {
      // 60% of the viewport height is the line words light up on, measured
      // from the source. Above it, lit; below it, still grey.
      const fold = window.innerHeight * 0.6;
      for (const w of words) {
        w.classList.toggle("is-lit", w.getBoundingClientRect().top < fold);
      }
    };

    paint();
    window.addEventListener("scroll", paint, { passive: true });
    window.addEventListener("resize", paint);
    return () => {
      window.removeEventListener("scroll", paint);
      window.removeEventListener("resize", paint);
    };
  }, []);

  return (
    <p ref={ref} className="ac-manifesto max-w-[20ch] sm:max-w-[24ch]">
      {text.split(" ").map((word, i) => (
        // words repeat in a sentence, so position is what identifies one
        <span key={`${word}-${i}`} className="ac-word">
          {word}{" "}
        </span>
      ))}
    </p>
  );
}
