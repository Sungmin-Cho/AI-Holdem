# Hand-history fixtures

The 10 numbered `*.txt` cases (01–10) and their records in `hands.js` are authored
format-regression fixtures. They are not captured from a commercial service.

`11-showdown-open-split.txt` is the open-policy counterpart of 09: the same
hand, except p2 shows instead of mucking.

The JSON files under `generated/` are reproducible engine outputs created
by `node test/helpers/gen-hh-fixtures.js`. Tests require the generated uncalled,
split-pot, side-pot, and open-split records to converge on the corresponding
authored text.
