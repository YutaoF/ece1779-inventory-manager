CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL CHECK (email ~ '[^[:space:]]'),
    password_hash text NOT NULL CHECK (password_hash ~ '[^[:space:]]'),
    role text NOT NULL CHECK (role IN ('manager', 'staff')),
    disabled_at timestamptz
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE products (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku text COLLATE "C" NOT NULL UNIQUE CHECK (sku ~ '^[A-Za-z0-9]+$'),
    name text NOT NULL CHECK (name ~ '[^[:space:]]'),
    category text NOT NULL,
    description text,
    archived_at timestamptz
);

CREATE TABLE locations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (name ~ '[^[:space:]]')
);

CREATE TABLE inventory_balances (
    product_id bigint NOT NULL REFERENCES products (id),
    location_id bigint NOT NULL REFERENCES locations (id),
    quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reorder_threshold integer CHECK (reorder_threshold >= 0),
    PRIMARY KEY (product_id, location_id)
);

CREATE INDEX inventory_balances_location_idx ON inventory_balances (location_id, product_id);

CREATE TABLE stock_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id bigint NOT NULL REFERENCES products (id),
    location_id bigint NOT NULL REFERENCES locations (id),
    actor_id bigint NOT NULL REFERENCES users (id),
    operation text NOT NULL CHECK (operation IN ('receive', 'issue', 'transfer', 'correction')),
    quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
    reason text,
    transfer_id uuid,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT stock_movements_direction_check CHECK (
        (operation <> 'receive' OR quantity_delta > 0)
        AND (operation <> 'issue' OR quantity_delta < 0)
    ),
    CONSTRAINT stock_movements_correction_reason_check CHECK (
        operation <> 'correction' OR (reason IS NOT NULL AND reason ~ '[^[:space:]]')
    ),
    CONSTRAINT stock_movements_transfer_id_check CHECK (
        (operation = 'transfer') = (transfer_id IS NOT NULL)
    )
);

CREATE INDEX stock_movements_product_location_time_idx
    ON stock_movements (product_id, location_id, created_at DESC, id DESC);

CREATE INDEX stock_movements_transfer_idx
    ON stock_movements (transfer_id) WHERE transfer_id IS NOT NULL;

CREATE FUNCTION reject_stock_movement_changes() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'stock_movements is append-only';
END;
$$;

CREATE TRIGGER stock_movements_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movements
FOR EACH STATEMENT EXECUTE FUNCTION reject_stock_movement_changes();
