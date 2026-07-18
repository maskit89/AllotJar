import { useEffect, useState, type ReactNode } from 'react'
import { JarLogo, Jar } from '../components/Jar'
import { StagingBanner } from '../components/StagingBanner'
import { currencyNoun, detectLocaleDefaults } from '../lib/money'
import {
  DashboardIcon,
  JarsIcon,
  AccountsIcon,
  ReportsIcon,
  MembersIcon,
  AccessIcon,
} from '../components/icons'

/**
 * The public marketing landing page — the front door at `allotjar.com/` for
 * anonymous visitors (signed-in users get the dashboard instead; see App.tsx).
 *
 * It is intentionally **self-contained and SSR-safe**: it renders to static HTML
 * at build time (scripts/prerender.mjs → renderToStaticMarkup), so its *initial*
 * render must not use router context, browser globals, router state or props.
 * Navigation is plain `<a>` links to /login, and every CTA is keyboard- and
 * crawler-friendly. The theme (light/dark) is applied before paint by
 * /theme-init.js, so no toggle is needed.
 *
 * The one browser-only touch is the tagline noun: it initialises to "euro" (so the
 * prerendered/crawled HTML stays euro-first and on-brand) and a mount-only effect
 * swaps in the visitor's own currency word — effects never run during
 * renderToStaticMarkup, so the static output is unaffected.
 */

/** A filled brand CTA rendered as a link (the design-system Button is a <button>). */
function CtaPrimary({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-brand-700"
    >
      {children}
    </a>
  )
}

/** A quieter, bordered CTA link. */
function CtaSecondary({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-surface px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
    >
      {children}
    </a>
  )
}

interface Feature {
  icon: ReactNode
  title: string
  body: string
}

const FEATURES: Feature[] = [
  {
    icon: <DashboardIcon className="h-6 w-6" />,
    title: 'Zero-based budgeting',
    body: 'Give every euro, dollar or pound a job. Plan your income minus expenses down to exactly zero each month, so you always know where your money is going.',
  },
  {
    icon: <JarsIcon className="h-6 w-6" />,
    title: 'Sinking-fund jars',
    body: 'Set a little aside each month for insurance, the holiday and the car. Watch each jar fill toward its goal instead of dreading the big bills.',
  },
  {
    icon: <AccountsIcon className="h-6 w-6" />,
    title: 'All your accounts',
    body: 'Track current, savings, cash and credit accounts in one place, with real balances calculated from your own transactions.',
  },
  {
    icon: <ReportsIcon className="h-6 w-6" />,
    title: 'Reports & trends',
    body: 'See income versus spending month to month, a breakdown by category and a full annual overview — no spreadsheets required.',
  },
  {
    icon: <MembersIcon className="h-6 w-6" />,
    title: 'Budget as a household',
    body: 'Invite your partner, share a household budget and split allocations fairly, so you are both working from the same plan.',
  },
  {
    icon: <AccessIcon className="h-6 w-6" />,
    title: 'Private & secure',
    body: 'Your data is encrypted in transit, protected by modern authentication, and never sold. Your money is nobody else’s business.',
  },
]

interface Step {
  n: string
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    n: '1',
    title: 'Plan the month',
    body: 'Start from a template or last month, then assign all of your income to a category or a jar until nothing is left unbudgeted.',
  },
  {
    n: '2',
    title: 'Track as you spend',
    body: 'Log or import transactions and watch each category fill up. AllotJar keeps your “left to spend” honest, to the cent.',
  },
  {
    n: '3',
    title: 'Adjust and save',
    body: 'Life happens — move money between categories, top up a jar, and roll your plan forward into next month in a couple of clicks.',
  },
]

interface Faq {
  q: string
  a: string
}

const FAQS: Faq[] = [
  {
    q: 'What is zero-based budgeting?',
    a: 'Zero-based budgeting means giving every part of your income a specific job — spending, saving or paying down debt — until your income minus your plan equals zero. It is one of the simplest, most effective ways to take control of your money.',
  },
  {
    q: 'Can I use AllotJar outside Europe?',
    a: 'Absolutely. AllotJar was crafted in Europe and stays euro-friendly, but it works anywhere — pick your currency and the number format you actually write (1,234.56 or 1.234,56), from dollars and pounds to rupees, francs and more. Your budget reads the way you do.',
  },
  {
    q: 'What makes AllotJar different?',
    a: 'AllotJar brings the proven zero-based method to a modern tool with sinking-fund jars, multi-account tracking and household sharing built in — in whatever currency you budget.',
  },
  {
    q: 'Can I share my budget with my partner?',
    a: 'Absolutely. Create a household, invite the people you budget with, and plan together from one shared budget with fair allocation between members.',
  },
  {
    q: 'How much does AllotJar cost?',
    a: 'AllotJar is free to start. Create an account, set up your first month in minutes, and see whether zero-based budgeting changes how you feel about money.',
  },
]

