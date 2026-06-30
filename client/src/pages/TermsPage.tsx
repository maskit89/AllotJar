import { LegalLayout } from './LegalLayout'

/**
 * Public terms of service (/terms). Plain-language draft governed by Maltese law —
 * should be reviewed (ideally by a lawyer) and the operator's legal name filled in
 * before being relied upon.
 */
export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" lastUpdated="1 July 2026">
      <p>
        These Terms of Service (“Terms”) govern your use of AllotJar, a zero-based budgeting
        application available at <a href="https://www.allotjar.com">www.allotjar.com</a> (the
        “Service”). By creating an account or using the Service, you agree to these Terms. If you do
        not agree, please do not use the Service.
      </p>

      <h2>1. Who we are</h2>
      <p>
        The Service is operated by <strong>[OPERATOR LEGAL NAME]</strong>, an individual based in
        Malta (“we”, “us”, “our”). You can contact us at{' '}
        <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>.
      </p>

      <h2>2. Eligibility</h2>
      <p>
        You must be at least 16 years old and able to form a binding contract to use the Service. By
        using AllotJar you confirm that you meet these requirements.
      </p>

      <h2>3. Your account</h2>
      <ul>
        <li>You are responsible for the accuracy of the information you provide.</li>
        <li>
          You are responsible for keeping your password confidential and for all activity under your
          account.
        </li>
        <li>Tell us promptly at the address above if you suspect any unauthorised use.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the Service for any unlawful purpose or in breach of these Terms;</li>
        <li>
          attempt to gain unauthorised access to the Service, other accounts, or our systems;
        </li>
        <li>
          disrupt or overload the Service, or probe, scan or test its security without permission;
        </li>
        <li>
          copy, scrape, reverse-engineer or resell the Service except as permitted by law.
        </li>
      </ul>

      <h2>5. Your data and content</h2>
      <p>
        You retain ownership of the budgeting data and content you enter. You grant us the limited
        rights needed to host, process and display that data in order to provide the Service to you.
        How we handle personal data is described in our{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>6. Not financial advice</h2>
      <p>
        AllotJar is a budgeting tool that helps you organise your own money. It does{' '}
        <strong>not</strong> provide financial, investment, tax or legal advice, and nothing in the
        Service should be relied upon as such. Decisions about your finances are your own
        responsibility.
      </p>

      <h2>7. Availability and changes</h2>
      <p>
        We work to keep the Service available, but we do not guarantee it will be uninterrupted or
        error-free. We may add, change, suspend or discontinue features, and we may perform
        maintenance, at any time. Where reasonable, we will try to give notice of significant
        changes.
      </p>

      <h2>8. Disclaimers</h2>
      <p>
        The Service is provided “as is” and “as available”, without warranties of any kind, whether
        express or implied, to the fullest extent permitted by law. We do not warrant that the
        Service will meet your requirements or that any data or calculations are free from error.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, we will not be liable for any indirect, incidental,
        special or consequential loss, or for any loss of data, profits or savings, arising from your
        use of (or inability to use) the Service. Nothing in these Terms excludes liability that
        cannot be excluded under applicable law.
      </p>

      <h2>10. Termination</h2>
      <p>
        You may stop using the Service and delete your account at any time. We may suspend or
        terminate your access if you breach these Terms or use the Service in a way that may cause
        harm to us or other users.
      </p>

      <h2>11. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. We will revise the “Last updated” date above,
        and your continued use of the Service after changes take effect means you accept the updated
        Terms.
      </p>

      <h2>12. Governing law</h2>
      <p>
        These Terms are governed by the laws of Malta, and any disputes will be subject to the
        exclusive jurisdiction of the courts of Malta, without prejudice to any mandatory consumer
        protections you may have under the law of your country of residence.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions about these Terms? Email{' '}
        <a href="mailto:privacy@allotjar.com">privacy@allotjar.com</a>.
      </p>
    </LegalLayout>
  )
}
