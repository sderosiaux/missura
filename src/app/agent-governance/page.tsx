import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Nav } from "@/components/SiteChrome";
import { WaitlistForm } from "@/components/WaitlistForm";

export const metadata: Metadata = {
  title: "AI agent governance: the runtime layer — Missura",
  description:
    "Agent governance has five questions: who is the agent, what may it do, what did it touch, can you prove it, can you stop it. Where API gateways and identity stop, and what runtime enforcement adds.",
};

const QUESTIONS = [
  {
    q: "Who is the agent?",
    layer: "Workload identity / IAM / NHI platforms",
    state: "well served",
    ok: true,
    note: "Attestation, lifecycle, rotation. Missura composes with this layer — it doesn't replace it.",
  },
  {
    q: "What may it do, right now?",
    layer: "Runtime policy enforcement",
    state: "the gap",
    ok: false,
    note: "Per-task, object-level authorization decided in the data path — request narrowed before the vendor call, response filtered after.",
  },
  {
    q: "What did it actually touch?",
    layer: "Provenance",
    state: "the gap",
    ok: false,
    note: "An audit trail per decision: requested vs allowed vs returned vs removed, correlated with vendor request IDs.",
  },
  {
    q: "Can you prove it to an auditor?",
    layer: "Provenance, again",
    state: "the gap",
    ok: false,
    note: "Explainable decisions beat raw request logs. Every allow, narrow, and deny carries its reason and policy version.",
  },
  {
    q: "Can you stop it, mid-run?",
    layer: "Kill switch",
    state: "the gap",
    ok: false,
    note: "Ephemeral credentials that expire with the task and revoke in seconds — not vendor keys that outlive everything.",
  },
];

export default function AgentGovernancePage() {
  return (
    <div className="flex-1">
      <Nav />
      <main className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
        <p className="label-mono mb-5 text-ink-soft">
          Learn — AI agent governance
        </p>
        <h1 className="max-w-[26ch] text-[clamp(2rem,4.5vw,3.2rem)] font-bold leading-[1.08]">
          Agent governance is five questions. Most stacks answer one.
        </h1>

        <div className="mt-10 max-w-[68ch] space-y-5 text-ink-soft">
          <p>
            Every enterprise is heading into the same state: hundreds of
            agents, spun up faster than anyone can review them, each holding a
            credential someone pasted once and nobody tracks. Security teams
            call it <strong className="text-ink">agent sprawl</strong>; its
            invisible half is shadow AI — agents running on tokens that were
            never provisioned for them.
          </p>
          <p>
            The instinct is to reach for the existing layers: an API gateway
            for traffic, an identity platform for the machines, an AI gateway
            for prompts. Each is necessary. None of them decides, at runtime,
            whether <em>this specific call</em> by <em>this specific run</em>{" "}
            should reach <em>this specific customer&apos;s data</em> — or
            proves, afterward, exactly what came back. Gateways govern
            traffic; governance is about actions.
          </p>
        </div>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          The five questions
        </h2>
        <ul className="mt-6">
          {QUESTIONS.map((r) => (
            <li key={r.q} className="rule first:border-t-0">
              <div className="grid grid-cols-1 gap-1 py-5 sm:grid-cols-12 sm:items-baseline">
                <p className="font-semibold sm:col-span-4">{r.q}</p>
                <p className="text-[0.95rem] text-ink-soft sm:col-span-3">
                  {r.layer}
                </p>
                <p
                  className={`label-mono sm:col-span-2 ${r.ok ? "text-bound" : "text-deny"}`}
                >
                  {r.state}
                </p>
                <p className="text-[0.9rem] text-ink-soft sm:col-span-3">
                  {r.note}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          What Missura covers — and what it deliberately doesn&apos;t
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="space-y-5 text-ink-soft lg:col-span-7">
            <p>
              Missura is the <strong className="text-ink">runtime
              enforcement</strong> piece: a vendor-compatible proxy that
              understands each SaaS API semantically — which ticket belongs to
              which org, which issue to which customer — and applies a
              per-task policy on every request and response. Deterministic
              rules; no LLM in the decision path.
            </p>
            <p>
              Three of the five questions are its home ground:{" "}
              <strong className="text-ink">what may it do</strong> (narrow
              before, filter after, deny by default),{" "}
              <strong className="text-ink">what did it touch</strong> and{" "}
              <strong className="text-ink">can you prove it</strong>{" "}
              (provenance per decision), plus the{" "}
              <strong className="text-ink">kill switch</strong> (ephemeral
              mission credentials, revocable in seconds).
            </p>
            <p>
              The <em>who</em> question belongs to your identity stack —
              workload identity, IAM, non-human-identity platforms. Missura
              authenticates agents against it and takes over one layer down.
              One layer, done well, that composes with the rest.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="artefact" aria-label="A provenance record: requested, allowed, returned, removed">
              <div className="head">
                <span>provenance, per decision</span>
                <span className="ml-auto text-[#86d4b2]">● audit-ready</span>
              </div>
              <pre>
                <span className="code-line">{"{"}</span>
                <span className="code-line">  &quot;mission&quot;: &quot;msn_482&quot;,</span>
                <span className="code-line">  &quot;actor&quot;: &quot;alice@company.com&quot;,</span>
                <span className="code-line">  &quot;operation&quot;: &quot;IssuesQuery&quot;,</span>
                <span className="code-line">  &quot;decision&quot;: &quot;allow_with_filter&quot;,</span>
                <span className="code-line">  &quot;requested&quot;: &quot;customer:*&quot;,   <span className="code-dim">{"//"} what it asked</span></span>
                <span className="code-line">  &quot;allowed&quot;: &quot;customer:acme&quot;,  <span className="code-dim">{"//"} what it got</span></span>
                <span className="code-line">  &quot;objects_removed&quot;: 2,</span>
                <span className="code-line">  &quot;policy_version&quot;: &quot;p_192&quot;</span>
                <span className="code-line">{"}"}</span>
              </pre>
            </div>
          </div>
        </div>

        <p className="mt-10 max-w-[68ch] text-ink-soft">
          Related reading:{" "}
          <Link href="/mcp-gateway" className="text-ink underline underline-offset-2">
            why MCP gateways stop at the tool level
          </Link>
          ,{" "}
          <Link href="/non-human-identity" className="text-ink underline underline-offset-2">
            why identity alone isn&apos;t a control
          </Link>
          , and{" "}
          <Link href="/oauth-token-exchange-ai-agents" className="text-ink underline underline-offset-2">
            the token mechanics underneath
          </Link>
          .
        </p>

        <div className="rule mt-16 pt-12">
          <h2 className="text-[clamp(1.5rem,2.8vw,2.2rem)] font-bold">
            Governing agents this year?
          </h2>
          <p className="mt-3 max-w-[52ch] text-ink-soft">
            Bring one agent and one SaaS. We&apos;ll show you the runtime
            layer working on your own data — enforcement, provenance, kill
            switch.
          </p>
          <div className="mt-6" id="early-access">
            <WaitlistForm id="governance-form" />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
