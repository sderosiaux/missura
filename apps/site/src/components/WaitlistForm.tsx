"use client";

import Link from "next/link";
import { useId, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

const ENDPOINT = process.env.NEXT_PUBLIC_WAITLIST_ENDPOINT;

export function WaitlistForm({ id }: { id: string }) {
  const inputId = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState("");

  if (!ENDPOINT) {
    return (
      <p
        className="label-mono max-w-xl border-t border-line pt-3 text-ink-soft"
        id={id}
      >
        Waitlist opens soon — the endpoint isn&apos;t wired yet.
      </p>
    );
  }

  // Narrowed above; a local const keeps the type inside the closure.
  const endpoint = ENDPOINT;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "loading") return;
    setStatus("loading");
    const form = new FormData(e.currentTarget);
    if ((form.get("company") as string)?.length > 0) {
      setStatus("success"); // honeypot: pretend, submit nothing
      return;
    }
    const email = (form.get("email") as string)?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setStatus("error");
      return;
    }
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "missura-landing" }),
      });
      setStatus(res.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div
        className="max-w-xl border border-bound/30 bg-bound-soft rounded-md px-5 py-4"
        role="status"
      >
        <p className="stamp stamp-allow mb-2">On the list</p>
        <p className="text-[0.95rem]">
          You&apos;re on the list. We&apos;ll reach out to schedule a
          walkthrough with your agent and one SaaS.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-xl" noValidate>
      <label htmlFor={inputId} className="label-mono text-ink-soft block mb-2">
        Get early access — we onboard one agent and one SaaS at a time
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          id={inputId}
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="work email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 min-w-0 rounded-md border border-line bg-white px-4 py-3 font-mono text-[0.9rem] placeholder:text-ink-soft/60"
        />
        {/* Honeypot — hidden from real users */}
        <input
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-md bg-bound px-6 py-3 font-medium text-white transition-colors hover:bg-[#0b573c] disabled:opacity-60"
        >
          {status === "loading" ? "Sending…" : "Get early access"}
        </button>
      </div>
      <p className="mt-2 text-[0.8rem] text-ink-soft" aria-live="polite">
        {status === "error" ? (
          <span className="text-deny">
            Something failed on our side. Please try again, or email us
            directly.
          </span>
        ) : (
          <>
            Email only. No spam, no resale.{" "}
            <Link href="/privacy" className="underline underline-offset-2">
              Privacy
            </Link>
          </>
        )}
      </p>
      <span className="sr-only" id={id} />
    </form>
  );
}
