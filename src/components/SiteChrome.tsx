import Image from "next/image";
import Link from "next/link";

export const LEARN_LINKS = [
  { href: "/agent-governance", label: "Agent governance" },
  { href: "/mcp-gateway", label: "MCP gateways" },
  { href: "/non-human-identity", label: "Non-human identity" },
  { href: "/oauth-token-exchange-ai-agents", label: "Token exchange" },
] as const;

export function Nav() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-[1120px] items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-mono text-[0.95rem] font-semibold tracking-tight"
        >
          <Image
            src="/logo-mark.png"
            alt=""
            aria-hidden
            width={30}
            height={30}
            className="h-[30px] w-[30px]"
            priority
          />
          missura
        </Link>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Learn">
          {LEARN_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="label-mono text-ink-soft transition-colors hover:text-bound"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <a
          href="#early-access"
          className="label-mono rounded-md border border-line px-4 py-2 transition-colors hover:border-bound hover:text-bound"
        >
          Get early access
        </a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="rule">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-5 py-8 text-[0.85rem] text-ink-soft sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p>
          Missura — early stage. We&apos;re validating with design partners; no
          public pricing yet.
        </p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer">
          {LEARN_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="underline underline-offset-2">
              {l.label}
            </Link>
          ))}
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
