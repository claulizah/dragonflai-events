ALTER TABLE printable_purchases
  ADD COLUMN IF NOT EXISTS last_error TEXT;
