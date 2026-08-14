import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Nav } from "@/components/SiteChrome";
import { WaitlistForm } from "@/components/WaitlistForm";

export const metadata: Metadata = {
  title: "OAuth token exchange for AI agents (RFC 8693) — Missura",
  description:
    "How OAuth 2.0 token exchange, rich authorization requests, and DPoP apply to AI agents — trading long-lived credentials for short, downscoped mission tokens, and where the standards stop.",
};

export default function TokenExchangePage() {
  return (
    <div className="flex-1">
      <Nav />
      <main className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
        <p className="label-mono mb-5 text-ink-soft">
          Learn — OAuth token exchange
        </p>
        <h1 className="max-w-[26ch] text-[clamp(2rem,4.5vw,3.2rem)] font-bold leading-[1.08]">
          OAuth token exchange for AI agents, explained.
        </h1>

        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="space-y-5 text-ink-soft lg:col-span-7">
            <p>
              <strong className="text-ink">
                OAuth 2.0 Token Exchange (RFC 8693)
              </strong>{" "}
              defines how to trade one token for another: present a credential
              to a token service, get back a token that is shorter-lived,
              narrower, and bound to a specific audience. For agents, this is
              the right primitive — the orchestrator exchanges a durable
              connection for a per-task token instead of handing the raw
              credential to the model loop.
            </p>
            <p>
              Two companion standards sharpen it.{" "}
              <strong className="text-ink">
                Rich Authorization Requests (RFC 9396)
              </strong>{" "}
              let a token carry structured detail about what it authorizes —
              not just <code className="font-mono text-[0.9em]">read</code>,
              but a JSON description of resources and actions.{" "}
              <strong className="text-ink">DPoP (RFC 9449)</strong> binds the
              token to a client key, so a stolen token is useless without the
              key that minted the proof. Together: short, precise, sender-bound
              tokens. This is exactly how a mission token should behave.
            </p>
            <p>
              Then you hit the wall:{" "}
              <strong className="text-ink">
                Zendesk, Linear, and Notion don&apos;t accept your tokens.
              </strong>{" "}
              You can express &quot;Acme&apos;s tickets, read-only, 30
              minutes&quot; in a beautiful RAR structure — no vendor API will
              honor it. Their scopes stop at read/write/admin, and no standard
              teaches their endpoints what a customer is.
            </p>
            <p>
              You already know the fix from elsewhere. AWS solved it with STS{" "}
              <code className="font-mono text-[0.9em]">AssumeRole</code>:
              temporary, scoped, expiring credentials — but AWS controls the
              resource server too. API gateways solved it with the phantom
              token pattern: validate an internal token at the edge, call the
              backend with a credential the backend actually trusts. For SaaS
              APIs you don&apos;t control, someone has to play that edge.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="artefact" aria-label="Mission token request and response">
              <div className="head">
                <span>POST /v1/token</span>
                <span className="ml-auto text-[#86d4b2]">● ephemeral</span>
              </div>
              <pre>
                <span className="code-line">{"{"}</span>
                <span className="code-line">  &quot;grant_type&quot;: &quot;client_credentials&quot;,</span>
                <span className="code-line">  &quot;authorization_details&quot;: [{"{"}   <span className="code-dim">{"//"} RFC 9396</span></span>
                <span className="code-line">    &quot;type&quot;: &quot;mission&quot;,</span>
                <span className="code-line">    &quot;scope&quot;: {"{ \"customer\": \"acme\" }"},</span>
                <span className="code-line">    &quot;ttl&quot;: 1800</span>
                <span className="code-line">  {"}"}]</span>
                <span className="code-line">{"}"}</span>
                <span className="code-line code-dim">─ response ───────────────────────</span>
                <span className="code-line">{"{"}</span>
                <span className="code-line">  &quot;access_token&quot;: &quot;msr_…&quot;,   <span className="code-dim">{"//"} revocable &lt; 5 s</span></span>
                <span className="code-line">  &quot;proxy_origins&quot;: {"{"}</span>
                <span className="code-line">    &quot;linear&quot;: &quot;https://linear.missura.dev&quot;</span>
                <span className="code-line">  {"}"}</span>
                <span className="code-line">{"}"}</span>
              </pre>
            </div>
          </div>
        </div>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          What the standards give you, and what they can&apos;t
        </h2>
        <ul className="mt-6">
          {[
            {
              label: "RFC 8693 — token exchange",
              body: "Trade a durable credential for a short, audience-bound token.",
              verdict: "use it",
              ok: true,
            },
            {
              label: "RFC 9396 — rich authorization",
              body: "Express object-level scope inside the token.",
              verdict: "use it",
              ok: true,
            },
            {
              label: "RFC 9449 — DPoP",
              body: "Bind the token to the agent instance's key.",
              verdict: "use it",
              ok: true,
            },
            {
              label: "Vendor API enforcement",
              body: "Nothing makes Zendesk, Linear, or Notion honor your mission scope. Their APIs never see it.",
              verdict: "the gap",
              ok: false,
            },
          ].map((r) => (
            <li key={r.label} className="rule first:border-t-0">
              <div className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-12 sm:items-baseline">
                <p className="font-mono text-[0.85rem] font-medium sm:col-span-4">
                  {r.label}
                </p>
                <p className="text-[0.95rem] text-ink-soft sm:col-span-6">
                  {r.body}
                </p>
                <p
                  className={`label-mono sm:col-span-2 sm:text-right ${r.ok ? "text-bound" : "text-deny"}`}
                >
                  {r.verdict}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-10 max-w-[62ch] space-y-5 text-ink-soft">
          <p>
            Closing that gap needs an enforcement point that speaks each
            vendor&apos;s API natively: parse the request, resolve which
            objects it touches, inject the vendor filter, verify the response
            object by object.{" "}
            <Link href="/" className="text-ink underline underline-offset-2">
              Missura
            </Link>{" "}
            is that point — mission tokens on the agent side (exchange-style,
            revocable in seconds), the real vendor credential vaulted
            server-side, and the mission scope enforced on every request and
            response. The standards handle the token; the proxy makes the
            vendor obey it. See also{" "}
            <Link
              href="/non-human-identity"
              className="text-ink underline underline-offset-2"
            >
              why identity alone doesn&apos;t cover this
            </Link>
            .
          </p>
        </div>

        <div className="rule mt-16 pt-12">
          <h2 className="text-[clamp(1.5rem,2.8vw,2.2rem)] font-bold">
            Want mission tokens without building the exchange?
          </h2>
          <p className="mt-3 max-w-[52ch] text-ink-soft">
            Bring one agent and one SaaS. First protected call in minutes, not
            a token-service project.
          </p>
          <div className="mt-6" id="early-access">
            <WaitlistForm id="rfc-form" />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
