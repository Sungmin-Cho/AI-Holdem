# Hand-history fixtures

The 10 numbered `*.txt` cases and their records in `hands.js` are authored
format-regression fixtures. They are not captured from a commercial service.

The three JSON files under `generated/` are reproducible engine outputs created
by `node test/helpers/gen-hh-fixtures.js`. Tests require the generated uncalled,
split-pot, and side-pot records to converge on the corresponding authored text.