export function LandingPage() {
  // Euro-first for the prerendered/crawled HTML; a mount-only effect swaps in the
  // visitor's own currency word (see the file header for why this is SSR-safe).
  const [noun, setNoun] = useState('euro')
  useEffect(() => {
    setNoun(currencyNoun(detectLocaleDefaults().currency))
  }, [])

  return (
    <div className="min-h-full">
      <StagingBanner />
      {/* ---- Header ---- */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <a href="/" className="flex items-center gap-2.5" aria-label="AllotJar home">
          <JarLogo />
          <span className="text-xl font-extrabold tracking-[-0.03em] text-slate-900">
            Allot<span style={{ color: 'var(--accent)' }}>Jar</span>
          </span>
        </a>
        <nav className="flex items-center gap-2 sm:gap-3" aria-label="Primary">
          <a
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition hover:text-slate-900"
          >
            Sign in
          </a>
          <CtaPrimary href="/login?register=1">Get started</CtaPrimary>
        </nav>
      </header>

      {/* ---- Hero ---- */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-10 pt-8 lg:grid-cols-2 lg:pb-16 lg:pt-14">
        <div>
          {/* brand-600 stays deep green in dark (it backs white-text buttons), so
              brighten the accent text to brand-500 (#5fc093) for AA contrast there. */}
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.08em] text-brand-600 dark:text-brand-500">
            Zero-based budgeting · crafted in Europe, at home anywhere
          </p>
          <h1 className="text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-slate-900 sm:text-5xl">
            Give every {noun} a job.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            AllotJar is a zero-based budgeting app crafted in Europe and at home anywhere. Plan each
            month to zero, save for the big stuff with sinking-fund jars, and finally feel in control
            of your money — in your currency, the way you write it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <CtaPrimary href="/login?register=1">Create your free account</CtaPrimary>
            <CtaSecondary href="/login">Sign in</CtaSecondary>
          </div>
          <p className="mt-4 text-sm text-slate-500">Free to start · No card required</p>
        </div>

        {/* A small shelf of jars filling toward their goals — the product metaphor. */}
        <div className="hero-surface rounded-[24px] p-8 sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-white/85">
            Your jars
          </p>
          <p className="gold-number mt-2 w-fit text-4xl font-extrabold tracking-[-0.02em]">€2,480</p>
          <p className="mt-1 text-sm text-white/80">set aside across 3 jars this year</p>
          <div className="mt-7 flex items-end justify-center gap-6 sm:gap-9">
            <JarStat hue="rose" pct={90} label="Insurance" />
            <JarStat hue="teal" pct={70} label="Holiday" />
            <JarStat hue="amber" pct={40} label="New car" />
          </div>
        </div>
      </section>

      {/* ---- Features ---- */}
      <section className="mx-auto max-w-6xl px-5 py-14" aria-labelledby="features-heading">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="features-heading"
            className="text-3xl font-bold tracking-tight text-slate-900"
          >
            Everything you need to budget with confidence
          </h2>
          <p className="mt-3 text-slate-600">
            A complete, modern budgeting app — not a spreadsheet — designed around how real
            households actually manage money.
          </p>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                {f.icon}
              </div>
              <h3 className="mt-4 text-lg font-bold text-slate-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section className="mx-auto max-w-6xl px-5 py-14" aria-labelledby="how-heading">
        <div className="mx-auto max-w-2xl text-center">
          <h2 id="how-heading" className="text-3xl font-bold tracking-tight text-slate-900">
            How AllotJar works
          </h2>
          <p className="mt-3 text-slate-600">Three simple steps, every month.</p>
        </div>
        <ol className="mt-10 grid gap-5 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-bold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ---- FAQ ---- */}
      <section className="mx-auto max-w-3xl px-5 py-14" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="text-3xl font-bold tracking-tight text-slate-900">
          Frequently asked questions
        </h2>
        <dl className="mt-8 space-y-6">
          {FAQS.map((f) => (
            <div key={f.q} className="rounded-2xl border border-slate-200/70 bg-surface p-6 shadow-card">
              <dt className="text-base font-semibold text-slate-900">{f.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-slate-600">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ---- Closing CTA ---- */}
      <section className="px-5 py-10">
        <div className="hero-surface mx-auto max-w-4xl rounded-[24px] px-8 py-12 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Ready to give every {noun} a job?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">
            Set up your first budget in minutes. It’s free to start.
          </p>
          <div className="mt-7 flex justify-center">
            <a
              href="/login?register=1"
              className="inline-flex items-center justify-center rounded-lg bg-white px-6 py-3 text-sm font-bold text-brand-700 shadow-card transition hover:bg-white/90"
            >
              Create your free account
            </a>
          </div>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="mx-auto max-w-6xl px-5 py-10">
        <div className="flex flex-col items-center gap-4 border-t border-slate-200 pt-8 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2.5">
            <JarLogo compact />
            <span className="text-sm font-bold tracking-[-0.02em] text-slate-700">AllotJar</span>
          </div>
          <p className="text-sm text-slate-500">
            © {new Date().getFullYear()} AllotJar · Give every {noun} a job.
          </p>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label="Footer">
            <a href="/privacy" className="font-medium text-slate-600 hover:text-slate-900">
              Privacy
            </a>
            <a href="/terms" className="font-medium text-slate-600 hover:text-slate-900">
              Terms
            </a>
            <a href="/login" className="font-medium text-slate-600 hover:text-slate-900">
              Sign in
            </a>
            <a href="/login?register=1" className="font-medium text-slate-600 hover:text-slate-900">
              Create account
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

/** A decorative jar with its label, for the hero shelf. */
function JarStat({
  hue,
  pct,
  label,
}: {
  hue: 'rose' | 'teal' | 'amber'
  pct: number
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Decorative on the dark hero: no in-jar percent text (the label carries it
          to assistive tech and keeps axe clear of a low-contrast number). */}
      <Jar hue={hue} pct={pct} size="card" showPct={false} label={`${label}: ${pct}% funded`} />
      <span className="text-xs font-medium text-white/85">{label}</span>
    </div>
  )
}
