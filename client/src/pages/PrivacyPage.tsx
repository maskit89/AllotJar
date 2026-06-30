import { LegalLayout } from './LegalLayout'

/**
 * Public privacy policy (/privacy). GDPR-oriented since AllotJar is EU-facing.
 * This is a plain-language draft — it should be reviewed (ideally by a lawyer)
 * and the controller's legal name filled in before being relied upon.
 */
export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="1 July 2026">
      <p>
        This Privacy Policy explains what personal data AllotJar collects, why, and what rights you
        have over it. AllotJar is a zero-based budgeting application available at{' '}
        <a href="https://www.allotjar.com">www.allotjar.com</a>.
      </p>

      <h2>Who we are</h2>
      <p>
        AllotJar is operated by <strong>[OPERATOR LEGAL NAME]</strong>, an individual based in
        Malta (“we”, “us”, “our”). For the purposes of the EU General Data Protection Regulation
        (GDPR), we are the data controller for the personal data described below. You can reach us
        about any privacy matter at <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>.
      </p>

      <h2>What data we collect</h2>
      <ul>
        <li>
          <strong>Account information</strong> — your name, email address and a securely hashed
          password. Email is also your sign-in username.
        </li>
        <li>
          <strong>Preferences</strong> — your chosen currency and number format.
        </li>
        <li>
          <strong>Budgeting data you enter</strong> — the budgets, transactions, accounts, savings
          jars and household members you create in the app. You provide this; we store it so the
          service works.
        </li>
        <li>
          <strong>Household sharing data</strong> — if you invite others or join a household, the
          email addresses and roles needed to manage shared access.
        </li>
        <li>
          <strong>Technical and usage data</strong> — limited server logs (such as IP address and
          browser type) needed to run and secure the service, and — only if you consent — analytics
          about how the app is used (see “Cookies and analytics”).
        </li>
      </ul>
      <p>
        We do <strong>not</strong> connect to your bank, and we do not process card payments, so we
        never see your card numbers or banking credentials.
      </p>

      <h2>How and why we use your data</h2>
      <p>We use your personal data to:</p>
      <ul>
        <li>provide the budgeting service and keep your data available to you;</li>
        <li>create and secure your account and detect or prevent abuse;</li>
        <li>respond to your requests and support questions;</li>
        <li>understand and improve how the app is used (only with your consent).</li>
      </ul>
      <p>Our legal bases under the GDPR are:</p>
      <ul>
        <li>
          <strong>Performance of a contract</strong> — to provide the service you sign up for;
        </li>
        <li>
          <strong>Consent</strong> — for optional analytics, which you can give or withdraw at any
          time;
        </li>
        <li>
          <strong>Legitimate interests</strong> — to keep the service secure and working, and to
          improve it, in ways that do not override your rights.
        </li>
      </ul>

      <h2>Cookies and analytics</h2>
      <p>
        We use a small number of <strong>strictly necessary cookies</strong> to keep you signed in
        (an HTTP-only session/refresh cookie). These are required for the app to work and cannot be
        switched off.
      </p>
      <p>
        We also use <strong>Google Analytics 4</strong> to understand usage, but only after you give
        consent. Analytics consent is <strong>denied by default</strong> (Google Consent Mode v2);
        nothing is sent to Google unless you opt in via the consent banner, and you can change your
        choice at any time. We do not enable Google advertising features, and your user identifier
        is hashed before it is sent.
      </p>

      <h2>Who we share data with</h2>
      <p>
        We do not sell your personal data. We share it only with service providers (“processors”)
        that help us run AllotJar, under appropriate agreements:
      </p>
      <ul>
        <li>
          <strong>Hosting</strong> — our server provider, which stores the application database;
        </li>
        <li>
          <strong>Cloudflare</strong> — for content delivery, TLS and security/firewalling;
        </li>
        <li>
          <strong>Google</strong> — for analytics, and only where you have consented.
        </li>
      </ul>
      <p>
        We may also disclose data where required by law, or to protect our rights, safety or
        property and those of our users.
      </p>

      <h2>International transfers</h2>
      <p>
        Where a provider (such as Google Analytics) processes data outside the European Economic
        Area, that transfer is covered by appropriate safeguards such as the EU Standard Contractual
        Clauses or an adequacy decision.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep your account and budgeting data for as long as your account is active. If you delete
        your account or ask us to erase your data, we delete it (subject to any short retention
        required to comply with legal obligations or resolve disputes). Server logs are kept only for
        a limited period.
      </p>

      <h2>How we protect your data</h2>
      <p>
        All traffic is encrypted in transit with TLS. Passwords are stored only as salted hashes, and
        the app uses modern authentication with measures such as rate limiting, account lockout,
        breached-password checks and revocable sessions. No system is perfectly secure, but we work
        to protect your data appropriately.
      </p>

      <h2>Your rights</h2>
      <p>Under the GDPR you have the right to:</p>
      <ul>
        <li>access the personal data we hold about you;</li>
        <li>have inaccurate data corrected;</li>
        <li>have your data erased;</li>
        <li>restrict or object to certain processing;</li>
        <li>receive your data in a portable format;</li>
        <li>withdraw consent for analytics at any time.</li>
      </ul>
      <p>
        To exercise any of these, contact{' '}
        <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>. You also have the right to
        lodge a complaint with your local data protection authority — in Malta, the Information and
        Data Protection Commissioner (<a href="https://idpc.org.mt">idpc.org.mt</a>).
      </p>

      <h2>Children</h2>
      <p>
        AllotJar is not directed at children. It is intended for users aged 16 and over, and we do
        not knowingly collect data from anyone under that age.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this policy from time to time. We will revise the “Last updated” date above and,
        for significant changes, take reasonable steps to let you know.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data? Email{' '}
        <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>.
      </p>
    </LegalLayout>
  )
}
