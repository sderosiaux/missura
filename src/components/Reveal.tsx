"use client";

import { useEffect, useRef } from "react";

/**
 * Progressive enhancement: content is visible by default (SSR, no-JS).
 * After mount, elements still below the viewport get the .reveal class and
 * fade in on intersection. prefers-reduced-motion is handled in CSS.
 * DOM classes are toggled directly so the server markup stays visible.
 */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.getBoundingClientRect().top <= window.innerHeight * 0.92) {
      return; // already on screen at mount: never hide it
    }
    el.classList.add("reveal");
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("is-visible");
          obs.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      el.classList.remove("reveal", "is-visible");
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
