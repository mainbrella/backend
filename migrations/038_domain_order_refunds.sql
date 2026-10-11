-- Upgrade databases that already applied the original registrar migration.
ALTER TABLE domain_orders ADD COLUMN refund_id TEXT;

DROP INDEX domain_order_pending;
CREATE UNIQUE INDEX domain_order_pending ON domain_orders(domain_name)
  WHERE status IN ('checkout','charging','paid','fulfilling','registered','connecting','refunding','review');
