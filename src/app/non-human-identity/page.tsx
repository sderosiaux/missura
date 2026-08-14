import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Nav } from "@/components/SiteChrome";
import { WaitlistForm } from "@/components/WaitlistForm";

export const metadata: Metadata = {
  title: "Non-human identity is solved. Non-human permissions aren't. — Missura",
  description:
    "Workload identity, SPIFFE, OIDC, and NHI platforms tell you who a machine is. AI agents fail one layer down: what that identity can read. Why agent incidents are permission incidents.",
};

export default function NhiPage() {
  return (
    <div className="flex-1">
      <Nav />
      <main className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
        <p className="label-mono mb-5 text-ink-soft">
          Learn — non-human identity
        </p>
        <h1 className="max-w-[26ch] text-[clamp(2rem,4.5vw,3.2rem)] font-bold leading-[1.08]">
          Non-human identity is solved. Non-human permissions aren&apos;t.
        </h1>

        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="space-y-5 text-ink-soft lg:col-span-7">
            <p>
              The identity layer for machines is in good shape. Workload
              identity, SPIFFE/SPIRE, OIDC federation, and a wave of
              non-human-identity platforms will tell you exactly which
              workload is calling, attest it cryptographically, rotate its
              secrets, and inventory every service account you own. If your
              question is <em>&quot;who is this machine?&quot;</em>, you can
              buy a good answer today.
            </p>
            <p>
              AI agents break the layer underneath. A service account for a
              nightly sync job needs one static set of permissions forever. An
              agent&apos;s legitimate scope changes{" "}
              <strong className="text-ink">per task</strong>: this run
              investigates Acme, the next one drafts a changelog, the one
              after touches nothing but a single Notion subtree. Identity
              platforms have no vocabulary for that. Their unit is the
              workload; the risk&apos;s unit is the mission.
            </p>
            <p>
              So the well-attested, perfectly rotated, fully inventoried agent
              still holds a credential that opens every customer in Zendesk,
              every issue in Linear, every page in Notion. When a prompt
              injection lands, the identity layer performs flawlessly — it
              tells you precisely which workload exfiltrated everything.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="artefact" aria-label="Decision log entry showing identity known, permissions unbounded">
              <div className="head">
                <span>the incident, with perfect NHI</span>
                <span className="ml-auto">
                  <span className="stamp stamp-deny">Audit ≠ control</span>
                </span>
              </div>
              <pre>
                <span className="code-line">{"{"}</span>
                <span className="code-line">  &quot;workload&quot;: &quot;support-agent&quot;,   <span className="code-dim">{"//"} attested ✓</span></span>
                <span className="code-line">  &quot;instance&quot;: &quot;run-8f31&quot;,        <span className="code-dim">{"//"} known ✓</span></span>
                <span className="code-line">  &quot;secret_age&quot;: &quot;41s&quot;,           <span className="code-dim">{"//"} rotated ✓</span></span>
                <span className="code-line">  &quot;objects_read&quot;: 4812,          <span className="code-dim">{"//"} every customer</span></span>
                <span className="code-line">  &quot;scope_at_read_time&quot;: &quot;*&quot;      <span className="code-dim">{"//"} nobody&apos;s job</span></span>
                <span className="code-line">{"}"}</span>
              </pre>
            </div>
          </div>
        </div>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          The permission layer agents actually need
        </h2>
        <ul className="mt-6">
          {[
            {
              label: "Mission-scoped, not workload-scoped",
              body: "Authorization attaches to a 30-minute task with an explicit business scope — customer:acme — not to the agent's standing identity.",
            },
            {
              label: "Object-level, not scope-level",
              body: "Vendor scopes say read or admin. The control that matters says: these tickets, this customer's issues, this page subtree.",
            },
            {
              label: "Enforced in the data path",
              body: "Requests narrowed before the vendor call, responses filtered after. Deterministic rules — no LLM deciding access.",
            },
            {
              label: "Composes with your NHI stack",
              body: "Workload identity authenticates the agent to Missura. Missura decides what each request may touch. Who, then what.",
            },
          ].map((r) => (
            <li key={r.label} className="rule first:border-t-0">
              <div className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-12 sm:items-baseline">
                <p className="label-mono font-medium text-bound sm:col-span-4">
                  {r.label}
                </p>
                <p className="text-[0.95rem] text-ink-soft sm:col-span-8">
                  {r.body}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-10 max-w-[62ch] text-ink-soft">
          That layer is what{" "}
          <Link href="/" className="text-ink underline underline-offset-2">
            Missura
          </Link>{" "}
          builds: a vendor-compatible proxy that understands each SaaS API,
          holds the vendor credential, and limits every agent run to the exact
          objects its mission needs. Related reading:{" "}
          <Link
            href="/mcp-gateway"
            className="text-ink underline underline-offset-2"
          >
            why MCP gateways don&apos;t cover this
          </Link>{" "}
          and{" "}
          <Link
            href="/oauth-token-exchange-ai-agents"
            className="text-ink underline underline-offset-2"
          >
            the token mechanics underneath
          </Link>
          .
        </p>

        <div className="rule mt-16 pt-12">
          <h2 className="text-[clamp(1.5rem,2.8vw,2.2rem)] font-bold">
            Your NHI inventory is done. Now bound what it can read.
          </h2>
          <p className="mt-3 max-w-[52ch] text-ink-soft">
            Bring one agent and one SaaS. We&apos;ll show you the gap between
            its identity and its permissions.
          </p>
          <div className="mt-6" id="early-access">
            <WaitlistForm id="nhi-form" />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
