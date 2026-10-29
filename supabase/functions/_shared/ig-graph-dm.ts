/**
 * Instagram Graph send used by the curator auto-dispatcher.
 *
 * Meta's Messaging API delivers a DM only to a recipient IGSID (someone who
 * already opened a thread with this account) or as a private reply to a
 * comment. It has no "send this text to @handle" call. A curator row that
 * only stores a username cannot be delivered here.
 */
export type GraphDmArgs = {
  handle: string;
  body: string;
  recipientId: string | null;
  handoffRecordId: string;
};

export type GraphDmResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: string; error: string };

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export function graphDmPrepare(
  args: GraphDmArgs,
  token: string | null | undefined,
): { ok: true } | { ok: false; code: string; error: string } {
  if (!args.recipientId) {
    return {
      ok: false,
      code: "meta_cold_dm_unsupported",
      error:
        "Instagram Graph cannot open a DM from a username. This row has no recipient IGSID, so nothing was sent and nobody is asked to approve it.",
    };
  }
  if (!token) {
    return {
      ok: false,
      code: "meta_token_missing",
      error: "INSTAGRAM_MESSAGING_API_TOKEN is not set, so the DM was not sent.",
    };
  }
  if (!args.body.trim()) {
    return { ok: false, code: "empty_body", error: "DM body is empty." };
  }
  return { ok: true };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST /{ig-user-id}/messages. Caller must have already passed graphDmPrepare.
 * `fetchImpl` is for tests. Production uses global fetch.
 */
export async function graphInstagramDmSend(
  args: GraphDmArgs & { recipientId: string },
  opts: { token: string; fetchImpl?: FetchLike } ,
): Promise<GraphDmResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const accountsRes = await fetchImpl(
    `${GRAPH_BASE}/me/accounts?fields=id,instagram_business_account&access_token=${encodeURIComponent(opts.token)}`,
  );
  const accountsData = await accountsRes.json();
  const page = ((accountsData as { data?: Array<Record<string, unknown>> }).data ?? [])
    .find((row) => row.instagram_business_account);
  const igAccount = page?.instagram_business_account as { id?: string } | undefined;
  if (!page || !igAccount?.id) {
    return { ok: false, code: "meta_account_missing", error: "No Instagram business account is connected to this token." };
  }
  const pageTokenRes = await fetchImpl(
    `${GRAPH_BASE}/${page.id}?fields=access_token&access_token=${encodeURIComponent(opts.token)}`,
  );
  const pageTokenData = await pageTokenRes.json() as { access_token?: string };
  if (!pageTokenData.access_token) {
    return { ok: false, code: "meta_page_token_missing", error: "Could not read the Page token for Instagram messaging." };
  }
  const sendRes = await fetchImpl(`${GRAPH_BASE}/${igAccount.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: args.recipientId },
      message: { text: args.body },
      access_token: pageTokenData.access_token,
    }),
  });
  const sendData = await sendRes.json() as { message_id?: string; error?: { message?: string } };
  if (!sendRes.ok) {
    return {
      ok: false,
      code: "graph_rejected",
      error: sendData.error?.message || `Instagram send failed (${sendRes.status})`,
    };
  }
  const providerMessageId = String(sendData.message_id ?? "").trim();
  if (!providerMessageId) {
    return { ok: false, code: "graph_no_message_id", error: "Instagram accepted the call but returned no message id." };
  }
  return { ok: true, providerMessageId };
}
