ALTER TABLE users ADD COLUMN name text;
UPDATE users SET name = email;
ALTER TABLE users
    ALTER COLUMN name SET NOT NULL,
    ADD CHECK (name ~ '[^[:space:]]');

-- Column names and types match the connect-pg-simple store.
CREATE TABLE sessions (
    sid varchar COLLATE "C" PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
);

CREATE INDEX sessions_expire_idx ON sessions (expire);

CREATE TABLE categories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE
);

INSERT INTO categories (name)
SELECT DISTINCT category FROM products;

ALTER TABLE products ADD COLUMN category_id bigint;

UPDATE products
SET category_id = categories.id
FROM categories
WHERE categories.name = products.category;

ALTER TABLE products
    ALTER COLUMN category_id SET NOT NULL,
    ADD FOREIGN KEY (category_id) REFERENCES categories (id),
    DROP COLUMN category;

CREATE INDEX products_category_idx ON products (category_id);

ALTER TABLE locations
    ADD COLUMN description text,
    ADD COLUMN archived_at timestamptz;

ALTER TABLE inventory_balances RENAME TO inventory;
ALTER TABLE inventory ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp();

CREATE FUNCTION touch_inventory_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_set_updated_at
BEFORE UPDATE ON inventory
FOR EACH ROW EXECUTE FUNCTION touch_inventory_updated_at();

CREATE TABLE stock_operations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id bigint NOT NULL REFERENCES users (id),
    operation text NOT NULL CHECK (operation IN ('receive', 'issue', 'transfer', 'correction')),
    reason text,
    client_request_key text CHECK (client_request_key ~ '[^[:space:]]'),
    request_details jsonb,
    saved_result jsonb,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    legacy_transfer_id uuid,
    UNIQUE (actor_id, client_request_key),
    CHECK (operation <> 'correction' OR (reason IS NOT NULL AND reason ~ '[^[:space:]]'))
);

ALTER TABLE stock_movements
    ADD COLUMN operation_id bigint,
    ADD COLUMN quantity_after integer;

ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only;

WITH grouped_movements AS MATERIALIZED (
    SELECT id, actor_id, operation, reason, created_at, transfer_id, CASE
        WHEN transfer_id IS NULL THEN id
        ELSE min(id) OVER (PARTITION BY transfer_id, actor_id, reason)
    END AS first_movement_id
    FROM stock_movements
),
operation_mapping AS MATERIALIZED (
    SELECT first_movement_id,
           nextval(pg_get_serial_sequence('stock_operations', 'id')) AS operation_id
    FROM grouped_movements
    WHERE id = first_movement_id
),
inserted_operations AS (
    INSERT INTO stock_operations (actor_id, operation, reason, created_at, legacy_transfer_id, id)
    OVERRIDING SYSTEM VALUE
    SELECT actor_id, operation, reason, created_at, transfer_id,
           operation_id
    FROM grouped_movements
    JOIN operation_mapping USING (first_movement_id)
    WHERE id = first_movement_id
    RETURNING id
)
UPDATE stock_movements
SET operation_id = operation_mapping.operation_id
FROM grouped_movements
JOIN operation_mapping USING (first_movement_id)
JOIN inserted_operations ON inserted_operations.id = operation_mapping.operation_id
WHERE stock_movements.id = grouped_movements.id;

ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only;

ALTER TABLE stock_movements
    ALTER COLUMN operation_id SET NOT NULL,
    ADD FOREIGN KEY (operation_id) REFERENCES stock_operations (id),
    ADD CONSTRAINT stock_movements_quantity_after_check
        CHECK (quantity_after IS NOT NULL AND quantity_after >= 0) NOT VALID,
    DROP COLUMN actor_id,
    DROP COLUMN operation,
    DROP COLUMN reason,
    DROP COLUMN transfer_id;

CREATE INDEX stock_movements_operation_idx ON stock_movements (operation_id);

CREATE FUNCTION check_stock_movement_direction() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    operation_type text;
BEGIN
    SELECT operation INTO operation_type
    FROM public.stock_operations WHERE id = NEW.operation_id;

    IF (operation_type = 'receive' AND NEW.quantity_delta < 0)
        OR (operation_type = 'issue' AND NEW.quantity_delta > 0) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Stock movement has the wrong direction';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_check_direction
AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION check_stock_movement_direction();

CREATE OR REPLACE FUNCTION reject_stock_movement_changes() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%I is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER stock_operations_retain_history
BEFORE DELETE OR TRUNCATE ON stock_operations
FOR EACH STATEMENT EXECUTE FUNCTION reject_stock_movement_changes();

CREATE FUNCTION protect_stock_operation_metadata() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(NEW.id, NEW.actor_id, NEW.operation, NEW.reason, NEW.client_request_key,
           NEW.request_details, NEW.created_at, NEW.legacy_transfer_id)
        IS DISTINCT FROM
       ROW(OLD.id, OLD.actor_id, OLD.operation, OLD.reason, OLD.client_request_key,
           OLD.request_details, OLD.created_at, OLD.legacy_transfer_id)
        OR (OLD.saved_result IS NOT NULL AND NEW.saved_result IS DISTINCT FROM OLD.saved_result) THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Recorded stock operation fields are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER stock_operations_protect_metadata
BEFORE UPDATE ON stock_operations
FOR EACH ROW EXECUTE FUNCTION protect_stock_operation_metadata();
