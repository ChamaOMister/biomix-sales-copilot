-- Read-only access for the MCP server (decision 001, section 2.3). Applied idempotently, in one
-- transaction, by `npm run db:reader` over the admin connection. The boundary is Postgres
-- privileges: the reader role can SELECT the views in schema `copilot` and nothing else.
-- `default_transaction_read_only` is defence in depth only; a session can switch it off.
-- The password is generated locally (`npm run setup:env`) and set by the script, never here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'copilot_reader') THEN
    CREATE ROLE copilot_reader LOGIN;
  END IF;
END
$$;

-- Re-asserted on every run, so a role changed by hand is put back.
ALTER ROLE copilot_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 4;
ALTER ROLE copilot_reader SET default_transaction_read_only = on;
ALTER ROLE copilot_reader SET statement_timeout = '5s';
ALTER ROLE copilot_reader SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE copilot_reader SET search_path = copilot;

-- The database's default CONNECT and TEMPORARY for PUBLIC are removed; only the reader (and the
-- admin, as owner) may connect.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM copilot_reader', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO copilot_reader', current_database());
END
$$;

-- Project 1's tables stay with their owner. Any privilege granted to the reader by hand is removed.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM copilot_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM copilot_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM copilot_reader;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'copilot_admin') THEN
    REVOKE ALL ON SCHEMA copilot_admin FROM PUBLIC, copilot_reader;
    REVOKE ALL ON ALL TABLES IN SCHEMA copilot_admin FROM PUBLIC, copilot_reader;
  END IF;
END
$$;

-- Rebuilt from scratch on every run. Views run with their owner's privileges, so the reader needs
-- no grant on Project 1's tables. Each view exposes only the columns the tools need.
DROP SCHEMA IF EXISTS copilot CASCADE;
CREATE SCHEMA copilot;

CREATE VIEW copilot.invoices AS
  SELECT invoice_number, billing_date, customer_id, seller_id, business_unit, payment_schedule, last_delivery_id
  FROM public.invoices;

CREATE VIEW copilot.invoice_lines AS
  SELECT invoice_number, line_number, product_id, package_quantity, unit_price_cents, line_amount_cents,
         commission_amount_cents
  FROM public.invoice_lines;

-- Contractual installments: what each payment schedule says falls due, not payments.
CREATE VIEW copilot.scheduled_installments AS
  SELECT invoice_number, installment_number, due_date, amount_cents
  FROM public.scheduled_installments;

CREATE VIEW copilot.customers AS
  SELECT customer_id, name, segment, city, state, seller_id
  FROM public.customers;

CREATE VIEW copilot.products AS
  SELECT product_id, name, category, business_unit
  FROM public.products;

CREATE VIEW copilot.sellers AS
  SELECT seller_id, name, business_unit, territory
  FROM public.sellers;

-- Applied deliveries: counts and billing range only. No errors, payload hashes or receipt times.
CREATE VIEW copilot.deliveries AS
  SELECT delivery_id, invoice_count, invoices_added, invoices_replaced, line_count, first_billing_date,
         last_billing_date
  FROM public.feed_deliveries
  WHERE status = 'applied';

-- Provenance of the loaded dataset (written by data:load into the admin-only copilot_admin schema).
CREATE VIEW copilot.dataset_info AS
  SELECT repository, tag, source_commit, seed, as_of_date, coverage_start_date
  FROM copilot_admin.dataset_provenance;

REVOKE ALL ON SCHEMA copilot FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA copilot FROM PUBLIC;
GRANT USAGE ON SCHEMA copilot TO copilot_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA copilot TO copilot_reader;
