"use client";

import { useEffect, useState } from "react";
import styles from "./LiveTerminal.module.css";

const CMD = "missura exec --scope customer:acme --ttl 30m -- claude";

type Seg = { t: string; cls?: string };

/** Lines streamed after the command, each with a realistic pause before it. */
const TAIL: { pause: number; segs: Seg[] }[] = [
  {
    pause: 500,
    segs: [{ t: "mission msn_482 · read-only · expires 30:00", cls: "code-dim" }],
  },
  { pause: 400, segs: [{ t: " " }] },
  {
    pause: 750,
    segs: [
      { t: "ALLOW ", cls: "text-[#86d4b2]" },
      { t: "  linear  IssuesQuery" },
    ],
  },
  {
    pause: 650,
    segs: [
      { t: "NARROW", cls: "text-[#86d4b2]" },
      { t: "  linear  filter injected: customer = acme" },
    ],
  },
  {
    pause: 800,
    segs: [
      { t: "FILTER", cls: "text-[#86d4b2]" },
      { t: "  linear  2 objects removed " },
      { t: "(globex)", cls: "code-dim" },
    ],
  },
  {
    pause: 900,
    segs: [
      { t: "DENY  ", cls: "text-[#e39287]" },
      { t: "  github  /repos/other-corp → 404" },
    ],
  },
  { pause: 500, segs: [{ t: " " }] },
  {
    pause: 700,
    segs: [{ t: "the agent never sees a vendor credential", cls: "code-dim" }],
  },
];

/**
 * Self-typing terminal loop: types the missura exec command, streams the
 * decision tail (ALLOW / NARROW / FILTER / DENY), holds, clears, repeats.
 * Server-rendered (and reduced-motion) state is the full final transcript.
 */
export function LiveTerminal({ className = "" }: { className?: string }) {
  // Start fully rendered: correct for SSR, no-JS, and reduced motion.
  const [typed, setTyped] = useState(CMD.length);
  const [shown, setShown] = useState(TAIL.length);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return;
    let cancelled = false;
    const showAllStatic = () => {
      cancelled = true;
      setTyped(CMD.length);
      setShown(TAIL.length);
      setAnimating(false);
    };
    const onChange = () => {
      if (mq.matches) showAllStatic();
    };
    mq.addEventListener("change", onChange);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      setAnimating(true);
      while (!cancelled) {
        setTyped(0);
        setShown(0);
        await sleep(700);
        for (let i = 1; i <= CMD.length; i++) {
          if (cancelled) return;
          setTyped(i);
          await sleep(32);
        }
        for (let i = 0; i < TAIL.length; i++) {
          if (cancelled) return;
          await sleep(TAIL[i].pause);
          setShown(i + 1);
        }
        if (cancelled) return;
        await sleep(4000);
      }
    };
    void run();
    return () => {
      cancelled = true;
      mq.removeEventListener("change", onChange);
    };
  }, []);

  return (
    <div
      className={`artefact ${className}`}
      role="img"
      aria-live="off"
      aria-label="Terminal replay: missura exec wraps claude in a 30-minute read-only mission scoped to customer acme. A Linear query is allowed, a customer filter is injected, two out-of-scope objects are removed, and a GitHub call to another company's repo is denied with a 404. The agent never sees a vendor credential."
    >
      <div className="head">
        <span>terminal</span>
        <span className="ml-auto normal-case tracking-normal">live replay</span>
      </div>
      {/* min-height reserves the full transcript so the loop never shifts layout */}
      <pre className="min-h-[14.5rem]" aria-hidden="true">
        <span className="code-line">
          <span className="code-dim">$ </span>
          {CMD.slice(0, typed)}
          {animating && shown === 0 && <span className={styles.cursor} />}
        </span>
        {TAIL.slice(0, shown).map((line, i) => (
          <span key={i} className="code-line">
            {line.segs.map((seg, j) =>
              seg.cls ? (
                <span key={j} className={seg.cls}>
                  {seg.t}
                </span>
              ) : (
                <span key={j}>{seg.t}</span>
              ),
            )}
          </span>
        ))}
      </pre>
    </div>
  );
}
