"use client";

import { useEffect, useRef } from "react";
import styles from "./MissionPass.module.css";

const MAX_TILT = 9; // degrees

const ROWS = [
  { label: "Agent", value: "support-investigator" },
  { label: "Access", value: "read-only" },
  { label: "Systems", value: "linear + github" },
  { label: "Expires", value: "30:00" },
  { label: "Id", value: "msn_482" },
] as const;

/**
 * The mission token given physical form: a vertical day-pass.
 * Pointer tilt (mouse only) = turning the credential in your hand;
 * touch and prefers-reduced-motion get the static pass.
 */
export function MissionPass({ className }: { className?: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const point = useRef({ x: 0.5, y: 0.5 });
  const reduced = useRef(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mql.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduced.current = e.matches;
    };
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const apply = () => {
    frame.current = 0;
    const card = cardRef.current;
    if (!card) return;
    const { x, y } = point.current;
    card.dataset.tilting = "true";
    card.style.setProperty("--ry", `${((x - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
    card.style.setProperty("--rx", `${((0.5 - y) * 2 * MAX_TILT).toFixed(2)}deg`);
    card.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    card.style.setProperty("--sheen", "1");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || reduced.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    point.current = {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
    if (!frame.current) frame.current = requestAnimationFrame(apply);
  };

  const onPointerLeave = () => {
    const card = cardRef.current;
    if (!card) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    card.dataset.tilting = "false";
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
    card.style.setProperty("--sheen", "0");
  };

  return (
    <div
      className={`${styles.scene} ${className ?? ""}`}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div
        ref={cardRef}
        className={styles.card}
        role="img"
        aria-label="Mission pass: scope customer:acme, agent support-investigator, read-only access to linear and github, expires in 30 minutes, id msn_482 — stamped BOUNDED. Worthless without missura, revocable in seconds."
      >
        {/* lanyard hint + punched slot */}
        <div aria-hidden="true" className="pt-3">
          <svg
            className={styles.lanyard}
            width="84"
            height="22"
            viewBox="0 0 84 22"
            fill="none"
          >
            <path
              d="M6 -4 L42 20 M78 -4 L42 20"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <div className={styles.slot} />
        </div>

        {/* header */}
        <div aria-hidden="true" className="px-6 pt-4">
          <p className="flex items-baseline justify-between border-b border-line pb-2 text-[0.68rem] uppercase tracking-[0.14em]">
            <span className="font-semibold">Missura</span>
            <span className="text-ink-soft">Mission Pass</span>
          </p>
        </div>

        {/* scope + stamp */}
        <div aria-hidden="true" className="relative px-6 pt-6 pb-5">
          <p className="text-[0.62rem] uppercase tracking-[0.18em] text-ink-soft">
            Scope
          </p>
          <p className="mt-1 text-[1.55rem] font-semibold leading-none tracking-tight">
            customer:acme
          </p>
          <span className={`${styles.stamp} absolute right-5 top-9`}>
            Bounded
          </span>
        </div>

        {/* rows */}
        <dl aria-hidden="true" className="mx-6 border-t border-line text-[0.8rem]">
          {ROWS.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between border-b border-line py-[0.55rem]"
            >
              <dt className="text-[0.62rem] uppercase tracking-[0.18em] text-ink-soft">
                {row.label}
              </dt>
              <dd
                className={
                  row.label === "Expires" ? "font-medium text-bound" : ""
                }
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* one deny-red micro-detail */}
        <p
          aria-hidden="true"
          className="px-6 pt-3 pb-5 text-[0.62rem] uppercase tracking-[0.14em] text-deny"
        >
          Everything else → 404
        </p>

        {/* perforated tear line + fine print stub */}
        <div aria-hidden="true" className={styles.tear} />
        <p
          aria-hidden="true"
          className="px-6 pt-3 pb-4 text-center text-[0.62rem] uppercase tracking-[0.12em] text-ink-soft"
        >
          worthless without missura · revocable in seconds
        </p>

        <div className={styles.grain} />
        <div className={styles.sheen} />
      </div>
    </div>
  );
}
