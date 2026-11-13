-- origin on a new place: the adder's hashed client network, when the intake knew it. The recent list leaves
-- out still-there checks from that network when it works out whether the place is confirmed, as it leaves out
-- the adder's own device. It is never listed. NULL for places added before this column and for adders whose
-- network was not known.

ALTER TABLE new_places ADD COLUMN origin TEXT;
