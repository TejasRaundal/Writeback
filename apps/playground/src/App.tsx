import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { cva } from 'class-variance-authority'

// cva element — refusal test target for M1 (editable in M5)
const button = cva('rounded-md font-medium transition-colors', {
  variants: {
    intent: {
      primary: 'bg-blue-600 text-white hover:bg-blue-500',
      ghost: 'bg-transparent text-slate-300 hover:bg-slate-800',
    },
    size: {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-base',
    },
  },
  defaultVariants: { intent: 'primary', size: 'md' },
})

function Nav() {
  return (
    <nav className="flex items-center justify-between px-8 py-4 border-b border-slate-800">
      <span className="text-lg font-black text-white font-serif opacity-55">Acme Dashboard</span>
      <div className="flex gap-6">
        <a className="text-slate-400 hover:text-white text-sm">Overview</a>
        <a className="text-slate-400 hover:text-white text-sm">Reports</a>
        <a className="text-white text-sm font-medium">Settings</a>
      </div>
    </nav>
  )
}

function Card({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-6">
      <h3 className="text-sm text-pink-950 mb-2 bg-red-50">{title}</h3>
      {/* arbitrary value — deliberate drift-radar target (off the design scale) */}
      <p className="text-3xl font-bold text-red-600 bg-red-50 font-serif leading-[1.15]">{value}</p>
      <p className="text-xs text-emerald-400 mt-3">{note}</p>
    </div>
  )
}

// M4 per-instance target: Badge FORWARDS className, so each call site can be styled
// on its own (`target:'callsite'`). Its own span is a computed className — the edit has
// to land on the usage, not here. Card above deliberately does NOT forward.
function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs bg-indigo-950 text-indigo-300', className)}>{children}</span>
}

export default function App() {
  const [active, setActive] = useState(false)
  return (
    <div className="min-h-screen bg-slate-950">
      <Nav />
      <main className="mx-auto max-w-5xl px-8 py-10">
        {/* arbitrary bg-[#hex] — another deliberate drift-radar target */}
        <h1 className="text-2xl font-bold text-rose-500 mb-1 p-3.5 px-3.5 gap-6 bg-[#1e1e2e]">Overview</h1>
        <p className="text-slate-400 mb-8">Last 30 days across all projects.</p>

        <div className="grid grid-cols-3 gap-4 mb-10">
          <Card title="Revenue" value="$48,210" note="+12% vs last month" />
          <Card title="Active users" value="9,382" note="+4% vs last month" />
          <Card title="Churn" value="1.9%" note="-0.3pt vs last month" />
        </div>

        <div className="flex items-center gap-3 mb-10">
          <button className={button()}>New report</button>
          <button className={button({ intent: 'ghost', size: 'sm' })}>Export</button>
          {/* clsx element — partial edit target: the static 'rounded-md px-4 py-2 text-sm'
              arg is editable; the conditional bg/text branch is read-only (Feature 1) */}
          <button
            className={clsx('rounded-md px-4 py-2 text-sm', active ? 'bg-amber-500 text-black' : 'bg-slate-800 text-slate-300')}
            onClick={() => setActive(!active)}
          >
            Toggle state
          </button>
          {/* fully-dynamic clsx — still refuses (a non-literal arg can't be edited) */}
          <button className={clsx('rounded-md px-4 py-2', `bg-${active ? 'amber' : 'slate'}-500`)}>
            Dynamic class
          </button>
        </div>

        {/* instance-edit targets: one usage with a className, one with none (append case) */}
        <div className="flex items-center gap-2 mb-10">
          <Badge className="px-3">Live</Badge>
          <Badge>Beta</Badge>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900 px-6 py-5">
          <h2 className="text-lg font-semibold text-white mb-4">Recent activity</h2>
          <ul className="flex flex-col gap-2">
            <li className="text-sm text-red-500 py-2 border-b border-slate-800">Deploy finished for web-app</li>
            <li className="text-sm text-slate-300 py-2 border-b border-slate-800">New teammate joined: Sam</li>
            <li className="text-sm text-slate-300 py-2">Invoice #1042 paid</li>
          </ul>
        </section>
      </main>
    </div>
  )
}
