import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy — Missura",
  description: "What we do with your email address. Short version: very little.",
};

export default function Privacy() {
  return (
    <main className="mx-auto max-w-[62ch] flex-1 px-5 py-16 sm:px-8">
      <p className="label-mono mb-4 text-ink-soft">Privacy</p>
      <h1 className="text-3xl font-bold">What we do with your email.</h1>
      <div className="mt-6 space-y-4 text-ink-soft">
        <p>
          When you join the early-access list, we store your email address with
          our email provider. We use it for one thing: contacting you about
          Missura early access and product updates.
        </p>
        <p>
          We do not sell it, share it, or add it to any other list. We do not
          send your email address to analytics tools, and we do not log it in
          plain text.
        </p>
        <p>
          Want it gone? Reply to any email we send you and we will delete it.
        </p>
      </div>
      <p className="mt-10">
        <Link href="/" className="underline underline-offset-2">
          ← Back
        </Link>
      </p>
    </main>
  );
}
