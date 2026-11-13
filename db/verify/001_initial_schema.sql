\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path TO public, pg_temp;

DO $$
DECLARE
    fixture_suffix text := md5(random()::text || clock_timestamp()::text);
    fixture_sku text := 'VERIFY' || upper(fixture_suffix);
    fixture_actor_id bigint;
    fixture_product_id bigint;
    missing_product_id bigint;
    source_location_id bigint;
    destination_location_id bigint;
    fixture_transfer_id uuid := fixture_suffix::uuid;
    receipt_id bigint;
BEGIN
    INSERT INTO users (email, password_hash, role)
    VALUES ('schema-' || fixture_suffix || '@example.invalid', 'test-hash', 'manager')
    RETURNING id INTO fixture_actor_id;

    INSERT INTO products (sku, name, category)
    VALUES (fixture_sku, 'Verification product', 'Verification')
    RETURNING id INTO fixture_product_id;

    INSERT INTO products (sku, name, category)
    VALUES (fixture_sku || 'MISSING', 'Temporary product', 'Verification')
    RETURNING id INTO missing_product_id;
    DELETE FROM products WHERE id = missing_product_id;

    INSERT INTO locations (name)
    VALUES ('Verification source ' || fixture_suffix)
    RETURNING id INTO source_location_id;

    INSERT INTO locations (name)
    VALUES ('Verification destination ' || fixture_suffix)
    RETURNING id INTO destination_location_id;

    INSERT INTO inventory_balances (product_id, location_id, quantity, reorder_threshold)
    VALUES (fixture_product_id, source_location_id, 6, 2),
           (fixture_product_id, destination_location_id, 3, NULL);

    INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta)
    VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'receive', 10)
    RETURNING id INTO receipt_id;

    INSERT INTO stock_movements
        (product_id, location_id, actor_id, operation, quantity_delta, transfer_id)
    VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'transfer', -3, fixture_transfer_id),
           (fixture_product_id, destination_location_id, fixture_actor_id, 'transfer', 3, fixture_transfer_id);

    INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta, reason)
    VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'issue', -2, NULL),
           (fixture_product_id, source_location_id, fixture_actor_id, 'correction', 1, 'Shelf recount');

    BEGIN
        INSERT INTO products (sku, name, category)
        VALUES (fixture_sku, 'Duplicate product', 'Verification');
        RAISE EXCEPTION 'Duplicate SKU was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO inventory_balances (product_id, location_id)
        VALUES (fixture_product_id, source_location_id);
        RAISE EXCEPTION 'Duplicate product and location balance was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    BEGIN
        UPDATE inventory_balances SET quantity = -1
        WHERE product_id = fixture_product_id AND location_id = source_location_id;
        RAISE EXCEPTION 'Negative quantity was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE inventory_balances SET reorder_threshold = -1
        WHERE product_id = fixture_product_id AND location_id = source_location_id;
        RAISE EXCEPTION 'Negative reorder threshold was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO inventory_balances (product_id, location_id)
        VALUES (missing_product_id, source_location_id);
        RAISE EXCEPTION 'Balance for an unknown product was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta)
        VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'receive', -1);
        RAISE EXCEPTION 'Negative receipt was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta, reason)
        VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'correction', 1, NULL);
        RAISE EXCEPTION 'Correction without a reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta, reason)
        VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'correction', 1, '   ');
        RAISE EXCEPTION 'Correction with a blank reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (product_id, location_id, actor_id, operation, quantity_delta)
        VALUES (fixture_product_id, source_location_id, fixture_actor_id, 'transfer', -1);
        RAISE EXCEPTION 'Transfer without a transfer ID was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE stock_movements SET reason = 'Edited' WHERE id = receipt_id;
        RAISE EXCEPTION 'Movement update was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;

    BEGIN
        DELETE FROM stock_movements WHERE id = receipt_id;
        RAISE EXCEPTION 'Movement delete was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;

    BEGIN
        TRUNCATE stock_movements;
        RAISE EXCEPTION 'Movement truncate was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
END;
$$;

ROLLBACK;

\echo Initial schema checks passed. Fixture rows were rolled back.
