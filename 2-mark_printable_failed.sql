-- Marca una compra como fallida (generación de PDF o envío de correo).
-- No pisa un estado 'delivered' ya exitoso — solo aplica si sigue en
-- 'paid' o 'generated', para no ocultar un éxito previo con un error
-- de un reintento posterior.
CREATE OR REPLACE FUNCTION mark_printable_failed(
  p_purchase_id UUID,
  p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE printable_purchases
  SET status = 'failed',
      last_error = p_error_message
  WHERE id = p_purchase_id
    AND status IN ('paid', 'generated');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Compra no encontrada o ya estaba entregada';
  END IF;

  RETURN true;
END;
$$;
