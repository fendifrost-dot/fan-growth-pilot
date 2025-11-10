import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

interface ShopifyOrder {
  id: number;
  email: string;
  total_price: string;
  created_at: string;
  customer: {
    email: string;
  };
}

const handler = async (req: Request): Promise<Response> => {
  // Webhooks don't need CORS - they're server-to-server
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200 });
  }

  try {
    // Verify Shopify webhook signature (HMAC-SHA256)
    const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
    if (!hmacHeader) {
      console.error('Missing HMAC signature header');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read raw body for signature verification
    const rawBody = await req.text();
    const webhookSecret = Deno.env.get('SHOPIFY_WEBHOOK_SECRET');
    
    if (!webhookSecret) {
      console.error('SHOPIFY_WEBHOOK_SECRET not configured');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Compute expected HMAC
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookSecret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(rawBody)
    );
    
    const expectedHmac = btoa(String.fromCharCode(...new Uint8Array(signature)));
    
    // Compare signatures
    if (hmacHeader !== expectedHmac) {
      console.error('Invalid webhook signature - potential unauthorized access attempt');
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('Webhook signature verified successfully');
    
    // Parse the verified webhook data
    const order: ShopifyOrder = JSON.parse(rawBody);
    
    console.log('Received Shopify order webhook:', { 
      orderId: order.id, 
      email: order.email || order.customer?.email,
      totalPrice: order.total_price 
    });

    // Get customer email (can be at root or in customer object)
    const customerEmail = order.email || order.customer?.email;
    
    if (!customerEmail) {
      console.log('No email found in order');
      return new Response(JSON.stringify({ success: false, error: 'No email in order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Initialize Supabase client with service role key for admin access
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find all leads with this email
    const { data: leads, error: fetchError } = await supabase
      .from('smart_link_leads')
      .select('id, email, converted')
      .eq('email', customerEmail.toLowerCase())
      .eq('converted', false);

    if (fetchError) {
      console.error('Error fetching leads:', fetchError);
      throw fetchError;
    }

    if (!leads || leads.length === 0) {
      console.log(`No unconverted leads found for email: ${customerEmail}`);
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No unconverted leads found for this email' 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update all unconverted leads with this email
    const { data: updated, error: updateError } = await supabase
      .from('smart_link_leads')
      .update({
        converted: true,
        converted_at: new Date().toISOString(),
        conversion_value: parseFloat(order.total_price),
        shopify_order_id: order.id.toString(),
      })
      .eq('email', customerEmail.toLowerCase())
      .eq('converted', false)
      .select();

    if (updateError) {
      console.error('Error updating leads:', updateError);
      throw updateError;
    }

    console.log(`Successfully updated ${updated?.length || 0} leads for conversion`);

    return new Response(JSON.stringify({ 
      success: true, 
      leadsUpdated: updated?.length || 0,
      orderId: order.id,
      email: customerEmail 
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error processing webhook:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

serve(handler);
