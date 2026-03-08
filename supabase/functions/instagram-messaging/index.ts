import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const accessToken = Deno.env.get('INSTAGRAM_MESSAGING_API_TOKEN');
  if (!accessToken) {
    console.error('INSTAGRAM_MESSAGING_API_TOKEN not configured');
    return new Response(JSON.stringify({ error: 'Server configuration error: missing Instagram token' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'status';

    // GET: Check token validity and account info
    if (req.method === 'GET') {
      if (action === 'status') {
        return await checkTokenStatus(accessToken);
      }

      if (action === 'conversations') {
        return await getConversations(accessToken);
      }

      if (action === 'messages') {
        const conversationId = url.searchParams.get('conversation_id');
        if (!conversationId) {
          return jsonResponse({ error: 'conversation_id is required' }, 400);
        }
        return await getMessages(accessToken, conversationId);
      }

      return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }

    // POST: Send a message
    if (req.method === 'POST') {
      const body = await req.json();
      const { recipient_id, message } = body;

      if (!recipient_id || !message) {
        return jsonResponse({ error: 'recipient_id and message are required' }, 400);
      }

      return await sendMessage(accessToken, recipient_id, message);
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Instagram messaging exception:', error);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
});

// Check token validity and get connected Instagram account info
async function checkTokenStatus(accessToken: string) {
  // Validate token
  const debugRes = await fetch(
    `${GRAPH_BASE}/debug_token?input_token=${accessToken}&access_token=${accessToken}`
  );
  const debugData = await debugRes.json();

  if (debugData.error) {
    return jsonResponse({
      status: 'error',
      message: 'Token is invalid or expired',
      details: debugData.error,
    }, 401);
  }

  // Get Instagram business account info
  const meRes = await fetch(
    `${GRAPH_BASE}/me?fields=id,name&access_token=${accessToken}`
  );
  const meData = await meRes.json();

  // Get Instagram accounts linked to this page
  const accountsRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,name,instagram_business_account{id,name,username,profile_picture_url,followers_count}&access_token=${accessToken}`
  );
  const accountsData = await accountsRes.json();

  const igAccounts = (accountsData.data || [])
    .filter((page: any) => page.instagram_business_account)
    .map((page: any) => ({
      page_id: page.id,
      page_name: page.name,
      ig_id: page.instagram_business_account.id,
      ig_username: page.instagram_business_account.username,
      ig_name: page.instagram_business_account.name,
      ig_profile_pic: page.instagram_business_account.profile_picture_url,
      ig_followers: page.instagram_business_account.followers_count,
    }));

  const tokenInfo = debugData.data || {};

  return jsonResponse({
    status: 'active',
    token_valid: true,
    token_expires_at: tokenInfo.expires_at
      ? new Date(tokenInfo.expires_at * 1000).toISOString()
      : 'never (long-lived)',
    scopes: tokenInfo.scopes || [],
    user: meData,
    instagram_accounts: igAccounts,
  });
}

// Get conversations (DM threads)
async function getConversations(accessToken: string) {
  // First get the page ID
  const accountsRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,instagram_business_account&access_token=${accessToken}`
  );
  const accountsData = await accountsRes.json();

  const page = (accountsData.data || []).find((p: any) => p.instagram_business_account);
  if (!page) {
    return jsonResponse({ error: 'No Instagram business account found' }, 404);
  }

  // Get conversations using the page token
  const pageTokenRes = await fetch(
    `${GRAPH_BASE}/${page.id}?fields=access_token&access_token=${accessToken}`
  );
  const pageTokenData = await pageTokenRes.json();
  const pageToken = pageTokenData.access_token;

  const convRes = await fetch(
    `${GRAPH_BASE}/${page.instagram_business_account.id}/conversations?fields=id,participants,updated_time,messages.limit(1){message,from,created_time}&platform=instagram&access_token=${pageToken}`
  );
  const convData = await convRes.json();

  return jsonResponse({
    conversations: convData.data || [],
    paging: convData.paging || null,
  });
}

// Get messages in a conversation
async function getMessages(accessToken: string, conversationId: string) {
  const accountsRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,instagram_business_account&access_token=${accessToken}`
  );
  const accountsData = await accountsRes.json();

  const page = (accountsData.data || []).find((p: any) => p.instagram_business_account);
  if (!page) {
    return jsonResponse({ error: 'No Instagram business account found' }, 404);
  }

  const pageTokenRes = await fetch(
    `${GRAPH_BASE}/${page.id}?fields=access_token&access_token=${accessToken}`
  );
  const pageTokenData = await pageTokenRes.json();
  const pageToken = pageTokenData.access_token;

  const msgsRes = await fetch(
    `${GRAPH_BASE}/${conversationId}/messages?fields=id,message,from,created_time,attachments&access_token=${pageToken}`
  );
  const msgsData = await msgsRes.json();

  return jsonResponse({
    messages: msgsData.data || [],
    paging: msgsData.paging || null,
  });
}

// Send a message to a user via Instagram
async function sendMessage(accessToken: string, recipientId: string, message: string) {
  const accountsRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,instagram_business_account&access_token=${accessToken}`
  );
  const accountsData = await accountsRes.json();

  const page = (accountsData.data || []).find((p: any) => p.instagram_business_account);
  if (!page) {
    return jsonResponse({ error: 'No Instagram business account found' }, 404);
  }

  const pageTokenRes = await fetch(
    `${GRAPH_BASE}/${page.id}?fields=access_token&access_token=${accessToken}`
  );
  const pageTokenData = await pageTokenRes.json();
  const pageToken = pageTokenData.access_token;

  const sendRes = await fetch(
    `${GRAPH_BASE}/${page.instagram_business_account.id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        access_token: pageToken,
      }),
    }
  );

  const sendData = await sendRes.json();

  if (!sendRes.ok) {
    console.error('Instagram send error:', JSON.stringify(sendData));
    return jsonResponse({ error: 'Failed to send message', details: sendData }, sendRes.status);
  }

  console.log('Instagram message sent:', JSON.stringify(sendData));
  return jsonResponse({ success: true, ...sendData });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
