const milestones = [
  "FastAPI API surface for agent orchestration",
  "SQLite-backed local harness state",
  "React workspace for operator workflows",
  "shadcn-ready frontend foundation",
];

export default function App() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#f3f7ff,_#ffffff_55%)] text-slate-950">
      <section className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center gap-10 px-6 py-16">
        <div className="space-y-6">
          <p className="inline-flex rounded-full border border-slate-300 bg-white/80 px-3 py-1 text-sm font-medium tracking-[0.18em] text-slate-600 uppercase shadow-sm">
            Milestone 1
          </p>
          <div className="max-w-3xl space-y-4">
            <h1 className="text-5xl font-semibold tracking-tight text-balance sm:text-6xl">
              AI agent harness, scaffolded for fast backend iteration and a flexible UI.
            </h1>
            <p className="text-lg leading-8 text-slate-600">
              This workspace starts with a FastAPI service, a React app, SQLite for
              local persistence, and a frontend setup that is ready for shadcn when
              the first real operator flows land.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {milestones.map((item) => (
            <article
              key={item}
              className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-[0_20px_60px_-30px_rgba(15,23,42,0.35)] backdrop-blur"
            >
              <p className="text-base font-medium text-slate-800">{item}</p>
            </article>
          ))}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-slate-950 p-8 text-slate-50 shadow-[0_30px_80px_-35px_rgba(15,23,42,0.75)]">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-300">Next up</p>
          <p className="mt-3 max-w-2xl text-lg leading-8 text-slate-100">
            Agent runs, tool execution, streaming output, and the first real control
            surface for managing harness sessions.
          </p>
        </div>
      </section>
    </main>
  );
}

