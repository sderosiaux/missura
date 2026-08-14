import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Nav } from "@/components/SiteChrome";
import { WaitlistForm } from "@/components/WaitlistForm";

export const metadata: Metadata = {
  title: "MCP gateways vs API-level enforcement — Missura",
  description:
    "MCP gateways authenticate agents, broker credentials, and allowlist tools. They don't control which objects an agent can read. What an MCP gateway does, what it can't, and what closes the gap.",
};

export default function McpGatewayPage() {
  return (
    <div className="flex-1">
      <Nav />
      <main className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
        <p className="label-mono mb-5 text-ink-soft">Learn — MCP gateways</p>
        <h1 className="max-w-[24ch] text-[clamp(2rem,4.5vw,3.2rem)] font-bold leading-[1.08]">
          MCP gateways solve <em>who</em>. The incident is <em>what</em>.
        </h1>

        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="space-y-5 text-ink-soft lg:col-span-7">
            <p>
              An MCP gateway sits between your agents and your MCP servers. It
            authenticates the agent, brokers credentials so they don&apos;t
              live in agent configs, routes tool calls, applies rate limits,
              and allowlists which tools each agent may call. If you run more
              than a couple of MCP servers, you probably want one.
            </p>
            <p>
              Here is what it does not do: decide{" "}
              <strong className="text-ink">
                which objects the tool call may return
              </strong>
              . When your support agent calls{" "}
              <code className="font-mono text-[0.9em]">search_tickets</code>,
              the gateway checks that this agent may use that tool — then
              injects a vendor credential that opens the whole workspace. The
              tool executes with app-wide permissions. Every customer&apos;s
              tickets come back, because nothing in the path understands what
              a ticket is or who it belongs to.
            </p>
            <p>
              That is not a flaw in MCP gateways. It is a different layer.
              Tool-level allowlisting answers &quot;may this agent search
              tickets?&quot;. Object-level enforcement answers &quot;may this
              run see <em>this customer&apos;s</em> tickets?&quot;. Prompt
              injection attacks the second question, not the first: the
              attacker doesn&apos;t need a forbidden tool, they need a
              permitted tool with an over-broad credential behind it.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="artefact" aria-label="Tool call passing a gateway but returning every customer">
              <div className="head">
                <span>through an mcp gateway</span>
                <span className="ml-auto text-[#e39287]">● app-wide</span>
              </div>
              <pre>
                <span className="code-line code-dim">agent → gateway</span>
                <span className="code-line">  tool: search_tickets   <span className="code-dim">✓ allowlisted</span></span>
                <span className="code-line">  identity: run-8f31     <span className="code-dim">✓ authenticated</span></span>
                <span className="code-line code-dim">gateway → zendesk</span>
                <span className="code-line">  token: ZENDESK_ADMIN   <span className="code-dim">{"//"} injected, app-wide</span></span>
                <span className="code-line code-dim">response</span>
                <span className="code-line">  4,812 tickets — every customer</span>
              </pre>
            </div>
          </div>
        </div>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          Layer by layer
        </h2>
        <ul className="mt-6">
          {[
            {
              q: "Who is calling?",
              a: "MCP gateway / workload IAM",
              note: "Authentication, workload identity, credential brokering.",
              ok: true,
            },
            {
              q: "Which tools may it call?",
              a: "MCP gateway",
              note: "Tool allowlists, rate limits, routing.",
              ok: true,
            },
            {
              q: "Which objects may it read?",
              a: "Nothing in the MCP path",
              note: "Requires understanding the vendor API: tickets belong to orgs, issues to customers, pages to roots.",
              ok: false,
            },
            {
              q: "What comes back in the response?",
              a: "Nothing in the MCP path",
              note: "Requires filtering vendor responses object by object, without breaking the SDK schema.",
              ok: false,
            },
          ].map((r) => (
            <li key={r.q} className="rule first:border-t-0">
              <div className="grid grid-cols-1 gap-1 py-4 sm:grid-cols-12 sm:items-baseline">
                <p className="font-semibold sm:col-span-4">{r.q}</p>
                <p
                  className={`label-mono sm:col-span-3 ${r.ok ? "text-bound" : "text-deny"}`}
                >
                  {r.a}
                </p>
                <p className="text-[0.95rem] text-ink-soft sm:col-span-5">
                  {r.note}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <h2 className="mt-16 text-[clamp(1.5rem,2.5vw,2rem)] font-bold">
          What closes the gap
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="space-y-5 text-ink-soft lg:col-span-7">
            <p>
              Missura is a vendor-compatible proxy that sits where the vendor
              API is actually called — under your SDKs, and under your MCP
              servers if you use them. It parses each request, resolves which
              business objects it touches, narrows it to the mission&apos;s
              scope before the call, and filters the response after. The
              vendor credential stays in Missura&apos;s vault; the agent holds
              a 30-minute mission token.
            </p>
            <p>
              The two layers compose: keep your MCP gateway for identity,
              routing, and tool governance. Point its outbound vendor calls at
              Missura, and tool results shrink to the mission&apos;s objects —{" "}
              <Link href="/" className="text-ink underline underline-offset-2">
                a blast radius of one mission
              </Link>
              .
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="artefact" aria-label="Same tool call through Missura, limited to one customer">
              <div className="head">
                <span>with missura underneath</span>
                <span className="ml-auto text-[#86d4b2]">● acme only</span>
              </div>
              <pre>
                <span className="code-line code-dim">mcp server → missura</span>
                <span className="code-line">  token: MISSION_TOKEN   <span className="code-dim">{"//"} acme · read · 30 min</span></span>
                <span className="code-line"><span className="text-[#86d4b2]">NARROW</span>  organization_id = 9842 injected</span>
                <span className="code-line"><span className="text-[#86d4b2]">FILTER</span>  0 foreign objects in response</span>
                <span className="code-line code-dim">response</span>
                <span className="code-line">  37 tickets — acme only</span>
              </pre>
            </div>
          </div>
        </div>

        <div className="rule mt-16 pt-12">
          <h2 className="text-[clamp(1.5rem,2.8vw,2.2rem)] font-bold">
            Running agents behind an MCP gateway?
          </h2>
          <p className="mt-3 max-w-[52ch] text-ink-soft">
            Bring one agent and one SaaS. We&apos;ll show you what its tools
            can reach today — and how small that can get.
          </p>
          <div className="mt-6" id="early-access">
            <WaitlistForm id="mcp-form" />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
