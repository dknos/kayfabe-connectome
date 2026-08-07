# THE BOOK — Game Design Document

**Product name:** The Book (working title was "Territory Architect"; final branding is original).
**Tagline:** *Whoever holds the book runs the territory.*
**Genre:** Wrestling business & booking simulator (single-player, desktop-first, data-driven).
**Relationship to Kayfabe Connectome:** sibling application in the same monorepo. The Connectome
is a read-only historical lens; The Book creates *mutable alternate-history save universes* from
*immutable historical snapshots* of the same canonical corpus.

This document describes design intent. Implemented behavior is tracked honestly in
`PROGRESS.md`; simulation math lives in `SIMULATION_RULES.md`.

---

## 1. Product thesis

> "I control a wrestling organization inside a living historical industry. Every booking
> decision is also a personnel decision, business decision, political decision and long-term
> investment."

Three connected layers, each producing consequences in the other two:

| Layer | Player-facing surface | Owns |
|---|---|---|
| Owner / Promoter | Owner's Office, Finance, Contracts | capital, strategy, hiring, delegation |
| Creative / Booking | Creative Room, Show Booker, Live Show | pushes, titles, storylines, cards, finishes |
| Living World | Industry Wire, World Companies, Almanac | rivals, careers, injuries, audiences, history |

The game is a strategy game, not a database viewer. The database is the *terrain*; the
simulation is the *weather*; the player is one actor among many persistent AI actors.

## 2. Design pillars

1. **History is terrain.** Every universe starts from the real canonical corpus at a chosen
   date. Pre-start history is immutable and inspectable (Almanac). Post-start history is
   emergent and owned by the save.
2. **No look-ahead.** Nothing that happened after the start date may leak into ratings, AI
   plans, or player-facing screens. This is enforced by construction (the snapshot builder
   only reads records dated ≤ start date) and by tests.
3. **Explainable numbers.** Every derived rating carries method, inputs, and confidence.
   Every show grade decomposes into an auditable breakdown. Every AI action has a reason
   code (visible in dev mode, legible through news/scouting in normal play).
4. **Uncertainty is honest.** Unknown is not zero. Sparse-data wrestlers are *uncertain*,
   not untalented. Scouting narrows confidence intervals; it does not reveal hidden truth
   values verbatim.
5. **One human, many masks.** A person is one canonical ID; ring names are time-bounded
   personas. Search finds any alias; profiles show the historically appropriate identity
   for the current date.
6. **Determinism.** Same seed + same bundle + same decisions ⇒ same state hash. Saves
   replay. RNG is seeded and streamed per subsystem.

## 3. Player roles

Chosen at universe creation:

- **Owner / Promoter** — controls business strategy and delegation; hires a head booker;
  may impose goals, budgets, restrictions. Creative control only if retained.
- **Head Booker** — works for an AI owner; receives objectives, budgets and restrictions;
  builds trust and autonomy or gets fired; has a portable professional reputation.
- **Owner-Booker** — both layers; pays for it in workload/bandwidth (fewer high-quality
  staff suggestions, higher burnout pressure on Creative Cohesion).

