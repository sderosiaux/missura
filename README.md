# missura

Same API. Smaller permissions. For every agent.

A local proxy that speaks the vendor's API but only inside the boundary of a
short-lived mission a human created — so an agent never holds the credential and
never sees more than the task needs.

The problem it exists for: a support agent across Zendesk, Linear and GitHub is
the easiest one to justify and the hardest one to ship, because it reads every
customer's data on every run while holding one token that opens the whole
workspace. Missura binds each run to a single business entity instead — a
customer, an employee, a project; whatever the operator's graph names.

## Status

v0, in progress. Not production-ready. Read-only on every vendor route; three
writes exist, each runs only as a named operation, and two of them wait for a
human.

Working today: mission tokens minted by an operator (never by the agent), the
vault that keeps vendor credentials out of the agent's environment, connectors
for Linear, GitHub and Zendesk, type-driven request narrowing with response
filtering, missura-owned pagination cursors, and a hash-chained decision log.

Every mission resolves through an ENTITY GRAPH where only a human-confirmed
link widens it, and records the links it declined to use. Zendesk is optional:
`missura init` asks for a subdomain, an agent email and an API token, and a
deployment that gives none of the three simply serves the other two vendors.

## Layout

```
apps/site                 Next.js static landing page (waitlist)
packages/core             mission tokens, entity graph, shared primitives
packages/proxy            the data plane: catalog, narrow, filter, refill
packages/connectors-*     Linear, GitHub, Zendesk
packages/cli              missura init / run / exec / entity / approvals
examples/compat           live compatibility suite against real vendor APIs
```

## Two properties worth knowing about

**A refusal is indistinguishable from absence.** An object outside your mission
answers exactly like an object that does not exist — same status, same headers,
same bytes. Otherwise guessing identifiers would tell an agent which customers
are real.

**A mission degrades, it never blocks.** If a cross-system link has not been
confirmed by a human, that system is simply not in the mission and the agent is
told which ones are missing. A ticket arriving at 3am does not wait for someone
to approve a mapping.

**The agent is told what it is, and when its view was cut.** `GET
/missura/mission` with the mission token (the URL is in `MISSURA_MISSION_URL`
under `exec`) lists the systems in the mission and the ones left out, by reason
class — never the id somebody proposed. A response the proxy filtered or
refilled carries one boolean (`extensions.missura.reduced` on GraphQL,
`missura-reduced` on REST) and no count of what was removed.

**Missura running something for the agent is not missura bypassing itself.**
`POST /missura/op/<name>` with the mission token runs a named read
(`zendesk.tickets.for_entity`, `linear.issues.for_entity`,
`github.issues.for_entity`) and every vendor call it costs re-enters the same
pipeline a raw request goes through — same catalog, same narrowing, same
filter, same refusals, one decision event each, marked with the operation it
served. An operation on a connector the mission lacks is refused with the raw
call's own bytes, and introspection lists only the operations the mission can
run.

**Writes happen only through operations, and a write is proven before it
happens.** The first one is `github.issue.comment.create` (`effect: append`).
A mission reaches it only when the operator names it — `missura exec --allow
github.issue.comment.create`, or `allow: [...]` on the operator mint — on top
of `read` and `search`; no verb grants a write, and a name the catalogue does
not hold is refused before a token exists. The vendor's own write route is not
in the catalog for anything that arrives over HTTP: it opens only for the
inner call the executor builds in-process, so an agent's raw `POST` stays
refused with the same token that just wrote through the operation. A read can
be let through and filtered on the way back; a comment cannot be un-posted, so
the repository check runs on the inner call before anything leaves, and a
repository outside the mission answers the same not-found a foreign read
answers — zero vendor calls. `pnpm demo:m8` runs it for real against a
repository you own (read its header first: it writes one comment).

**The operator sees what an entity can run, and what closes each gap.**
`missura entity show customer:acme` lists the entity's links with their status,
the operations a mission on it can run, and for each one it cannot, the one
cause and the command that fixes it: `missura entity confirm` for a link a scan
proposed and nobody signed off, `missura entity link` for a system with no link
at all, `missura init` for a vendor this deployment is not connected to. A
`--allow` grant the entity cannot honour is refused with that same gap, before a
token exists. `missura entity link` on an id a human already rejected refuses
too and points at `entity confirm`: overriding a no has to be said out loud.

**Every operation says what it does to the world, and two classes wait for a
human.** An operation's effect is one of `read`, `append`, `mutate`, `destroy`,
`egress`. `destroy` is irreversible: `github.issue.comment.delete` removes a
comment for good. `egress` leaves the boundary: `zendesk.ticket.reply` posts a
public comment on a ticket and Zendesk emails it to the requester, so the write
is inside the mission and the destination is not. Both are granted like the
append, by exact name, and neither runs on request. The proxy proves the call
the way it proves any write (grant, scope, target, zero vendor calls). Instead
of running it, it writes it down on the mission as the exact vendor request
that would go and answers `202` with an approval id. `missura approvals` lists what is waiting,
that request spelled out; `missura approve <id>` and `missura deny <id>` record
your decision in your name (the operator plane serves the same under
`/v1/approvals`). The agent polls `GET /missura/approvals/<id>` with its mission
token and, once it reads `approved`, sends the same request again with
`approval: <id>` in the body. It runs once. A second try with the same id is
refused, a denied or still-pending one too, and another mission's id gets the
not-found an id that never existed gets. The mission's TTL bounds all of it:
there is no queue and no workflow engine, because a proxy has nowhere to park a
wait and the approval is a record the agent comes back for.

**Approving never executes.** Deciding writes a name and a time on the record,
nothing else. The operator plane holds the operator key and no vendor
credential, no pipeline and no `fetch`, so there is no path from it to a
vendor, and adding one for approvals would turn the plane that mints missions
into the plane that acts on them. The run happens when the agent comes back, on
the data plane, under the agent's own token, through the same catalog,
narrowing and log as every other call. An approved request can still be refused
there if the mission no longer covers its target. `pnpm demo:m10` runs the whole
flow for real against a repository you own; read its header first, it deletes
a real comment.

## What `exec` does and does not protect

`missura exec` removes `LINEAR_API_KEY`, `GITHUB_TOKEN`, `ZENDESK_API_TOKEN`
and `ZENDESK_EMAIL` from the child's environment and hands it a short-lived
mission token instead, so an agent that
reaches for a vendor key by habit finds nothing and goes through the proxy —
where the request is cataloged, narrowed, logged, and revocable.

It is not a sandbox. The child runs as the same user, so it can read
`~/.missura`: `operator.key` mints it a mission of its own, and `vault.key`
with `vault.json` decrypts the vendor credentials outright. `exec` removes the
accident, not the capability. An agent you do not trust with your own account
needs real isolation — a container, or a separate user — with `~/.missura`
outside it.

## Dev

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

All three green is the bar for any change.

## License

Apache-2.0 — see [LICENSE](LICENSE).
