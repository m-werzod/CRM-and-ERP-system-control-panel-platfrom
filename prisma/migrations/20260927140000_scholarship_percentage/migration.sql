-- ---------------------------------------------------------------------------
-- A scholarship may be expressed as a percentage.
--
-- The original `discounts_value_matches_type` constraint grouped SCHOLARSHIP with
-- FIXED and therefore required `amountMinor`. That was a modelling error: "a 50%
-- scholarship" is the ordinary way an institution describes one, and the seed
-- immediately hit the constraint trying to create exactly that.
--
-- The rule that actually matters is unchanged and still enforced: a discount
-- carries EXACTLY ONE value, never both and never neither, so no code path has to
-- guess which field to read. What changes is that SCHOLARSHIP may use either.
-- ---------------------------------------------------------------------------

ALTER TABLE "discounts" DROP CONSTRAINT "discounts_value_matches_type";

ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_value_matches_type" CHECK (
    -- Exactly one value field is populated, whatever the type.
    (("amountMinor" IS NOT NULL)::int + ("percentPpm" IS NOT NULL)::int) = 1

    -- A percentage is a real fraction of something.
    AND ("percentPpm" IS NULL OR ("percentPpm" > 0 AND "percentPpm" <= 1000000))

    -- A fixed amount is positive, and carries the currency it is denominated in:
    -- "5000 off" is meaningless without knowing 5000 of what.
    AND ("amountMinor" IS NULL OR ("amountMinor" > 0 AND "currency" IS NOT NULL))

    -- PERCENT is percentage-only and FIXED is amount-only; SCHOLARSHIP may be
    -- either, which is the whole point of this migration.
    AND ("type" <> 'PERCENT' OR "percentPpm" IS NOT NULL)
    AND ("type" <> 'FIXED' OR "amountMinor" IS NOT NULL)
  );

COMMENT ON CONSTRAINT "discounts_value_matches_type" ON "discounts" IS
  'A discount carries exactly one value: percentPpm or amountMinor. PERCENT must be a percentage, FIXED must be an amount, SCHOLARSHIP may be either.';