An **authority matrix** governs who may: hire talent, set contract ceilings, release, change
titles, dictate finishes, set production spend, schedule events, create brands, expand,
acquire, appoint staff. Owner↔booker relationships model: trust, creative compatibility,
patience, meddling tendency, financial pressure, style/star-profile biases, risk tolerance,
youth-vs-veteran attitude. Conflicts surface as *decisions with stated stakes* ("this is a
demand; refusing costs trust"), never as silent penalties.

## 4. Historical behavior modes

- **Open Alternate History** (vertical-slice default): everything before start date is
  historical; nothing after is predetermined.
- **Guided History**: mod-defined conditional narratives fire only while their
  prerequisites hold; player can interrupt history.
- **Strict Timeline Sandbox**: selected external event categories locked; disclosed to the
  player as predetermined.
- **Fictional Universe**: generated/mod people and companies; heightened drama systems
  permitted (scandal generation stays abstract & non-defamatory for real people in all
  other modes — see §14).

## 5. Core loops

**Daily loop:** inbox → urgent decisions (offers, injuries, media) → advance day.
**Show loop:** plan (Creative Room) → book (Show Booker) → run (Live Show, crowd state
evolves segment by segment) → review (Post-Show, explainable) → consequences (money,
morale, momentum, stories, news).
**Season loop:** storyline arcs → marquee events → title lineages → contract cycles →
market growth/decline → AI counter-programming.
**Career loop (world):** debut → development → prime → decline → retirement → staff/
ownership second acts; new workers generated through training pipelines.

## 6. World & market model

Geography is hierarchical: world area → country → region/territory → metro market → venue.
A market has population, wrestling awareness, economic strength, media access, style
preferences, company loyalties, event saturation, local stars.

Per worker per market the audience tracks **two separate metrics**:

- **Awareness** — how many potential customers recognize them.
- **Affinity** — signed emotional connection (a hated act can be famous).

Company-market state: awareness, affinity, trust, prestige, product clarity, heritage,
momentum, broadcast reach, saturation. Change is gradual, bounded, explainable: exposure
moves awareness fast; affinity requires repeated delivered experiences.

## 7. Era Profiles

Data-driven parameter sets (JSON, moddable), never hard-coded: contract types available,
TV/PPV/streaming availability and economics, touring costs, production expectations,
audience content tolerance, exclusivity norms, news speed, talent pipelines. A 1970
territory save, a 1997 national-war save and a modern streaming save must feel
structurally different by *parameters*, not forked code.

## 8. Companies & Product DNA

A company's identity is a **Product DNA vector** (0–100 axes): athletic competition,
sports presentation, character spectacle, serialized storytelling, comedy, violence,
hardcore, technical, high-flying, strong style, lucha tradition, tag emphasis, women's
division emphasis, youth orientation, family friendliness, adult content, match length
norm, promo intensity, surprise frequency, localism, national ambition, touring
orientation, star-driven vs ensemble, traditional vs experimental.

DNA drives audience acquisition/expectations, sponsor & broadcaster compatibility, worker
fit, match/segment evaluation weighting, AI hiring and pushing. DNA drifts slowly; sudden
swings confuse audiences unless supported (marketing, new leadership, brand split).

Companies support parents/children, developmental groups, brands, divisions, touring
units.

## 9. People

One canonical person; multiple time-bounded personas. Roles: wrestler, manager, announcer,
color, referee, road agent, trainer, scout, medic, executive, owner, booker, writer,
production, celebrity, mod-defined.

Attribute groups (0–100 internally, displayed with confidence bands):

- **In-ring:** fundamentals, timing, selling, psychology, safety, stamina, athleticism,
  strength, agility, technical, striking, aerial, brawling, hardcore, improvisation, tag
  awareness.
- **Presentation:** charisma, promo, acting, comedy, menace, authenticity, star presence,
  visual distinctiveness, crowd connection, media skill.
- **Professional:** reliability, adaptability, leadership, creativity, coaching, booking,
  talent evaluation, business judgment, negotiation, political skill.
- **Personality:** ambition, loyalty, ego, professionalism, risk tolerance, financial vs
  creative motivation, stability vs wanderlust, fame desire, mentoring desire.
- **Physical state:** age + career age, wear by body area, fatigue, injury susceptibility,
  recovery, ring rust, decline curves (per-ability, not one global curve).

Profiles distinguish: verified biography (sourced), current in-game state, *scouted
assessment* (what your staff believes, with confidence), hidden simulation values (never
shown raw when scouting uncertainty is on), derived historical estimates (with method +
provenance), mod overrides.

## 10. Relationships & politics

Directional, multidimensional edges: affection, respect, trust, loyalty, mentorship,
family, romance, creative compatibility, rivalry, resentment, fear, political alliance.
Cliques, mentor trees, locker-room leaders, loyalty to company/owner/booker. Historical
sourced relationships are kept distinct from simulation-generated ones. Backstage
incidents have preconditions, participants, severity, evidence level, response options,
short/long-term effects, news visibility — they emerge from personality × pressure ×
relationships × recent decisions, not random spam.

## 11. Contracts & talent market

Era-appropriate structures: handshake, per-appearance, touring, non-exclusive written,
exclusive written, developmental, staff, loans, exchanges, legends. Terms: dates, base,
per-appearance, downside, bonus, merch share, travel, exclusivity by region/medium,
appearance minimums/limits, creative consultation/control, push/title promises (tracked as
*promises* the game remembers), release/no-cut clauses, options, matching rights,
non-compete, outside bookings.

Negotiation is an explainable utility model over compensation, role, expected push,
prestige, stability, schedule, travel, geography, relationships, reputation, product fit,
career goals, competing offers, company risk. The player sees the *major reasons* behind a
counter ("wants a lighter schedule; unconvinced by your main-event promise"), not the
utility math. AI companies negotiate under identical rules; anti-hoarding via budgets,
roster capacity, expected utilization, worker willingness, locker-room consequences.

## 12. Shows: booking, crowd, evaluation

**Booking:** three-pane Show Booker (roster / card timeline / segment editor); matches with
any number of sides and participants, titles, finishes, elimination order; multi-beat
non-wrestling segments (each beat: location, duration, purpose, participants with roles,
storyline links, intended reaction). The engine knows *what each participant is doing* —
a silent victim is not rated on promo delivery.

**Crowd:** a stateful audience per show — energy, attention, investment, fatigue,
hostility, satisfaction, confusion, anticipation — updated by every segment. Pacing
matters: heat placement, cool-downs, main-event anticipation.

**Evaluation:** pre-show forecast is a *range*; post-show report decomposes into
execution vs reception (see SIMULATION_RULES.md): what worked, who contributed, whether
failure was execution, preparation, fatigue, comprehension, product mismatch, burnout or
production. Weighting respects Product DNA — a deathmatch company is not graded like a
sports-style company.

## 13. Star economy

Separate, interacting quantities per worker: **awareness** (per market), **affinity**
(per market, signed), **momentum** (short-term trajectory), **credibility** (believability
in the presented competitive role), **prestige** (long-term earned status). Drawing power
is a *derived* function of these in a market context — there is no single "popularity"
number. Growth depends on exposure, performance, story effectiveness, opponent strength,
protection, consistency, company reach, age/experience — bounded so stars are neither
push-button products nor impossible.

## 14. Finance

Double-entry ledger, integer cents, every transaction typed and dated; balanced by
invariant test. Revenue: tickets, broadcasting, PPV/streaming, sponsorship, merch,
licensing, concessions, tuition, loans-out, asset sales. Expenses: payroll, appearance
fees, staff, venues, travel, production, marketing, insurance, medical, legal, training,
offices, debt service, penalties. Attendance demand = market population × awareness ×
affinity × card appeal × price elasticity × saturation × competition × momentum. Scaling
costs (not money deletion) prevent snowballing: bigger companies face bigger salary
expectations, production floors, admin overhead.

## 15. Media, news, real-person safety

In-game industry outlet: **The Ringside Ledger** (original fiction). Carries results,
ratings, signings, releases, injuries, openings/closures, title changes, labeled rumors,
anniversaries. Broadcast contracts: coverage, platform, slot, fee/share, exclusivity,
content limits, minimum production, cancellation.

Real-person safety rails (all modes except Fictional Universe): scandal/incident systems
use abstract non-defamatory categories ("contract dispute", "backstage argument",
"missed flight"), never synthesized crimes/addictions/abuse allegations attached to real
people; sourced sensitive history is stored with provenance + confidence and is
optional/toggleable; rumors are always labeled rumors. No bundled real photographs or
logos — an **asset-pack system** lets users install their own licensed/private image packs
locally.

## 16. Titles, teams, tournaments

Championships: name history, company, division, prestige, lineage, reign stats, function
(main-event / secondary / tag / touring / specialty), inactivity/retirement states. AI
respects title *function*. Teams/stables: membership periods, roles, chemistry, shared
identity, loyalty, tensions. Tournaments: single/double elimination, round robin, blocks,
points, multi-night.

## 17. AI companies

No external LLM required. Layered planning, persistent between ticks:

1. Owner strategy (financial/market objectives, risk, product, autonomy granted)
2. Booker philosophy (styles, star profiles, complexity, title philosophy)
3. Annual/quarterly objectives ("make a star", "rebuild division", "cut costs")
4. Program plans (participants, intended winner, milestones, target event, backups)
5. Event plans (required matches, obligations, availability)
6. Segment selection (concrete cards consistent with plans)

Utility scoring + constraints; flawed-on-purpose decisions driven by personality and
skill; bounded learning from failure. Reason codes ship to a dev-only **AI reasoning
ledger**. Simulation LOD tiers: FULL (player company + direct rivals), STANDARD
(relevant actives, simplified segments), ABSTRACT (distant companies, aggregate ticks);
companies migrate tiers as relevance changes.

## 18. Optional AI creative assistant

Optional layer; never required; deterministic engine remains sole authority; structured
bounded game-state packets in, suggestions out; every feature has a template-based offline
fallback; keys stay local. Cannot mutate state; proposals pass normal validation.

## 19. UX identity

"Premium sports-business operations suite × editorial wrestling almanac": strong editorial
typography, dense readable tables, restrained motion, split panes, sticky context, saved
views, breadcrumbs, global search, command palette, keyboard shortcuts, tooltips that
explain mechanics, inline validation, quality empty/loading/error states. No neon
cyberpunk, no glassmorphism, no modal mazes. Target 1440×900; usable at 1366×768; scales
to 4K/ultrawide. Every large list virtualized. Simple/Advanced booking via progressive
disclosure (defaults, not removed depth).

## 20. Vertical slice (Phase 1) — shipped scope

Flagship scenario: **January 1997** — the national war. WWF, WCW and ECW are all active
in the corpus with full pre-1997 history. The player picks any active company and a role;
three-plus AI companies run themselves.

The slice implements, end to end: universe creation from the real corpus (snapshot builder
with anti-look-ahead), canonical people with personas and alias search, derived starting
attributes with confidence, roster/profile/almanac screens, contracts (view + renegotiate/
offer), calendar + event scheduling, storylines with milestones, drag-and-drop show
booking with multi-side matches and multi-beat segments, crowd-state show simulation with
explainable reports, double-entry finance, day advancement with AI rivals booking their
own shows, save/reload with reproducible state hash, and the automated E2E proving the
loop. Everything else in this document is roadmap (Phases 2–6, see PROGRESS.md).
