-- Phase 8: Generic specialist findings data per encounter
-- JSONB field stores structured specialist-specific data (tooth chart, body map, etc.)
ALTER TABLE encounters ADD COLUMN IF NOT EXISTS specialist_data jsonb;

COMMENT ON COLUMN encounters.specialist_data IS 'Structured findings for specialist encounters (dental chart, dermatology body map, ophthalmology diagram, etc.). Each specialist type defines its own schema within this JSONB field.';