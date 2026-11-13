\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path TO public, pg_temp;

DO $$
DECLARE
    fixture_suffix text := md5(random()::text || clock_timestamp()::text);
    fixture_request_key text := 'transfer-' || fixture_suffix;
    manager_id bigint;
    staff_id bigint;
    fixture_category_id bigint;
    missing_category_id bigint;
    fixture_product_id bigint;
    source_location_id bigint;
    destination_location_id bigint;
    transfer_operation_id bigint;
    receipt_operation_id bigint;
    movement_id bigint;
    old_inventory_timestamp timestamptz := '2000-01-01 00:00:00+00';
    new_inventory_timestamp timestamptz;
BEGIN
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Verification manager', 'manager-' || fixture_suffix || '@example.invalid', 'test-hash', 'manager')
    RETURNING id INTO manager_id;

    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Verification staff', 'staff-' || fixture_suffix || '@example.invalid', 'test-hash', 'staff')
    RETURNING id INTO staff_id;

    INSERT INTO sessions (sid, sess, expire)
    VALUES (fixture_suffix, json_build_object('userId', manager_id), LOCALTIMESTAMP + interval '1 hour');

    INSERT INTO categories (name) VALUES ('Verification ' || fixture_suffix)
    RETURNING id INTO fixture_category_id;

    BEGIN
        INSERT INTO categories (name) VALUES ('Verification ' || fixture_suffix);
        RAISE EXCEPTION 'Duplicate category was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    INSERT INTO categories (name) VALUES ('Temporary ' || fixture_suffix)
    RETURNING id INTO missing_category_id;
    DELETE FROM categories WHERE id = missing_category_id;

    INSERT INTO products (sku, name, category_id)
    VALUES ('VERIFY' || upper(fixture_suffix), 'Verification product', fixture_category_id)
    RETURNING id INTO fixture_product_id;

    BEGIN
        INSERT INTO products (sku, name, category_id)
        VALUES ('UNKNOWN' || upper(fixture_suffix), 'Unknown category', missing_category_id);
        RAISE EXCEPTION 'Product with an unknown category was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    INSERT INTO locations (name, description)
    VALUES ('Verification source ' || fixture_suffix, 'Source fixture')
    RETURNING id INTO source_location_id;

    INSERT INTO locations (name) VALUES ('Verification destination ' || fixture_suffix)
    RETURNING id INTO destination_location_id;

    INSERT INTO inventory (product_id, location_id, quantity, reorder_threshold, updated_at)
    VALUES (fixture_product_id, source_location_id, 10, 2, old_inventory_timestamp),
           (fixture_product_id, destination_location_id, 0, NULL, old_inventory_timestamp);

    INSERT INTO stock_operations (actor_id, operation, client_request_key, request_details)
    VALUES (manager_id, 'transfer', fixture_request_key, '{"quantity": 3}')
    RETURNING id INTO transfer_operation_id;

    UPDATE inventory SET quantity = 7
    WHERE product_id = fixture_product_id AND location_id = source_location_id
    RETURNING updated_at INTO new_inventory_timestamp;

    IF new_inventory_timestamp IS NULL OR new_inventory_timestamp <= old_inventory_timestamp THEN
        RAISE EXCEPTION 'Inventory updated_at did not advance';
    END IF;

    UPDATE inventory SET quantity = 3
    WHERE product_id = fixture_product_id AND location_id = destination_location_id;

    INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta, quantity_after)
    VALUES (transfer_operation_id, fixture_product_id, source_location_id, -3, 7)
    RETURNING id INTO movement_id;

    INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta, quantity_after)
    VALUES (transfer_operation_id, fixture_product_id, destination_location_id, 3, 3);

    UPDATE stock_operations SET saved_result = '{"sourceQuantity": 7, "destinationQuantity": 3}'
    WHERE id = transfer_operation_id;

    BEGIN
        INSERT INTO stock_operations (actor_id, operation, client_request_key)
        VALUES (manager_id, 'transfer', fixture_request_key);
        RAISE EXCEPTION 'Duplicate request key for one actor was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    INSERT INTO stock_operations (actor_id, operation, client_request_key)
    VALUES (staff_id, 'receive', fixture_request_key)
    RETURNING id INTO receipt_operation_id;

    BEGIN
        INSERT INTO stock_operations (actor_id, operation, reason)
        VALUES (manager_id, 'correction', '   ');
        RAISE EXCEPTION 'Correction with a blank reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta, quantity_after)
        VALUES (receipt_operation_id, fixture_product_id, source_location_id, 1, -1);
        RAISE EXCEPTION 'Movement with a negative resulting quantity was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta)
        VALUES (receipt_operation_id, fixture_product_id, source_location_id, 1);
        RAISE EXCEPTION 'New movement without a resulting quantity was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta, quantity_after)
        VALUES (receipt_operation_id, fixture_product_id, source_location_id, -1, 6);
        RAISE EXCEPTION 'Negative receipt was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE stock_movements SET quantity_after = 8 WHERE id = movement_id;
        RAISE EXCEPTION 'Movement update was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;

    BEGIN
        UPDATE stock_operations SET reason = 'Edited' WHERE id = transfer_operation_id;
        RAISE EXCEPTION 'Stock operation history update was accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
END;
$$;

ROLLBACK;

\echo Complete schema checks passed. Fixture rows were rolled back.
