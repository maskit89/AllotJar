import { LegalLayout } from './LegalLayout'

/**
 * Public privacy policy (/privacy), rewritten 20 Oct 2026 (compliance fix 6) to describe what the
 * app actually does: statement imports and bank details, Google sign-in, the email provider,
 * encrypted off-site backups and when they expire, self-hosted fonts, where the server is and the
 * transfer safeguard, real retention periods, "Download my data" and "Delete my account".
 *
 * Before charging, a Maltese data-protection lawyer checks this text (compliance review, "Where a
 * lawyer is needed"). That note stays here, never on the public page.
 *
 * The constants below are the facts only the operator can confirm on the server. A value in
 * [brackets] is a placeholder: none may reach production.
 */
const SERVER_LOCATION = '[TO CONFIRM: the VPS data centre]'
const EMAIL_PROVIDER = '[TO CONFIRM: Cloudflare or Resend]'
// The R2 lifecycle rule for encrypted backups (#368).
const OFFSITE_BACKUP_DAYS = 35

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="20 October 2026">
      <p>
        This policy explains what personal data AllotJar holds, why, who else handles it, how long
        we keep it and what rights you have. AllotJar is a budgeting app at{' '}
        <a href="https://www.allotjar.com">www.allotjar.com</a>.
      </p>

      <h2>Who we are</h2>
      <p>
        AllotJar is run by Christopher Muscat, an individual based in Malta (“we”, “us”). Under the EU
        General Data Protection Regulation (GDPR) and Malta’s Data Protection Act, we are the data
        controller for the data described here. For anything about your data, email{' '}
        <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>.
      </p>

      <h2>What we hold</h2>
      <ul>
        <li>
          <strong>Your account</strong>: your name, email address and a salted hash of your password
          (never the password itself), the time you accepted these terms, and your currency and
          number format. If you sign in with Google, we also keep your Google account ID and the
          name and email Google shares with us.
        </li>
        <li>
          <strong>Your budget</strong>: the accounts, jars, budgets and transactions you enter. An
          account can hold bank details you add, such as an IBAN, BIC, sort code or account number.
          A transaction holds its date, amount, payee, notes and, when imported, the bank’s reference
          and description.
        </li>
        <li>
          <strong>Bank statements you import</strong>: we read a CAMT.053 or CSV file to create
          transactions and match them to an account by its IBAN or account number. The file itself
          is read in memory and never saved; only the transactions you import are kept.
        </li>
        <li>
          <strong>People in your household</strong>: names, incomes and pocket money of the people
          you add, and the email address and role of anyone you invite to share your budget.
        </li>
        <li>
          <strong>Sign-in sessions</strong>: a hashed token per signed-in device, so you stay signed
          in.
        </li>
        <li>
          <strong>Technical data</strong>: our web server logs each request with its IP address and
          browser type, and when something breaks an error report is emailed to us, which can
          include your email address.
        </li>
        <li>
          <strong>Analytics, only if you accept them</strong>: which pages are used, with a hashed
          user ID (see “Cookies and analytics”).
        </li>
      </ul>
      <p>
        We do <strong>not</strong> connect to your bank and we do not take card payments, so we never
        see your card numbers or banking passwords.
      </p>

      <h2>Why we use it, and on what basis</h2>
      <ul>
        <li>
          <strong>To run the service you signed up for</strong> (performance of a contract): your
          account, your budget, imports, sharing with your household, and emails such as password
          resets, address checks and invitations.
        </li>
        <li>
          <strong>To keep it secure and working</strong> (our legitimate interest): server logs,
          error reports, rate limits, account lockout and backups.
        </li>
        <li>
          <strong>To understand how the app is used</strong> (your consent): analytics, which you can
          refuse or withdraw at any time.
        </li>
      </ul>

      <h2>Data about other people</h2>
      <p>
        When you add a partner, child or anyone else to your household, you give us data about them:
        their name, income or pocket money. We hold it on your behalf so you can budget as a
        household, on the basis of your legitimate interest in managing your family’s money. Please
        only add what you need and let them know. Children appear in AllotJar only as household
        members a parent adds; they never get an account of their own.
      </p>

      <h2>Cookies and analytics</h2>
      <p>
        One <strong>strictly necessary cookie</strong> keeps you signed in. It is HTTP-only, cannot
        be read by scripts, and cannot be switched off without signing you out. Your theme, display
        settings and analytics choice are remembered in your browser’s own storage.
      </p>
      <p>
        <strong>Google Analytics 4</strong> runs only after you accept it. Until then it is denied by
        default (Google Consent Mode v2) and nothing is sent to Google. Advertising features are off,
        IDs are removed from page addresses and your user ID is hashed before it is sent. You can
        change your choice at any time in Help.
      </p>
      <p>
        Our fonts are served from our own server, so opening a page sends nothing to Google. The
        “Sign in with Google” button on the sign-in page does load from Google, which lets Google
        see your IP address when you open that page.
      </p>

      <h2>Who else handles it</h2>
      <p>
        We never sell your data. We use these providers (“processors”), each under a data processing
        agreement, only to run AllotJar:
      </p>
      <ul>
        <li>
          <strong>InterServer</strong> hosts our server and its database, in {SERVER_LOCATION}.
        </li>
        <li>
          <strong>Cloudflare</strong> carries all traffic to the site (encryption, caching and
          protection against attacks) and stores our encrypted backups.
        </li>
        <li>
          <strong>{EMAIL_PROVIDER}</strong> sends our emails, so it sees your email address and the
          message.
        </li>
        <li>
          <strong>Google</strong> confirms who you are if you choose to sign in with Google, and runs
          analytics if you accept them.
        </li>
      </ul>
      <p>
        We may also disclose data where the law requires it, or to protect the rights and safety of
        our users or ourselves.
      </p>

      <h2>Where your data is</h2>
      <p>
        Our server is in {SERVER_LOCATION}. Where a provider handles data outside the European
        Economic Area, the transfer is protected by the EU-US Data Privacy Framework where the
        provider is certified under it, and otherwise by the EU Standard Contractual Clauses. Ask us
        at <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a> for a copy of the
        safeguard that applies.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          <strong>Your account and budget</strong>: until you delete your account. Deleting it
          removes them from the live database at once.
        </li>
        <li>
          <strong>Backups</strong>: a nightly copy of the database is kept on the server for 14 days,
          and an encrypted copy off-site for {OFFSITE_BACKUP_DAYS} days. Data you delete disappears
          from backups as they expire, and we never restore it from a backup unless we have to
          recover the whole service.
        </li>
        <li>
          <strong>Sign-in sessions</strong>: each lasts 30 days, or until you sign out.
        </li>
        <li>
          <strong>Invitations</strong>: an invitation link works for 7 days.
        </li>
        <li>
          <strong>Server logs and error reports</strong>: up to 90 days.
        </li>
        <li>
          <strong>Statement files</strong>: never stored.
        </li>
      </ul>

      <h2>How we protect it</h2>
      <p>
        Everything travels encrypted (TLS). Passwords and sign-in tokens are stored only as hashes,
        backups are encrypted before they leave our server, and sign-in is protected by rate limits,
        a lockout after repeated wrong passwords and a check against known breached passwords. No
        system is perfectly secure; if a breach puts your data at risk, we will tell you and the
        regulator as the law requires.
      </p>

      <h2>Your rights</h2>
      <p>Under the GDPR you can:</p>
      <ul>
        <li>
          <strong>get a copy of your data</strong>: use “Download my data” in Settings for a full copy
          you can also take to another service;
        </li>
        <li>
          <strong>delete your account</strong>: use “Delete my account” in Settings;
        </li>
        <li>correct anything that is wrong, which you can mostly do in the app yourself;</li>
        <li>restrict or object to how we use your data;</li>
        <li>withdraw your consent to analytics at any time.</li>
      </ul>
      <p>
        For anything else, email <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a> and
        we will answer within a month. You can also complain to Malta’s Information and Data
        Protection Commissioner (<a href="https://idpc.org.mt">idpc.org.mt</a>) or the regulator
        where you live.
      </p>

      <h2>Children</h2>
      <p>
        AllotJar accounts are for people aged 16 and over, and we do not knowingly let anyone younger
        sign up.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        When we change this policy we update the date at the top, and for a significant change we
        tell you by email or in the app first.
      </p>
    </LegalLayout>
  )
}
