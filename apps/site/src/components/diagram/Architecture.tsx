/**
 * The shape of the system, before any of the copy explains it.
 *
 * Two paths leave the agent and they are drawn differently on purpose:
 * everything vendor-bound funnels through one gate, and the model call does
 * not. Saying so in a diagram is more honest than leaving a reader to assume
 * we sit in front of the LLM too.
 */

function ArrowRight({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-2 lg:h-full lg:w-[124px] lg:py-0">
      <span className="sr-only">{label}</span>
      <p className="hidden text-center font-mono text-[0.68rem] leading-tight tracking-[0.04em] text-ink-soft lg:block">
        {label}
      </p>
      {/* down on stacked layouts, right once the columns exist */}
      <svg
        viewBox="0 0 24 44"
        aria-hidden="true"
        className="h-9 w-6 text-ink-soft lg:hidden"
      >
        <path
          d="M12 2 v32"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M6 32 l6 8 l6 -8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <svg
        viewBox="0 0 44 24"
        aria-hidden="true"
        className="hidden h-6 w-9 flex-none text-ink lg:block"
      >
        <path
          d="M2 12 h32"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M32 6 l8 6 l-8 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

const VENDORS = [
  { name: "Zendesk", scope: "organization 9842" },
  { name: "Linear", scope: "customer c_18" },
  { name: "GitHub", scope: "repo /acme/**" },
];

const STEPS = [
  { verb: "catalog", body: "is this endpoint even known?" },
  { verb: "narrow", body: "add the vendor's own customer filter" },
  { verb: "filter", body: "drop what the mission cannot prove" },
  { verb: "log", body: "one signed line per decision" },
];

export function Architecture() {
  return (
    <figure className="m-0">
      {/* ── the uncontrolled path, drawn first because it sits above ── */}
      <div className="mx-auto max-w-[420px] lg:mx-0 lg:max-w-[360px]">
        <div className="rounded-lg border border-dashed border-line bg-paper-deep px-4 py-3">
          <p className="label-mono text-ink-soft">Model provider</p>
          <p className="mt-1 text-[0.9rem] text-ink-soft">
            Prompts and completions. Missura is not in this path — today the
            agent talks to its model directly.
          </p>
        </div>
        <div className="flex items-stretch gap-3 pl-6">
          <svg
            viewBox="0 0 12 40"
            aria-hidden="true"
            className="h-10 w-3 flex-none text-ink-soft"
          >
            <path
              d="M6 40 v-32"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="3 4"
            />
            <path d="M2 10 l4 -8 l4 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <p className="self-center font-mono text-[0.72rem] leading-tight tracking-[0.04em] text-ink-soft">
            not brokered, not filtered, not logged
          </p>
        </div>
      </div>

      {/* ── the controlled path ── */}
      <div className="grid grid-cols-1 items-stretch lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.95fr)_auto_minmax(0,0.8fr)]">
        <div className="rounded-lg border border-ink bg-white p-4 sm:p-5">
          <p className="label-mono text-ink-soft">Agent runtime</p>
          <div className="mt-3 rounded-md border border-line bg-paper p-3">
            <p className="font-medium">Your agent</p>
            <p className="mt-1 text-[0.9rem] text-ink-soft">
              The vendor SDK, unchanged. One base URL points here instead of
              the vendor.
            </p>
          </div>
          <dl className="mt-4">
            <div className="rule flex items-baseline justify-between gap-3 py-2">
              <dt className="font-mono text-[0.78rem] tracking-[0.04em] text-ink-soft">
                holds
              </dt>
              <dd className="font-mono text-[0.78rem] tracking-[0.04em] text-bound">
                MISSION_TOKEN · 30 min
              </dd>
            </div>
            <div className="rule flex items-baseline justify-between gap-3 py-2">
              <dt className="font-mono text-[0.78rem] tracking-[0.04em] text-ink-soft">
                holds
              </dt>
              <dd className="font-mono text-[0.78rem] tracking-[0.04em] text-ink-soft">
                no vendor credentials
              </dd>
            </div>
            <div className="rule flex items-baseline justify-between gap-3 py-2">
              <dt className="font-mono text-[0.78rem] tracking-[0.04em] text-ink-soft">
                knows
              </dt>
              <dd className="font-mono text-[0.78rem] tracking-[0.04em] text-ink-soft">
                one entity name
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-[0.85rem] text-ink-soft">
            It names the customer it works for. Which systems hold that
            customer, and under which ids, it never has to know — and cannot
            find out by probing.
          </p>
        </div>

        <ArrowRight label="every call to customer data" />

        <div className="rounded-lg border-2 border-ink bg-white p-4 shadow-[0_18px_36px_-30px_rgb(0_0_0/.4)] sm:p-5">
          <p className="label-mono text-ink-soft">Missura</p>
          <p className="mt-1 text-[0.9rem] text-ink-soft">
            Deterministic. No model in the path.
          </p>
          <ol className="mt-3">
            {STEPS.map((s) => (
              <li key={s.verb} className="rule py-2 first:border-t-0">
                <p className="font-mono text-[0.8rem] tracking-[0.04em]">
                  {s.verb}
                </p>
                <p className="text-[0.85rem] text-ink-soft">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-3 rounded-md bg-bound-soft px-3 py-2 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-bound">
            the real vendor credentials live here, and only here
          </p>
        </div>

        <ArrowRight label="with the real key" />

        <div className="rounded-lg border border-line bg-paper-deep p-4 sm:p-5">
          <p className="label-mono text-ink-soft">Vendor APIs</p>
          <ul className="mt-3">
            {VENDORS.map((v) => (
              <li key={v.name} className="rule py-2 first:border-t-0">
                <p className="font-medium">{v.name}</p>
                <p className="font-mono text-[0.75rem] tracking-[0.04em] text-ink-soft">
                  {v.scope}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.85rem] text-ink-soft">
            Reachable only through the gate. Anything outside the mission
            answers exactly like something that does not exist.
          </p>
        </div>
      </div>

      {/* ── who opened the door ── */}
      <div className="mt-5 flex flex-col gap-2 rounded-lg border border-line bg-paper-deep px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        <p className="label-mono flex-none text-ink-soft">Operator</p>
        <p className="text-[0.9rem] text-ink-soft">
          A human, or the event that started the work — a ticket arriving names
          its own customer. The mission is minted here and handed down.{" "}
          <span className="text-ink">The agent never mints its own.</span>
        </p>
      </div>

      <figcaption className="mt-4 font-mono text-[0.75rem] leading-relaxed tracking-[0.04em] text-ink-soft">
        fig. 00 — every call to a customer&apos;s data crosses one gate that
        holds the keys the agent does not. The model call does not cross it.
      </figcaption>
    </figure>
  );
}
