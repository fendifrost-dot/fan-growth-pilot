// Shopify API configuration for modest-streetwear-apparel store
const SHOPIFY_API_VERSION = '2025-07';
const SHOPIFY_STORE_DOMAIN = 'modest-streetwear-apparel.myshopify.com';
const SHOPIFY_STOREFRONT_URL = `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;

// This will use the storefront token from Supabase secrets
// The token is stored in environment variables via edge functions
const SHOPIFY_STOREFRONT_TOKEN = '49a03d56b87838bcf1cc07eabdaaa3ba';

export async function storefrontApiRequest(query: string, variables: any = {}) {
  try {
    const response = await fetch(SHOPIFY_STOREFRONT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (response.status === 402) {
      throw new Error('PAYMENT_REQUIRED');
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`Shopify API error: ${data.errors.map((e: any) => e.message).join(', ')}`);
    }

    return data;
  } catch (error) {
    console.error('Shopify API request failed:', error);
    throw error;
  }
}

export async function checkShopifyConnection(): Promise<boolean> {
  const query = `
    query {
      shop {
        name
      }
    }
  `;

  try {
    const data = await storefrontApiRequest(query);
    return !!data?.data?.shop;
  } catch (error) {
    return false;
  }
}
