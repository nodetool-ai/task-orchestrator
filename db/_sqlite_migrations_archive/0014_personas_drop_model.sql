-- Models are no longer tied to personas; the model is chosen per-run at
-- launch time (the run-agent dialog / chat composers). Drop the persona's
-- model columns. The migration runner tolerates "no such column" so this is
-- safe to re-apply.
ALTER TABLE personas DROP COLUMN model_provider;
ALTER TABLE personas DROP COLUMN model_id;
