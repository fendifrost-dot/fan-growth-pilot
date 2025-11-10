-- Enable pgcrypto extension for token encryption
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create helper function to encrypt OAuth tokens
CREATE OR REPLACE FUNCTION public.encrypt_token(token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Use AES encryption with the service role key as the encryption key
  RETURN encode(
    pgp_sym_encrypt(
      token,
      current_setting('app.encryption_key'),
      'cipher-algo=aes256'
    ),
    'base64'
  );
END;
$$;

-- Create helper function to decrypt OAuth tokens
CREATE OR REPLACE FUNCTION public.decrypt_token(encrypted_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF encrypted_token IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Decrypt the token
  RETURN pgp_sym_decrypt(
    decode(encrypted_token, 'base64'),
    current_setting('app.encryption_key'),
    'cipher-algo=aes256'
  );
EXCEPTION
  WHEN OTHERS THEN
    -- If decryption fails, return NULL (may be legacy unencrypted token)
    RETURN NULL;
END;
$$;

-- Set the encryption key from environment (will be set at runtime)
-- This is a placeholder - the actual key will be set via ALTER DATABASE SET
COMMENT ON FUNCTION public.encrypt_token IS 'Encrypts sensitive OAuth tokens using AES-256';
COMMENT ON FUNCTION public.decrypt_token IS 'Decrypts OAuth tokens encrypted with encrypt_token function';