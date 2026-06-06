import React from "react";

const PrivacyPolicy: React.FC = () => {
  return (
    <div className="min-h-screen bg-background text-foreground py-12 px-4 sm:px-6 lg:px-8">
      <article className="max-w-3xl mx-auto">
        <header className="mb-10 border-b border-border pb-6">
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            Privacy Policy
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Artist Growth Hub</span>
            {" · "}Last updated: June 5, 2026
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Operator: Fendi Frost &middot; Contact:{" "}
            <a
              href="mailto:fendifrost@gmail.com"
              className="underline hover:no-underline"
            >
              fendifrost@gmail.com
            </a>
          </p>
        </header>

        <section className="space-y-8 leading-relaxed">
          <div>
            <h2 className="text-2xl font-semibold mb-3">1. Who we are</h2>
            <p>
              Artist Growth Hub (&quot;the App,&quot; &quot;we,&quot; &quot;us&quot;) is an internal tool
              operated by Fendi Frost, an independent recording artist, to support music
              promotion and curator outreach activities. The App is not a public consumer
              product and is operated by a single individual.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">2. What information we access</h2>
            <p className="mb-3">
              The App connects to the Meta Graph API and the Instagram Messaging API to:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                Read the list of Facebook Pages that the authenticated user (the operator)
                administers, along with the Instagram Business or Creator account linked to
                each Page.
              </li>
              <li>
                Read messages and conversations in the operator&apos;s own Instagram Business
                inbox, in order to track outbound outreach and inbound replies.
              </li>
              <li>
                Send Instagram Direct Messages from the operator&apos;s own Instagram Business
                account to playlist curators and music industry contacts who the operator
                has identified as relevant to share music with.
              </li>
              <li>
                Read basic public profile information (name, username, profile picture,
                follower count) for the operator&apos;s own Pages and Instagram accounts, for
                operator-facing display in an internal dashboard.
              </li>
            </ul>
            <p className="mt-3">
              The App accesses <strong>only</strong> the operator&apos;s own Meta-owned assets
              (Pages, Instagram Business accounts, inboxes). It does not collect, store, or
              process personal information about end users, customers, or third parties
              beyond what is publicly visible in standard Instagram conversations the
              operator participates in.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">3. What we do NOT collect</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>We do not sell data to any third party.</li>
              <li>We do not run advertising networks.</li>
              <li>
                We do not maintain user accounts for the public — the App has no signup,
                no login, and no consumer-facing UI.
              </li>
              <li>
                We do not collect financial information, payment data, government IDs, or
                health data.
              </li>
              <li>
                We do not access contacts, calendars, location data, microphone, or camera.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">4. Where data is stored</h2>
            <p>
              Outreach activity logs (which curators have been messaged, draft message
              content, response status) are stored in a private Supabase Postgres database
              operated by the operator. Access is restricted to the operator. Data is
              encrypted at rest by the database provider.
            </p>
            <p className="mt-3">
              Access tokens issued by Meta are stored as secrets in the operator&apos;s
              Lovable Cloud edge function environment, accessible only by the operator and
              the App&apos;s server-side code.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">5. How long we keep data</h2>
            <p>
              Outreach logs are retained for as long as the operator continues to use the
              App for music promotion. The operator may delete logs at any time. Access
              tokens are refreshed on a recurring basis and old tokens are discarded.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">6. Who we share data with</h2>
            <p>
              We do not share data with third parties for marketing, advertising, or
              analytics purposes. The App communicates with Meta&apos;s APIs (to send
              messages and read inbox state) and with Supabase (to store activity logs).
              These are the only third parties involved, and they are involved solely as
              infrastructure providers.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">7. Your rights</h2>
            <p className="mb-3">
              Because the App has no public users, this policy primarily governs the
              operator&apos;s own data. If you are a curator or contact who has received a
              message from the operator via this App and you wish to:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                <strong>Stop receiving messages</strong> — reply &quot;stop&quot; to the
                message thread, or block the operator&apos;s Instagram account. The
                operator will respect any such request.
              </li>
              <li>
                <strong>Request deletion</strong> of any record the App has stored about
                your interaction — see our{" "}
                <a
                  href="/data-deletion"
                  className="underline hover:no-underline"
                >
                  Data Deletion page
                </a>
                {" "}or email{" "}
                <a
                  href="mailto:fendifrost@gmail.com"
                  className="underline hover:no-underline"
                >
                  fendifrost@gmail.com
                </a>{" "}
                with your Instagram handle and a deletion request. The operator will delete
                the record within 30 days.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">8. Children</h2>
            <p>
              The App is not directed to and does not knowingly process information about
              anyone under 13 years of age.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">9. Changes to this policy</h2>
            <p>
              We may update this policy from time to time. Material changes will be
              reflected in the &quot;Last updated&quot; date at the top.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">10. Contact</h2>
            <p>
              For questions about this policy, contact:{" "}
              <a
                href="mailto:fendifrost@gmail.com"
                className="underline hover:no-underline"
              >
                fendifrost@gmail.com
              </a>
            </p>
          </div>
        </section>

        <footer className="mt-12 pt-6 border-t border-border text-sm text-muted-foreground">
          <p>
            Meta App ID: 1125919162443596 &middot;{" "}
            <a href="/data-deletion" className="underline hover:no-underline">
              Data Deletion Instructions
            </a>
          </p>
        </footer>
      </article>
    </div>
  );
};

export default PrivacyPolicy;
