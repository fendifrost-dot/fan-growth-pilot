import React from "react";

const DataDeletion: React.FC = () => {
  return (
    <div className="min-h-screen bg-background text-foreground py-12 px-4 sm:px-6 lg:px-8">
      <article className="max-w-3xl mx-auto">
        <header className="mb-10 border-b border-border pb-6">
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            User Data Deletion Instructions
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Artist Growth Hub</span>
            {" · "}Meta App ID: 1125919162443596
            {" · "}Last updated: June 5, 2026
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Operator contact:{" "}
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
            <h2 className="text-2xl font-semibold mb-3">Summary</h2>
            <p className="mb-3">
              Artist Growth Hub is an internal outreach tool operated by a single
              individual (Fendi Frost) to message Spotify playlist curators and music
              industry contacts from his own Instagram Business account. The App does not
              have public users. The only personal data the App stores about anyone other
              than the operator is:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Instagram handles of curators the operator has messaged</li>
              <li>Whether the operator has sent a message to that handle</li>
              <li>
                Whether the curator has replied (and the body of the reply, as part of the
                standard Instagram conversation thread the operator participates in)
              </li>
              <li>The operator&apos;s draft of the outbound message</li>
            </ul>
            <p className="mt-3">
              If you are a curator or contact who has received a message from the
              operator&apos;s Instagram account and you want this record deleted, follow
              the steps below.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">How to request deletion</h2>

            <h3 className="text-xl font-semibold mt-6 mb-2">Option A — Reply on Instagram</h3>
            <p>
              Reply to the Instagram message thread with the word{" "}
              <strong>&quot;DELETE&quot;</strong> (case-insensitive). The operator monitors
              the inbox and will manually delete any record of your interaction from the
              App&apos;s database within 30 days.
            </p>

            <h3 className="text-xl font-semibold mt-6 mb-2">Option B — Email request</h3>
            <p className="mb-3">
              Send an email to{" "}
              <a
                href="mailto:fendifrost@gmail.com?subject=Artist%20Growth%20Hub%20%E2%80%94%20Data%20Deletion%20Request"
                className="underline hover:no-underline"
              >
                fendifrost@gmail.com
              </a>{" "}
              with:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                Subject:{" "}
                <code className="px-1.5 py-0.5 bg-muted rounded text-sm">
                  Artist Growth Hub — Data Deletion Request
                </code>
              </li>
              <li>
                Body: include your Instagram handle (e.g.,{" "}
                <code className="px-1.5 py-0.5 bg-muted rounded text-sm">
                  @your_handle
                </code>
                ) so the operator can locate the record.
              </li>
            </ul>
            <p className="mt-3 mb-2">The operator will:</p>
            <ol className="list-decimal pl-6 space-y-2">
              <li>Confirm receipt within 7 days.</li>
              <li>
                Delete the record (curator handle, message history, draft content) from
                the App&apos;s database within 30 days of confirmation.
              </li>
              <li>Email confirmation when deletion is complete.</li>
            </ol>

            <h3 className="text-xl font-semibold mt-6 mb-2">
              Option C — Block the operator&apos;s Instagram account
            </h3>
            <p>
              Blocking the operator&apos;s Instagram account on Instagram will prevent any
              further messages. To also request deletion of the historical record, follow
              Option A or B.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">What gets deleted</h2>
            <p className="mb-3">
              Upon a valid deletion request, the following is removed from the App&apos;s
              internal database:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>The curator/contact&apos;s Instagram handle from the outreach targets table</li>
              <li>All draft message content addressed to that handle</li>
              <li>All logged status events (sent, opened, replied) for that handle</li>
              <li>Any cached profile metadata (name, username, public follower count) tied to that handle</li>
            </ul>
            <p className="mt-3">
              The Instagram message thread itself is governed by Instagram&apos;s standard
              data policies and remains under your own account&apos;s control. To delete
              the thread from your side, use Instagram&apos;s in-app message deletion.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">What we cannot delete</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                Data held by Meta / Instagram itself — this is governed by Meta&apos;s
                policies, not by the App. See{" "}
                <a
                  href="https://www.facebook.com/help"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  facebook.com/help
                </a>{" "}
                and{" "}
                <a
                  href="https://help.instagram.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                >
                  help.instagram.com
                </a>{" "}
                for Meta&apos;s deletion process.
              </li>
              <li>
                Data that has been quoted or copied into separate, off-system records
                (e.g., the operator&apos;s personal notes) — the operator will make a
                good-faith effort to also remove such derivative records when feasible.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">Verification</h2>
            <p>
              To prevent abuse of the deletion process, the operator may ask you to
              confirm the deletion request by replying from the same Instagram account you
              originally received messages from, or by providing context that matches the
              original conversation.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-3">Contact</h2>
            <p>
              For all data deletion requests and privacy questions:{" "}
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
            <a href="/privacy" className="underline hover:no-underline">
              Privacy Policy
            </a>
          </p>
        </footer>
      </article>
    </div>
  );
};

export default DataDeletion;
