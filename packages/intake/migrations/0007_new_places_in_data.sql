-- in_data_at on a new place: when the apply run told the intake (POST /v1/places/recent/remove) that it is done
-- with the place, because the data now holds it or its adder withdrew it. Set the first time only, from the intake's
-- clock. The recent list keeps the place, with its current standing, for 7 days from then, so a hide or withdraw
-- that comes after still reaches apps whose release has the place. The scheduled job then deletes it and its evidence.
-- NULL until then.

ALTER TABLE new_places ADD COLUMN in_data_at TEXT;

CREATE INDEX new_places_in_data ON new_places (in_data_at);
